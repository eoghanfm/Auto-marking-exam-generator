/***************************************************************
 * 1. STATE & CONFIG
 ***************************************************************/
const CONFIG = {
    openaiModel: "gpt-4o-mini",
    openaiEndpoint: "https://api.openai.com/v1/chat/completions",
    pdfWorkerSrc: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js",
    acceptedFileTypes: ".pdf, application/pdf, .eoghanIsTheBest, .iftiIsTheBestToo",
    storageKeys: {
        apiKey: "__OPENAI_API_KEY__",
        savesIndex: "__SAVED_TESTS_INDEX_V1__",
        testPrefix: "saved_test_v2_"
    }
};

if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.pdfWorkerSrc;
}

/**
 * Application state:
 * - mode: "setup" | "taking" | "marked"
 * - test.questions: { mcq: [{ id, prompt, choices[], answerIndex }], saq: [{ id, prompt, maxScore }] }
 * - test.answers:   { mcqSelectedIndex: (number|null)[], saqText: string[] }
 * - test.marking:   { status, totals, mcq[], saq[], modelInfo } | null
 */
const state = {
    mode: "setup",
    config: {
        mcqCount: 0,
        choicesPerQuestion: 2,
        saqCount: 0,
        saqMaxScore: 4
    },
    pdf: {
        name: null,
        extractedText: ""
    },
    test: {
        questions: { mcq: [], saq: [] },
        answers: { mcqSelectedIndex: [], saqText: [] },
        marking: null
    }
};

let jsConfettiInstance = null;

const dom = {
    openSidebarBtn: document.getElementById("open-sidebar-btn"),
    openSettingsBtn: document.getElementById("open-settings-btn"),
    closeSidebarBtn: document.getElementById("close-sidebar-btn"),
    closeSettingsBtn: document.getElementById("close-settings-btn"),
    sidebarOverlay: document.getElementById("sidebar-overlay"),
    popupOverlay: document.getElementById("popup-overlay"),
    sidebar: document.getElementById("sidebar"),
    sidebarContent: document.getElementById("sidebar-content"),
    settingsSidebar: document.getElementById("settings-sidebar"),
    apiKeyInput: document.getElementById("api-key-input"),
    saveApiKeyBtn: document.getElementById("save-api-key-btn"),
    apiKeyStatus: document.getElementById("api-key-status"),
    savePopup: document.getElementById("save-popup"),
    closePopupBtn: document.getElementById("close-popup-btn"),
    nameInput: document.getElementById("name-input"),
    submitNameBtn: document.getElementById("submit-name-btn"),
    uploadFileBtn: document.getElementById("upload-file-btn"),
    fileUploadedMessage: document.getElementById("file-uploaded-message"),
    mcqCounter: document.getElementById("multiple-choice-counter"),
    choicesCounter: document.getElementById("choices-per-question-counter"),
    saqCounter: document.getElementById("short-answer-counter"),
    errorMessage: document.getElementById("error-message"),
    questionsForm: document.getElementById("questions-form"),
    questionsContainer: document.getElementById("questions-container"),
    mainButton: document.getElementById("main-button")
};

/***************************************************************
 * 2. PDF EXTRACTION
 ***************************************************************/
async function extractTextFromPDF(file) {
    if (typeof pdfjsLib === "undefined") {
        throw new Error("PDF.js failed to load. Please check your internet connection and refresh.");
    }

    const arrayBuffer = await file.arrayBuffer();
    const typedArray = new Uint8Array(arrayBuffer);
    const pdf = await pdfjsLib.getDocument({ data: typedArray }).promise;

    let extracted = "";
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(" ");
        extracted += `${pageText}\n`;
    }

    return extracted.trim();
}

function handleFileUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = CONFIG.acceptedFileTypes;

    input.onchange = async () => {
        const file = input.files[0];
        if (!file) {
            return;
        }

        hideError();
        dom.fileUploadedMessage.textContent = "Reading PDF...";
        state.pdf.name = null;
        state.pdf.extractedText = "";

        try {
            const extractedText = await extractTextFromPDF(file);
            if (!extractedText) {
                throw new Error("Could not extract any text from this PDF. Scanned image-only PDFs are not supported.");
            }

            state.pdf.name = file.name;
            state.pdf.extractedText = extractedText;

            // Reset to setup mode so a new test can be generated from this PDF
            state.mode = "setup";
            state.test.questions = { mcq: [], saq: [] };
            state.test.answers = { mcqSelectedIndex: [], saqText: [] };
            state.test.marking = null;
            renderQuestions();

            dom.fileUploadedMessage.textContent = `✔ Uploaded: ${file.name}`;
        } catch (err) {
            console.error("PDF extraction failed:", err);
            dom.fileUploadedMessage.textContent = "";
            showError(err.message || "Failed to read PDF file. Please upload a valid PDF.");
        }
    };

    input.click();
}

/***************************************************************
 * 3. OPENAI API
 ***************************************************************/
function getApiKey() {
    return (localStorage.getItem(CONFIG.storageKeys.apiKey) || "").trim();
}

function saveApiKey() {
    const key = dom.apiKeyInput.value.trim();

    if (key) {
        localStorage.setItem(CONFIG.storageKeys.apiKey, key);
        dom.apiKeyStatus.textContent = "API key saved.";
    } else {
        localStorage.removeItem(CONFIG.storageKeys.apiKey);
        dom.apiKeyStatus.textContent = "API key cleared.";
    }
}

function systemJSONOnlyPrompt() {
    return [
        "You are an academic assessment generator and marker.",
        "You must respond with VALID JSON only.",
        "No commentary, no markdown, no extra text.",
        "Follow the exact JSON schema requested.",
        "If you cannot comply exactly, return {}."
    ].join("\n");
}

function formatOpenAIError(status, rawBody) {
    let apiErrorCode = "";
    let apiErrorMessage = "";

    try {
        const parsed = JSON.parse(rawBody);
        apiErrorCode = parsed?.error?.code || "";
        apiErrorMessage = parsed?.error?.message || "";
    } catch {
        // Ignore non-JSON error bodies
    }

    if (status === 401) {
        return "Invalid OpenAI API key. Please check your key in Settings (⚙️).";
    }
    if (status === 403) {
        return `Access denied by OpenAI (403). Make sure your API key can access ${CONFIG.openaiModel}.`;
    }
    if (status === 429) {
        if (apiErrorCode === "insufficient_quota") {
            return "Your OpenAI account has exceeded its quota. Please check your billing and usage limits.";
        }
        return "OpenAI rate limit reached. Please wait a moment and try again.";
    }
    if (status === 400 && apiErrorCode === "context_length_exceeded") {
        return "This PDF is too long for the model's context limit. Try uploading a shorter document.";
    }
    if (status >= 500) {
        return "OpenAI is experiencing a temporary server error. Please try again in a moment.";
    }

    return apiErrorMessage
        ? `OpenAI API error (${status}): ${apiErrorMessage}`
        : `OpenAI API request failed (HTTP ${status}).`;
}

async function callOpenAIJSON(userPrompt, model = CONFIG.openaiModel) {
    const apiKey = getApiKey();
    if (!apiKey) {
        openSettingsSidebar();
        throw new Error("OpenAI API key is missing. Please add your key in Settings (⚙️).");
    }

    let response;
    try {
        response = await fetch(CONFIG.openaiEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemJSONOnlyPrompt() },
                    { role: "user", content: userPrompt }
                ]
            })
        });
    } catch {
        throw new Error("Network error while contacting OpenAI. Please check your internet connection.");
    }

    if (!response.ok) {
        const rawBody = await response.text().catch(() => "");
        throw new Error(formatOpenAIError(response.status, rawBody));
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";

    try {
        return JSON.parse(content);
    } catch {
        console.error("Raw model output (invalid JSON):", content);
        throw new Error("The AI returned an unexpected response format. Please try again.");
    }
}

/***************************************************************
 * 4. TEST GENERATION & MARKING
 ***************************************************************/
function clampInt(value, min, max) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) {
        return min;
    }
    return Math.max(min, Math.min(max, n));
}

function buildGenerationPrompt(extractedText, config) {
    return `
Using the lecture content below, generate exam questions.

LECTURE CONTENT:
${extractedText}

REQUIREMENTS:
- Generate exactly ${config.mcqCount} multiple-choice questions
- Each MCQ must have exactly ${config.choicesPerQuestion} options
- Each MCQ must have exactly ONE correct option
- Generate exactly ${config.saqCount} short-answer questions
- Questions must be at university level
- Avoid ambiguity
- Do NOT include answers in the question text

RETURN JSON IN THIS EXACT FORMAT:

{
"mcq": [
{
  "prompt": "Question text",
  "choices": ["A", "B", "C", "D"],
  "answerIndex": 0
}
],
"saq": [
{
  "prompt": "Question text",
  "maxScore": ${config.saqMaxScore}
}
]
}
`.trim();
}

function buildSAQMarkingPrompt(items, maxScore) {
    return `
You are marking short-answer exam questions.

Each question should be scored from 0 to ${maxScore}.
Provide ONE sentence of constructive feedback per answer.

QUESTIONS AND ANSWERS:
${JSON.stringify(items, null, 2)}

RETURN JSON IN THIS EXACT FORMAT:

{
"results": [
{
  "score": 0,
  "feedback": "One sentence of feedback."
}
]
}
`.trim();
}

async function generateQuestionsFromPDF() {
    if (!state.pdf.extractedText) {
        throw new Error("No PDF text available. Please upload a PDF first.");
    }

    const prompt = buildGenerationPrompt(state.pdf.extractedText, state.config);
    const result = await callOpenAIJSON(prompt);

    if (!result || !Array.isArray(result.mcq) || !Array.isArray(result.saq)) {
        throw new Error("Generated response is missing question lists. Please try again.");
    }

    if (result.mcq.length !== state.config.mcqCount || result.saq.length !== state.config.saqCount) {
        console.warn("Model returned different question counts than requested.", result);
    }

    const mcq = result.mcq.map((q, i) => {
        const choices = Array.isArray(q.choices) ? q.choices.map(String) : [];
        return {
            id: `mcq-${i + 1}`,
            prompt: String(q.prompt ?? ""),
            choices,
            answerIndex: clampInt(q.answerIndex, 0, Math.max(0, choices.length - 1))
        };
    });

    const saq = result.saq.map((q, i) => ({
        id: `saq-${i + 1}`,
        prompt: String(q.prompt ?? ""),
        maxScore: Number.isInteger(q.maxScore) && q.maxScore > 0 ? q.maxScore : state.config.saqMaxScore
    }));

    state.test.questions = { mcq, saq };
    state.test.answers = {
        mcqSelectedIndex: new Array(mcq.length).fill(null),
        saqText: new Array(saq.length).fill("")
    };
    state.test.marking = null;
    state.mode = "taking";
}

function collectAnswersIntoState() {
    for (let i = 0; i < state.test.questions.mcq.length; i++) {
        const selected = document.querySelector(`input[name="q${i + 1}"]:checked`);
        state.test.answers.mcqSelectedIndex[i] = selected ? parseInt(selected.value, 10) : null;
    }

    const saqTextareas = dom.questionsContainer.querySelectorAll('.question[data-qtype="saq"] textarea');
    saqTextareas.forEach((textarea, i) => {
        state.test.answers.saqText[i] = (textarea.value || "").trim();
    });
}

async function markTest() {
    collectAnswersIntoState();

    // Mark MCQs locally
    const mcqMarking = state.test.questions.mcq.map((q, i) => {
        const selectedIndex = state.test.answers.mcqSelectedIndex[i];
        const correctIndex = q.answerIndex;
        return {
            selectedIndex,
            correctIndex,
            isCorrect: selectedIndex !== null && selectedIndex === correctIndex
        };
    });

    const mcqScore = mcqMarking.reduce((sum, m) => sum + (m.isCorrect ? 1 : 0), 0);
    const mcqMax = state.test.questions.mcq.length;

    // Mark SAQs via OpenAI in a single batch
    const saqItems = state.test.questions.saq.map((q, i) => ({
        question: q.prompt,
        answer: state.test.answers.saqText[i] || ""
    }));

    let saqResults = [];
    if (saqItems.length > 0) {
        const prompt = buildSAQMarkingPrompt(saqItems, state.config.saqMaxScore);
        const result = await callOpenAIJSON(prompt);

        if (!result || !Array.isArray(result.results) || result.results.length !== saqItems.length) {
            throw new Error("Short-answer marking response was invalid. Please try submitting again.");
        }

        saqResults = result.results.map((r, i) => ({
            score: clampInt(r.score, 0, state.test.questions.saq[i].maxScore),
            maxScore: state.test.questions.saq[i].maxScore,
            feedback: String(r.feedback ?? "")
        }));
    }

    const saqScore = saqResults.reduce((sum, r) => sum + r.score, 0);
    const saqMax = state.test.questions.saq.reduce((sum, q) => sum + (q.maxScore || state.config.saqMaxScore), 0);

    state.test.marking = {
        status: "marked",
        totals: {
            mcqScore,
            mcqMax,
            saqScore,
            saqMax,
            totalScore: mcqScore + saqScore,
            totalMax: mcqMax + saqMax
        },
        mcq: mcqMarking,
        saq: saqResults,
        modelInfo: {
            model: CONFIG.openaiModel,
            markedAt: new Date().toISOString()
        }
    };

    state.mode = "marked";
}

/***************************************************************
 * 5. LOCALSTORAGE PERSISTENCE
 ***************************************************************/
function makeTestKey(id) {
    return `${CONFIG.storageKeys.testPrefix}${id}`;
}

function loadSavesIndex() {
    try {
        const parsed = JSON.parse(localStorage.getItem(CONFIG.storageKeys.savesIndex) || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function storeSavesIndex(index) {
    localStorage.setItem(CONFIG.storageKeys.savesIndex, JSON.stringify(index));
}

function buildSavedTestObject(name) {
    const now = new Date().toISOString();

    return {
        version: 1,
        meta: {
            id: String(Date.now()),
            name: (name || "Untitled").trim() || "Untitled",
            createdAt: now,
            updatedAt: now,
            pdfName: state.pdf.name
        },
        config: { ...state.config },
        questions: state.test.questions,
        answers: state.test.answers,
        marking: state.test.marking
    };
}

function saveTestObject(testObj) {
    localStorage.setItem(makeTestKey(testObj.meta.id), JSON.stringify(testObj));

    const index = loadSavesIndex();
    index.unshift({
        id: testObj.meta.id,
        name: testObj.meta.name,
        createdAt: testObj.meta.createdAt
    });
    storeSavesIndex(index);
}

function loadTestById(id) {
    const raw = localStorage.getItem(makeTestKey(id));
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function deleteTestById(id) {
    localStorage.removeItem(makeTestKey(id));
    const updatedIndex = loadSavesIndex().filter(item => item.id !== id);
    storeSavesIndex(updatedIndex);
}

function saveCurrentTest(name) {
    try {
        const testObj = buildSavedTestObject(name);
        saveTestObject(testObj);
        renderSavedTestsList();
        dom.mainButton.textContent = "Saved!";
    } catch (err) {
        console.error("Save failed:", err);
        showError("Could not save test. Browser storage may be full.");
    }
}

function loadSavedTest(id) {
    const saved = loadTestById(id);
    if (!saved) {
        showError("Could not load the selected saved test.");
        return;
    }

    state.config.mcqCount = saved.config?.mcqCount ?? 0;
    state.config.choicesPerQuestion = saved.config?.choicesPerQuestion ?? 2;
    state.config.saqCount = saved.config?.saqCount ?? 0;
    state.config.saqMaxScore = saved.config?.saqMaxScore ?? 4;
    syncCountersToUI();

    state.pdf.name = saved.meta?.pdfName ?? null;
    state.test.questions = saved.questions ?? { mcq: [], saq: [] };
    state.test.answers = saved.answers ?? { mcqSelectedIndex: [], saqText: [] };
    state.test.marking = saved.marking ?? null;
    state.mode = state.test.marking?.status === "marked" ? "marked" : "taking";

    hideError();
    renderQuestions();
    applyMarkingToUI();
    closeAllSidebars();
}

/***************************************************************
 * 6. UI & EVENT LISTENERS
 ***************************************************************/
function escapeHTML(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function showError(message) {
    dom.errorMessage.textContent = message;
    dom.errorMessage.style.display = "block";
}

function hideError() {
    dom.errorMessage.style.display = "none";
}

function syncCountersToUI() {
    dom.mcqCounter.textContent = state.config.mcqCount;
    dom.choicesCounter.textContent = state.config.choicesPerQuestion;
    dom.saqCounter.textContent = state.config.saqCount;
}

function updateCounter(type, delta) {
    if (type === "multipleChoice") {
        state.config.mcqCount = Math.max(0, state.config.mcqCount + delta);
    } else if (type === "choicesPerQuestion") {
        state.config.choicesPerQuestion = Math.max(2, state.config.choicesPerQuestion + delta);
    } else if (type === "shortAnswer") {
        state.config.saqCount = Math.max(0, state.config.saqCount + delta);
    }

    syncCountersToUI();
    hideError();
}

function updateMainButtonText() {
    if (state.mode === "setup") {
        dom.mainButton.textContent = "Generate Questions";
    } else if (state.mode === "taking") {
        dom.mainButton.textContent = "Submit Answers";
    } else if (state.mode === "marked") {
        dom.mainButton.textContent = "Save";
    }
}

function renderQuestions() {
    dom.questionsContainer.innerHTML = "";
    const isMarked = state.mode === "marked";

    const mcqSection = document.createElement("div");
    mcqSection.id = "mcq-section";

    if (state.test.questions.mcq.length > 0) {
        const mcqHeading = document.createElement("h2");
        mcqHeading.id = "mcq-heading";
        mcqHeading.textContent = "Multiple Choice Questions";
        mcqSection.appendChild(mcqHeading);
    }

    const saqSection = document.createElement("div");
    saqSection.id = "saq-section";

    if (state.test.questions.saq.length > 0) {
        const saqHeading = document.createElement("h2");
        saqHeading.id = "saq-heading";
        saqHeading.textContent = "Short Answer Questions";
        saqSection.appendChild(saqHeading);
    }

    dom.questionsContainer.appendChild(mcqSection);
    dom.questionsContainer.appendChild(saqSection);

    state.test.questions.mcq.forEach((q, i) => {
        let html = `<div class="question" data-qtype="mcq" data-index="${i}">
                        <p><strong>${i + 1}) ${escapeHTML(q.prompt)}</strong></p>`;

        q.choices.forEach((choice, cIndex) => {
            const checked = state.test.answers.mcqSelectedIndex[i] === cIndex ? "checked" : "";
            const disabled = isMarked ? "disabled" : "";
            html += `<label>
                        <input type="radio" name="q${i + 1}" value="${cIndex}" ${checked} ${disabled}>
                        ${escapeHTML(choice)}
                    </label><br>`;
        });

        html += `</div>`;
        mcqSection.insertAdjacentHTML("beforeend", html);
    });

    state.test.questions.saq.forEach((q, i) => {
        const questionNumber = state.test.questions.mcq.length + i + 1;
        const existingText = state.test.answers.saqText[i] ?? "";
        const readonly = isMarked ? "readonly" : "";
        const html = `<div class="question" data-qtype="saq" data-index="${i}">
                        <p><strong>${questionNumber}) ${escapeHTML(q.prompt)}</strong></p>
                        <textarea ${readonly}>${escapeHTML(existingText)}</textarea>
                    </div>`;
        saqSection.insertAdjacentHTML("beforeend", html);
    });

    updateMainButtonText();
}

function applyMarkingToUI() {
    if (!state.test.marking || state.test.marking.status !== "marked") {
        return;
    }

    const { totals } = state.test.marking;
    const mcqHeading = document.getElementById("mcq-heading");
    const saqHeading = document.getElementById("saq-heading");

    if (mcqHeading && totals.mcqMax > 0) {
        mcqHeading.textContent = `Multiple Choice Questions - Score: ${totals.mcqScore}/${totals.mcqMax}`;
    }
    if (saqHeading && totals.saqMax > 0) {
        saqHeading.textContent = `Short Answer Questions - Score: ${totals.saqScore}/${totals.saqMax}`;
    }

    const mcqDivs = dom.questionsContainer.querySelectorAll('.question[data-qtype="mcq"]');
    mcqDivs.forEach((div, i) => {
        const marking = state.test.marking.mcq[i];
        if (!marking) {
            return;
        }

        const promptPara = div.querySelector("p");
        if (promptPara) {
            promptPara.querySelectorAll("span").forEach(span => span.remove());
            const scoreSpan = document.createElement("span");
            scoreSpan.textContent = marking.isCorrect ? " 1/1" : " 0/1";
            promptPara.appendChild(scoreSpan);
        }

        const labels = div.querySelectorAll("label");
        labels.forEach((label, cIndex) => {
            label.querySelectorAll(".correct-tick, .incorrect-tick").forEach(span => span.remove());

            if (cIndex === marking.correctIndex) {
                const correctSpan = document.createElement("span");
                correctSpan.className = "correct-tick";
                correctSpan.textContent = " ✔";
                label.appendChild(correctSpan);
            }

            if (marking.selectedIndex !== null && cIndex === marking.selectedIndex && !marking.isCorrect) {
                const incorrectSpan = document.createElement("span");
                incorrectSpan.className = "incorrect-tick";
                incorrectSpan.textContent = " ✘";
                label.appendChild(incorrectSpan);
            }
        });
    });

    const saqDivs = dom.questionsContainer.querySelectorAll('.question[data-qtype="saq"]');
    saqDivs.forEach((div, i) => {
        div.querySelectorAll("p[data-feedback='1']").forEach(p => p.remove());

        const res = state.test.marking.saq[i];
        if (!res) {
            return;
        }

        const feedbackPara = document.createElement("p");
        feedbackPara.setAttribute("data-feedback", "1");
        feedbackPara.innerHTML = `<strong>Score: ${res.score}/${res.maxScore}</strong> - ${escapeHTML(res.feedback)}`;
        div.appendChild(feedbackPara);
    });

    updateMainButtonText();
}

function renderSavedTestsList() {
    dom.sidebarContent.innerHTML = "";

    const index = loadSavesIndex();
    if (index.length === 0) {
        dom.sidebarContent.innerHTML = "<p class='empty-saves-msg'>No saved tests yet.</p>";
        return;
    }

    index.forEach(item => {
        const quizDiv = document.createElement("div");
        quizDiv.className = "saved-quiz-item";

        const quizLink = document.createElement("a");
        quizLink.textContent = item.name;
        quizLink.className = "saved-quiz-link";
        quizLink.addEventListener("click", () => loadSavedTest(item.id));

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.textContent = "🗑";
        deleteBtn.className = "delete-btn";
        deleteBtn.title = "Delete saved test";
        deleteBtn.setAttribute("aria-label", `Delete ${item.name}`);
        deleteBtn.addEventListener("click", () => {
            deleteTestById(item.id);
            renderSavedTestsList();
        });

        quizDiv.appendChild(quizLink);
        quizDiv.appendChild(deleteBtn);
        dom.sidebarContent.appendChild(quizDiv);
    });
}

function closeAllSidebars() {
    dom.sidebar.classList.remove("open");
    dom.settingsSidebar.classList.remove("open");
    dom.sidebarOverlay.classList.remove("show");
}

function openSidebar() {
    dom.settingsSidebar.classList.remove("open");
    dom.sidebar.classList.add("open");
    dom.sidebarOverlay.classList.add("show");
    renderSavedTestsList();
}

function openSettingsSidebar() {
    dom.sidebar.classList.remove("open");
    dom.settingsSidebar.classList.add("open");
    dom.sidebarOverlay.classList.add("show");
    dom.apiKeyInput.value = getApiKey();
    dom.apiKeyStatus.textContent = "";
    dom.apiKeyInput.focus();
}

function showSavePopup() {
    dom.popupOverlay.classList.add("show");
    dom.savePopup.classList.add("show");
    dom.nameInput.focus();
}

function closeSavePopup() {
    dom.savePopup.classList.remove("show");
    dom.popupOverlay.classList.remove("show");
}

function handleSaveNameSubmit() {
    const name = dom.nameInput.value;
    dom.nameInput.value = "";
    closeSavePopup();
    saveCurrentTest(name);
}

function triggerConfetti() {
    if (typeof JSConfetti === "undefined") {
        return;
    }
    if (!jsConfettiInstance) {
        jsConfettiInstance = new JSConfetti();
    }
    jsConfettiInstance.addConfetti();
}

async function handleFormSubmit(event) {
    event.preventDefault();

    if (dom.mainButton.disabled) {
        return;
    }

    hideError();

    if (state.mode === "setup") {
        if (!state.pdf.extractedText) {
            showError("Please upload a PDF file before generating questions.");
            return;
        }
        if (state.config.mcqCount === 0 && state.config.saqCount === 0) {
            showError("Please select at least 1 question to generate.");
            return;
        }
    }

    if (state.mode === "marked") {
        showSavePopup();
        return;
    }

    dom.mainButton.disabled = true;
    dom.mainButton.textContent = "Loading...";

    try {
        if (state.mode === "setup") {
            await generateQuestionsFromPDF();
            renderQuestions();
            return;
        }

        if (state.mode === "taking") {
            await markTest();
            renderQuestions();
            applyMarkingToUI();
            triggerConfetti();
        }
    } catch (err) {
        console.error(err);
        showError(err.message || "Something went wrong. Please try again.");
    } finally {
        dom.mainButton.disabled = false;
        updateMainButtonText();
    }
}

function bindEventListeners() {
    dom.openSidebarBtn.addEventListener("click", openSidebar);
    dom.openSettingsBtn.addEventListener("click", openSettingsSidebar);
    dom.closeSidebarBtn.addEventListener("click", closeAllSidebars);
    dom.closeSettingsBtn.addEventListener("click", closeAllSidebars);
    dom.sidebarOverlay.addEventListener("click", closeAllSidebars);

    dom.saveApiKeyBtn.addEventListener("click", saveApiKey);
    dom.apiKeyInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            saveApiKey();
        }
    });

    dom.closePopupBtn.addEventListener("click", closeSavePopup);
    dom.popupOverlay.addEventListener("click", closeSavePopup);
    dom.submitNameBtn.addEventListener("click", handleSaveNameSubmit);
    dom.nameInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            handleSaveNameSubmit();
        }
    });

    dom.uploadFileBtn.addEventListener("click", handleFileUpload);
    dom.questionsForm.addEventListener("submit", handleFormSubmit);

    document.querySelectorAll("[data-counter]").forEach(btn => {
        btn.addEventListener("click", () => {
            const type = btn.getAttribute("data-counter");
            const delta = parseInt(btn.getAttribute("data-delta"), 10);
            updateCounter(type, delta);
        });
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeSavePopup();
            closeAllSidebars();
        }
    });
}

function init() {
    bindEventListeners();
    syncCountersToUI();
    renderSavedTestsList();
}

init();
