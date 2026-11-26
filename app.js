/***************************************************************
 * 1. STATE & CONFIG
 ***************************************************************/
const CONFIG = {
    openaiModel: "gpt-4.1-mini",
    proxyEndpoint: "/api/openai",
    openaiEndpoint: "https://api.openai.com/v1/chat/completions",
    pdfWorkerSrc: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js",
    acceptedFileTypes: ".pdf, application/pdf, .eoghan",
    limits: {
        mcqMax: 20,
        choicesMin: 2,
        choicesMax: 6,
        saqMax: 10
    },
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
 * - mode: "setup" | "taking" | "marked" | "saved"
 * - test.questions: { mcq: [{ id, prompt, choices[], answerIndex }], saq: [{ id, prompt, maxScore }] }
 * - test.answers:   { mcqSelectedIndex: (number|null)[], saqText: string[] }
 * - test.marking:   { status, totals, mcq[], saq[], modelInfo } | null
 */
const state = {
    mode: "setup",
    isBusy: false,
    currentSaveId: null,
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
    counterButtons: document.querySelectorAll("[data-counter]"),
    errorMessage: document.getElementById("error-message"),
    questionsForm: document.getElementById("questions-form"),
    questionsContainer: document.getElementById("questions-container"),
    mainButton: document.getElementById("main-button"),
    newExamBtn: document.getElementById("new-exam-btn")
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

async function processUploadedFile(file) {
    if (!file) {
        return;
    }

    const lowerName = (file.name || "").toLowerCase();
    const isAcceptedType =
        file.type === "application/pdf" ||
        lowerName.endsWith(".pdf") ||
        lowerName.endsWith(".eoghan");

    if (!isAcceptedType) {
        showError("Please upload a valid PDF file.");
        return;
    }

    const previousMessage = dom.fileUploadedMessage.textContent;
    hideError();
    dom.fileUploadedMessage.textContent = "Reading PDF...";

    try {
        const extractedText = await extractTextFromPDF(file);
        if (!extractedText) {
            throw new Error("Could not extract any text from this PDF. Scanned image-only PDFs are not supported.");
        }

        state.pdf.name = file.name;
        state.pdf.extractedText = extractedText;

        // Reset to setup mode so a new test can be generated from this PDF
        state.mode = "setup";
        state.currentSaveId = null;
        state.test.questions = { mcq: [], saq: [] };
        state.test.answers = { mcqSelectedIndex: [], saqText: [] };
        state.test.marking = null;
        renderQuestions();

        dom.fileUploadedMessage.textContent = `✔ Uploaded: ${file.name}`;
    } catch (err) {
        console.error("PDF extraction failed:", err);
        dom.fileUploadedMessage.textContent = previousMessage;
        showError(err.message || "Failed to read PDF file. Please upload a valid PDF.");
    }
}

function handleFileUpload(droppedFile) {
    if (state.isBusy) {
        return;
    }

    if (droppedFile instanceof File) {
        processUploadedFile(droppedFile);
        return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = CONFIG.acceptedFileTypes;

    input.onchange = () => {
        const file = input.files[0];
        if (file) {
            processUploadedFile(file);
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
        dom.apiKeyStatus.textContent = "Custom API key saved. Requests will call OpenAI directly.";
    } else {
        localStorage.removeItem(CONFIG.storageKeys.apiKey);
        dom.apiKeyStatus.textContent = "API key cleared. Using default server proxy.";
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

function formatOpenAIError(status, rawBody, usingProxy) {
    let apiErrorCode = "";
    let apiErrorMessage = "";

    try {
        const parsed = JSON.parse(rawBody);
        apiErrorCode = parsed?.error?.code || "";
        apiErrorMessage = parsed?.error?.message || "";
    } catch {
        // Ignore non-JSON error bodies
    }

    if (usingProxy && (status === 404 || status === 405)) {
        return "Server proxy (/api/openai) is unavailable here. Run with `vercel dev`, deploy to Vercel, or add your own API key in Settings (⚙️).";
    }
    if (status === 401) {
        return usingProxy
            ? "The server's OpenAI API key is invalid. Please contact the site owner or enter your own key in Settings (⚙️)."
            : "Invalid OpenAI API key. Please check your key in Settings (⚙️).";
    }
    if (status === 403) {
        if (usingProxy && apiErrorMessage) {
            return apiErrorMessage;
        }
        return `Access denied by OpenAI (403). Make sure your API key can access ${CONFIG.openaiModel}.`;
    }
    if (status === 429) {
        if (apiErrorCode === "insufficient_quota") {
            return "The OpenAI account has exceeded its quota. Please check billing/usage limits or use a different API key in Settings (⚙️).";
        }
        return "OpenAI rate limit reached. Please wait a moment and try again.";
    }
    if (status === 400 && apiErrorCode === "context_length_exceeded") {
        return "This PDF is too long for the model's context limit. Try uploading a shorter document.";
    }
    if (status >= 500) {
        if (usingProxy && apiErrorMessage) {
            return apiErrorMessage;
        }
        return "OpenAI is experiencing a temporary server error. Please try again in a moment.";
    }

    return apiErrorMessage
        ? `OpenAI API error (${status}): ${apiErrorMessage}`
        : `OpenAI API request failed (HTTP ${status}).`;
}

async function callOpenAIJSON(userPrompt, model = CONFIG.openaiModel) {
    const customApiKey = getApiKey();
    const usingProxy = !customApiKey;
    const endpoint = usingProxy ? CONFIG.proxyEndpoint : CONFIG.openaiEndpoint;

    const headers = { "Content-Type": "application/json" };
    const messages = [
        { role: "system", content: systemJSONOnlyPrompt() },
        { role: "user", content: userPrompt }
    ];
    const responseFormat = { type: "json_object" };

    const requestBody = usingProxy
        ? { messages, response_format: responseFormat }
        : { model, messages, response_format: responseFormat };

    if (!usingProxy) {
        headers["Authorization"] = `Bearer ${customApiKey}`;
    }

    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody)
        });
    } catch {
        throw new Error(
            usingProxy
                ? "Could not reach /api/openai. Run with `vercel dev`, deploy to Vercel, or add your own API key in Settings (⚙️)."
                : "Network error while contacting OpenAI. Please check your internet connection."
        );
    }

    if (!response.ok) {
        const rawBody = await response.text().catch(() => "");
        throw new Error(formatOpenAIError(response.status, rawBody, usingProxy));
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
        throw new Error("The AI response was cut off because it was too long. Try requesting fewer questions.");
    }

    const content = choice?.message?.content ?? "{}";

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
If an answer is blank, score it 0 and briefly note what a strong answer should cover.
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
        state.mode = "saved";
        state.currentSaveId = testObj.meta.id;
        renderSavedTestsList();
        syncControlsToMode();
    } catch (err) {
        console.error("Save failed:", err);
        showError("Could not save test. Browser storage may be full.");
    }
}

function loadSavedTest(id) {
    if (state.isBusy) {
        return;
    }

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
    state.pdf.extractedText = "";
    state.test.questions = saved.questions ?? { mcq: [], saq: [] };
    state.test.answers = saved.answers ?? { mcqSelectedIndex: [], saqText: [] };
    state.test.marking = saved.marking ?? null;
    state.currentSaveId = id;
    state.mode = state.test.marking?.status === "marked" ? "saved" : "taking";

    const savedName = saved.meta?.name || "Saved exam";
    dom.fileUploadedMessage.textContent = state.pdf.name
        ? `Loaded save: ${savedName} (${state.pdf.name})`
        : `Loaded save: ${savedName}`;

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
    if (state.mode !== "setup" || state.isBusy) {
        return;
    }

    if (type === "multipleChoice") {
        state.config.mcqCount = clampInt(state.config.mcqCount + delta, 0, CONFIG.limits.mcqMax);
    } else if (type === "choicesPerQuestion") {
        state.config.choicesPerQuestion = clampInt(
            state.config.choicesPerQuestion + delta,
            CONFIG.limits.choicesMin,
            CONFIG.limits.choicesMax
        );
    } else if (type === "shortAnswer") {
        state.config.saqCount = clampInt(state.config.saqCount + delta, 0, CONFIG.limits.saqMax);
    }

    syncCountersToUI();
    hideError();
}

function syncControlsToMode() {
    const countersDisabled = state.mode !== "setup" || state.isBusy;
    dom.counterButtons.forEach(btn => {
        btn.disabled = countersDisabled;
    });

    dom.uploadFileBtn.disabled = state.isBusy;
    dom.newExamBtn.hidden = !(state.mode === "marked" || state.mode === "saved");
    dom.mainButton.classList.toggle("is-saved", !state.isBusy && state.mode === "saved");

    if (state.isBusy) {
        const busyLabel = state.mode === "setup" ? "Generating Questions..." : "Marking Answers...";
        dom.mainButton.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>${busyLabel}</span>`;
        dom.mainButton.disabled = true;
        return;
    }

    if (state.mode === "setup") {
        dom.mainButton.textContent = "Generate Questions";
        dom.mainButton.disabled = false;
    } else if (state.mode === "taking") {
        dom.mainButton.textContent = "Submit Answers";
        dom.mainButton.disabled = false;
    } else if (state.mode === "marked") {
        dom.mainButton.textContent = "Save Results";
        dom.mainButton.disabled = false;
    } else if (state.mode === "saved") {
        dom.mainButton.textContent = "✔ Saved!";
        dom.mainButton.disabled = true;
    }
}

function resetToSetup() {
    if (state.isBusy) {
        return;
    }

    state.mode = "setup";
    state.currentSaveId = null;
    state.test.questions = { mcq: [], saq: [] };
    state.test.answers = { mcqSelectedIndex: [], saqText: [] };
    state.test.marking = null;

    if (state.pdf.extractedText && state.pdf.name) {
        dom.fileUploadedMessage.textContent = `✔ Uploaded: ${state.pdf.name}`;
    } else {
        state.pdf.name = null;
        dom.fileUploadedMessage.textContent = "";
    }

    hideError();
    renderQuestions();
}

function renderQuestions() {
    dom.questionsContainer.innerHTML = "";
    const isLocked = state.mode === "marked" || state.mode === "saved";

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
        let html = `<div class="question question-card" data-qtype="mcq" data-index="${i}">
                        <div class="question-header">
                            <span class="question-badge">Q${i + 1}</span>
                            <p class="question-prompt">${escapeHTML(q.prompt)}</p>
                        </div>
                        <div class="mcq-options">`;

        q.choices.forEach((choice, cIndex) => {
            const checked = state.test.answers.mcqSelectedIndex[i] === cIndex ? "checked" : "";
            const disabled = isLocked ? "disabled" : "";
            html += `<label class="mcq-option">
                        <input type="radio" name="q${i + 1}" value="${cIndex}" ${checked} ${disabled}>
                        <span class="mcq-option-text">${escapeHTML(choice)}</span>
                    </label>`;
        });

        html += `</div></div>`;
        mcqSection.insertAdjacentHTML("beforeend", html);
    });

    state.test.questions.saq.forEach((q, i) => {
        const questionNumber = state.test.questions.mcq.length + i + 1;
        const existingText = state.test.answers.saqText[i] ?? "";
        const readonly = isLocked ? "readonly" : "";
        const html = `<div class="question question-card" data-qtype="saq" data-index="${i}">
                        <div class="question-header">
                            <span class="question-badge">Q${questionNumber}</span>
                            <p class="question-prompt">${escapeHTML(q.prompt)}</p>
                        </div>
                        <textarea placeholder="Write your answer here..." ${readonly}>${escapeHTML(existingText)}</textarea>
                    </div>`;
        saqSection.insertAdjacentHTML("beforeend", html);
    });

    syncControlsToMode();
}

function applyMarkingToUI() {
    if (!state.test.marking || state.test.marking.status !== "marked") {
        return;
    }

    const { totals } = state.test.marking;

    // Render overall score hero banner at top of questions container
    dom.questionsContainer.querySelectorAll(".total-score-banner").forEach(el => el.remove());
    if (totals.totalMax > 0) {
        const pct = Math.round((totals.totalScore / totals.totalMax) * 100);
        const chips = [];
        if (totals.mcqMax > 0) {
            chips.push(`<span class="score-chip">MCQs: ${totals.mcqScore}/${totals.mcqMax}</span>`);
        }
        if (totals.saqMax > 0) {
            chips.push(`<span class="score-chip">Short Answers: ${totals.saqScore}/${totals.saqMax}</span>`);
        }

        const banner = document.createElement("div");
        banner.className = "total-score-banner";
        banner.innerHTML = `
            <span class="score-banner-eyebrow">Exam Results</span>
            <div class="score-banner-main">
                <span class="score-banner-fraction">${totals.totalScore} / ${totals.totalMax}</span>
                <span class="score-banner-percent">${pct}%</span>
            </div>
            ${chips.length > 0 ? `<div class="score-banner-breakdown">${chips.join("")}</div>` : ""}
        `;
        dom.questionsContainer.prepend(banner);
    }

    const mcqHeading = document.getElementById("mcq-heading");
    const saqHeading = document.getElementById("saq-heading");

    if (mcqHeading && totals.mcqMax > 0) {
        mcqHeading.textContent = `Multiple Choice Questions — ${totals.mcqScore}/${totals.mcqMax}`;
    }
    if (saqHeading && totals.saqMax > 0) {
        saqHeading.textContent = `Short Answer Questions — ${totals.saqScore}/${totals.saqMax}`;
    }

    const mcqDivs = dom.questionsContainer.querySelectorAll('.question[data-qtype="mcq"]');
    mcqDivs.forEach((div, i) => {
        const marking = state.test.marking.mcq[i];
        if (!marking) {
            return;
        }

        const header = div.querySelector(".question-header");
        if (header) {
            header.querySelectorAll(".score-pill").forEach(el => el.remove());
            const scorePill = document.createElement("span");
            scorePill.className = `score-pill ${marking.isCorrect ? "correct" : "incorrect"}`;
            scorePill.textContent = marking.isCorrect ? "1/1" : "0/1";
            header.appendChild(scorePill);
        }

        const labels = div.querySelectorAll(".mcq-option");
        labels.forEach((label, cIndex) => {
            label.classList.remove("option-correct", "option-incorrect");
            label.querySelectorAll(".correct-tick, .incorrect-tick").forEach(span => span.remove());

            if (cIndex === marking.correctIndex) {
                label.classList.add("option-correct");
                const correctSpan = document.createElement("span");
                correctSpan.className = "correct-tick";
                correctSpan.textContent = "✔ Correct";
                label.appendChild(correctSpan);
            }

            if (marking.selectedIndex !== null && cIndex === marking.selectedIndex && !marking.isCorrect) {
                label.classList.add("option-incorrect");
                const incorrectSpan = document.createElement("span");
                incorrectSpan.className = "incorrect-tick";
                incorrectSpan.textContent = "✘ Your Answer";
                label.appendChild(incorrectSpan);
            }
        });
    });

    const saqDivs = dom.questionsContainer.querySelectorAll('.question[data-qtype="saq"]');
    saqDivs.forEach((div, i) => {
        div.querySelectorAll("[data-feedback='1']").forEach(el => el.remove());

        const res = state.test.marking.saq[i];
        if (!res) {
            return;
        }

        const scoreClass = res.score === res.maxScore ? "correct" : res.score === 0 ? "incorrect" : "partial";
        const header = div.querySelector(".question-header");
        if (header) {
            header.querySelectorAll(".score-pill").forEach(el => el.remove());
            const scorePill = document.createElement("span");
            scorePill.className = `score-pill ${scoreClass}`;
            scorePill.textContent = `${res.score}/${res.maxScore}`;
            header.appendChild(scorePill);
        }

        const feedbackBox = document.createElement("div");
        feedbackBox.className = "saq-feedback-box";
        feedbackBox.setAttribute("data-feedback", "1");
        feedbackBox.innerHTML = `
            <div class="saq-feedback-header">
                <span class="saq-feedback-label">AI Feedback</span>
                <span class="score-pill ${scoreClass}">Score: ${res.score}/${res.maxScore}</span>
            </div>
            <p class="saq-feedback-text">${escapeHTML(res.feedback)}</p>
        `;
        div.appendChild(feedbackBox);
    });

    syncControlsToMode();
}

function renderSavedTestsList() {
    dom.sidebarContent.innerHTML = "";

    const index = loadSavesIndex();
    if (index.length === 0) {
        dom.sidebarContent.innerHTML = "<p class='empty-saves-msg'>No saved tests yet. Complete and save an exam to see it here.</p>";
        return;
    }

    index.forEach(item => {
        const quizDiv = document.createElement("div");
        quizDiv.className = "saved-quiz-item";
        if (item.id === state.currentSaveId) {
            quizDiv.classList.add("is-active");
        }

        const quizLink = document.createElement("a");
        quizLink.textContent = item.name;
        quizLink.className = "saved-quiz-link";
        quizLink.title = item.name;
        quizLink.addEventListener("click", () => loadSavedTest(item.id));

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-btn";
        deleteBtn.title = "Delete saved test";
        deleteBtn.setAttribute("aria-label", `Delete ${item.name}`);
        deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`;
        deleteBtn.addEventListener("click", () => {
            deleteTestById(item.id);
            if (state.currentSaveId === item.id && state.mode === "saved") {
                state.currentSaveId = null;
                state.mode = "marked";
                syncControlsToMode();
            }
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
    const suggestedName = state.pdf.name ? state.pdf.name.replace(/\.pdf$/i, "") : "";
    dom.nameInput.value = suggestedName;
    dom.popupOverlay.classList.add("show");
    dom.savePopup.classList.add("show");
    dom.nameInput.focus();
    dom.nameInput.select();
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

    if (state.isBusy || dom.mainButton.disabled || state.mode === "saved") {
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

    state.isBusy = true;
    syncControlsToMode();

    try {
        if (state.mode === "setup") {
            await generateQuestionsFromPDF();
            state.currentSaveId = null;
            renderQuestions();
            return;
        }

        if (state.mode === "taking") {
            await markTest();
            state.currentSaveId = null;
            renderQuestions();
            applyMarkingToUI();
            triggerConfetti();
        }
    } catch (err) {
        console.error(err);
        showError(err.message || "Something went wrong. Please try again.");
    } finally {
        state.isBusy = false;
        syncControlsToMode();
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

    dom.uploadFileBtn.addEventListener("click", () => handleFileUpload());
    ["dragenter", "dragover"].forEach(eventName => {
        dom.uploadFileBtn.addEventListener(eventName, event => {
            event.preventDefault();
            if (!state.isBusy) {
                dom.uploadFileBtn.classList.add("drag-over");
            }
        });
    });
    ["dragleave", "dragend"].forEach(eventName => {
        dom.uploadFileBtn.addEventListener(eventName, event => {
            if (!dom.uploadFileBtn.contains(event.relatedTarget)) {
                dom.uploadFileBtn.classList.remove("drag-over");
            }
        });
    });
    dom.uploadFileBtn.addEventListener("drop", event => {
        event.preventDefault();
        dom.uploadFileBtn.classList.remove("drag-over");
        const droppedFile = event.dataTransfer?.files?.[0];
        if (droppedFile) {
            handleFileUpload(droppedFile);
        }
    });

    dom.questionsForm.addEventListener("submit", handleFormSubmit);
    dom.newExamBtn.addEventListener("click", resetToSetup);

    dom.counterButtons.forEach(btn => {
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
    syncControlsToMode();
    renderSavedTestsList();
}

init();
