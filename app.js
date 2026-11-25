/***************************************************************
 *  APP OVERVIEW
 *
 *  state.mode:
 *      "setup"  -> user can upload PDF + choose counts -> Generate
 *      "taking" -> questions shown -> Submit Answers (mark)
 *      "marked" -> results shown -> Save (popup)
 *
 *  state.test.questions:
 *      mcq: [{ id, prompt, choices[], answerIndex }]
 *      saq: [{ id, prompt, maxScore }]
 *
 *  state.test.answers:
 *      mcqSelectedIndex[] (number|null)
 *      saqText[] (string)
 *
 *  state.test.marking:
 *      totals + per-question marking
 ***************************************************************/

/***************************************************************
 *  CONFIG: API & PDF.JS
 ***************************************************************/
const API_KEY_STORAGE_KEY = "__OPENAI_API_KEY__";
const defaultApiKey = "";
const modelForGeneration = "gpt-4o-mini";
const modelForSAQMarking = "gpt-4o-mini";

if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";
}

let jsConfettiInstance = null;

function getApiKey() {
    return (localStorage.getItem(API_KEY_STORAGE_KEY) || defaultApiKey).trim();
}

function saveApiKey() {
    const input = document.getElementById("apiKeyInput");
    const status = document.getElementById("apiKeyStatus");
    const key = input.value.trim();

    if (key) {
        localStorage.setItem(API_KEY_STORAGE_KEY, key);
        status.textContent = "API key saved.";
    } else {
        localStorage.removeItem(API_KEY_STORAGE_KEY);
        status.textContent = "API key cleared.";
    }
}

/***************************************************************
 *  GLOBAL STATE
 ***************************************************************/
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
        questions: {
            mcq: [],
            saq: []
        },
        answers: {
            mcqSelectedIndex: [],
            saqText: []
        },
        marking: null
    }
};

/***************************************************************
 *  UI HELPERS
 ***************************************************************/
function showError(message) {
    const el = document.getElementById("error-message");
    el.textContent = message;
    el.style.display = "block";
}

function hideError() {
    document.getElementById("error-message").style.display = "none";
}

function syncCountersToUI() {
    document.getElementById("multiple-choice-counter").innerText = state.config.mcqCount;
    document.getElementById("choices-per-question-counter").innerText = state.config.choicesPerQuestion;
    document.getElementById("short-answer-counter").innerText = state.config.saqCount;
}

// Updates counters + rules
function updateCounter(type, change) {
    if (type === "multipleChoice") {
        state.config.mcqCount = Math.max(0, state.config.mcqCount + change);
    } else if (type === "choicesPerQuestion") {
        state.config.choicesPerQuestion = Math.max(2, state.config.choicesPerQuestion + change);
    } else if (type === "shortAnswer") {
        state.config.saqCount = Math.max(0, state.config.saqCount + change);
    }

    syncCountersToUI();
    hideError();
}

/***************************************************************
 *  PDF UPLOAD + TEXT EXTRACTION
 ***************************************************************/
let fileUploaded = false;
let uploadedFile = null;

function handleFileUpload() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf, .eoghanIsTheBest, .iftiIsTheBestToo";

    input.onchange = async () => {
        const file = input.files[0];
        if (!file) {
            return;
        }

        const statusEl = document.getElementById("file-uploaded-message");
        hideError();
        statusEl.textContent = "Reading PDF...";
        fileUploaded = false;

        try {
            const arrayBuffer = await file.arrayBuffer();
            const typedArray = new Uint8Array(arrayBuffer);
            const pdf = await pdfjsLib.getDocument({ data: typedArray }).promise;

            let extracted = "";
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(" ");
                extracted += pageText + "\n";
            }

            if (!extracted.trim()) {
                throw new Error("Could not extract any text from this PDF.");
            }

            fileUploaded = true;
            uploadedFile = file;
            state.pdf.name = file.name;
            state.pdf.extractedText = extracted;

            // Reset to setup mode so a new test can be generated from the newly uploaded PDF
            state.mode = "setup";
            state.test.questions = { mcq: [], saq: [] };
            state.test.answers = { mcqSelectedIndex: [], saqText: [] };
            state.test.marking = null;
            renderQuestions();

            statusEl.textContent = `✔ File uploaded successfully: ${file.name}`;
            console.log("Extracted PDF Text length:", extracted.length);
        } catch (err) {
            console.error("PDF read error:", err);
            fileUploaded = false;
            uploadedFile = null;
            state.pdf.name = null;
            state.pdf.extractedText = "";
            statusEl.textContent = "";
            showError(err.message || "Failed to read PDF file. Please upload a valid PDF.");
        }
    };

    input.click();
}

/***************************************************************
 *  OPENAI HELPERS (STATELESS)
 ***************************************************************/
function systemJSONOnlyPrompt() {
    return [
        "You are an academic assessment generator and marker.",
        "You must respond with VALID JSON only.",
        "No commentary, no markdown, no extra text.",
        "Follow the exact JSON schema requested.",
        "If you cannot comply exactly, return {}."
    ].join("\n");
}

// Returns parsed JSON response from OpenAI
async function callOpenAIJSON(model, userPrompt) {
    const apiKey = getApiKey();
    if (!apiKey) {
        openSettingsSidebar();
        throw new Error("OpenAI API key is missing. Please enter it in Settings (⚙️).");
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemJSONOnlyPrompt() },
                { role: "user", content: userPrompt }
            ]
        })
    });

    if (!response.ok) {
        const txt = await response.text().catch(() => "");
        throw new Error(`OpenAI HTTP ${response.status}: ${txt.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";

    try {
        return JSON.parse(content);
    } catch (e) {
        console.error("Raw model output (not JSON):", content);
        throw new Error("Model did not return valid JSON.");
    }
}

/***************************************************************
 *  JSON PROMPTS
 ***************************************************************/
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
  "maxScore": 4
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

/***************************************************************
 *  GENERATE QUESTIONS (JSON)
 ***************************************************************/
async function generateQuestionsFromPDF() {
    if (!fileUploaded || !state.pdf.extractedText) {
        throw new Error("No PDF text available. Upload a PDF first.");
    }

    const prompt = buildGenerationPrompt(state.pdf.extractedText, state.config);
    const result = await callOpenAIJSON(modelForGeneration, prompt);

    if (!result || !Array.isArray(result.mcq) || !Array.isArray(result.saq)) {
        throw new Error("Generation JSON is missing mcq/saq arrays.");
    }

    // Optional: basic shape validation
    if (result.mcq.length !== state.config.mcqCount || result.saq.length !== state.config.saqCount) {
        console.warn("Model returned different counts than requested.", result);
    }

    // Assign IDs + normalize
    const mcq = result.mcq.map((q, i) => ({
        id: `mcq-${i + 1}`,
        prompt: String(q.prompt ?? ""),
        choices: Array.isArray(q.choices) ? q.choices.map(String) : [],
        answerIndex: Number.isInteger(q.answerIndex) ? q.answerIndex : 0
    }));

    const saq = result.saq.map((q, i) => ({
        id: `saq-${i + 1}`,
        prompt: String(q.prompt ?? ""),
        maxScore: Number.isInteger(q.maxScore) ? q.maxScore : state.config.saqMaxScore
    }));

    state.test.questions.mcq = mcq;
    state.test.questions.saq = saq;

    // Reset answers arrays to correct lengths
    state.test.answers.mcqSelectedIndex = new Array(mcq.length).fill(null);
    state.test.answers.saqText = new Array(saq.length).fill("");

    // Clear old marking
    state.test.marking = null;
    state.mode = "taking";
}

/***************************************************************
 *  RENDER QUESTIONS FROM STATE
 ***************************************************************/
// Builds the questions section of the UI
function renderQuestions() {
    const container = document.getElementById("questions-container");
    container.innerHTML = "";

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

    container.appendChild(mcqSection);
    container.appendChild(saqSection);

    // MCQs
    state.test.questions.mcq.forEach((q, i) => {
        let html = `<div class="question" data-qtype="mcq" data-index="${i}">
                        <p><strong>${i + 1}) ${escapeHTML(q.prompt)}</strong></p>`;

        q.choices.forEach((choice, cIndex) => {
            // Value is index (reliable), not text
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

    // SAQs
    state.test.questions.saq.forEach((q, i) => {
        const number = state.test.questions.mcq.length + i + 1;
        const existingText = state.test.answers.saqText[i] ?? "";
        const readonly = isMarked ? "readonly" : "";
        const html = `<div class="question" data-qtype="saq" data-index="${i}">
                        <p><strong>${number}) ${escapeHTML(q.prompt)}</strong></p>
                        <textarea ${readonly}>${escapeHTML(existingText)}</textarea>
                    </div>`;
        saqSection.insertAdjacentHTML("beforeend", html);
    });

    updateMainButtonText();
}

function updateMainButtonText() {
    const mainButton = document.getElementById("mainButton");
    if (state.mode === "setup") {
        mainButton.innerText = "Generate Questions";
    } else if (state.mode === "taking") {
        mainButton.innerText = "Submit Answers";
    } else if (state.mode === "marked") {
        mainButton.innerText = "Save";
    }
}

// Simple HTML escape to avoid breaking markup when inserting text
function escapeHTML(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

/***************************************************************
 *  COLLECT ANSWERS FROM UI INTO STATE
 ***************************************************************/
function collectAnswersIntoState() {
    // MCQ indices
    for (let i = 0; i < state.test.questions.mcq.length; i++) {
        const selected = document.querySelector(`input[name="q${i + 1}"]:checked`);
        if (!selected) {
            state.test.answers.mcqSelectedIndex[i] = null;
        } else {
            state.test.answers.mcqSelectedIndex[i] = parseInt(selected.value, 10);
        }
    }

    // SAQ textareas: only those under questions-container
    const saqTextareas = document.querySelectorAll('#questions-container .question[data-qtype="saq"] textarea');
    saqTextareas.forEach((ta, i) => {
        state.test.answers.saqText[i] = (ta.value || "").trim();
    });
}

/***************************************************************
 *  MARKING
 *  - MCQ marked locally
 *  - SAQ marked via OpenAI JSON (batch)
 ***************************************************************/
async function markTest() {
    collectAnswersIntoState();

    // Mark MCQ locally
    const mcqMarking = state.test.questions.mcq.map((q, i) => {
        const selectedIndex = state.test.answers.mcqSelectedIndex[i];
        const correctIndex = q.answerIndex;
        const isCorrect = (selectedIndex !== null && selectedIndex === correctIndex);

        return {
            selectedIndex: selectedIndex,
            correctIndex: correctIndex,
            isCorrect: isCorrect
        };
    });

    const mcqScore = mcqMarking.reduce((sum, m) => sum + (m.isCorrect ? 1 : 0), 0);
    const mcqMax = state.test.questions.mcq.length;

    // Mark SAQ via AI (batch)
    const saqItems = state.test.questions.saq.map((q, i) => ({
        question: q.prompt,
        answer: state.test.answers.saqText[i] || ""
    }));

    let saqResults = [];
    if (saqItems.length > 0) {
        const prompt = buildSAQMarkingPrompt(saqItems, state.config.saqMaxScore);
        const result = await callOpenAIJSON(modelForSAQMarking, prompt);

        if (!result || !Array.isArray(result.results) || result.results.length !== saqItems.length) {
            throw new Error("SAQ marking JSON invalid or wrong length.");
        }

        // Normalize
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
            mcqScore: mcqScore,
            mcqMax: mcqMax,
            saqScore: saqScore,
            saqMax: saqMax,
            totalScore: mcqScore + saqScore,
            totalMax: mcqMax + saqMax
        },
        mcq: mcqMarking,
        saq: saqResults,
        modelInfo: {
            model: modelForSAQMarking,
            markedAt: new Date().toISOString()
        }
    };

    state.mode = "marked";
}

function clampInt(value, min, max) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) {
        return min;
    }
    return Math.max(min, Math.min(max, n));
}

/***************************************************************
 *  APPLY MARKING TO UI (used after marking AND after loading saved marked tests)
 ***************************************************************/
function applyMarkingToUI() {
    if (!state.test.marking || state.test.marking.status !== "marked") {
        return;
    }

    // Update headings with scores (only if that section has questions)
    const mcqHeading = document.getElementById("mcq-heading");
    const saqHeading = document.getElementById("saq-heading");

    if (mcqHeading && state.test.marking.totals.mcqMax > 0) {
        mcqHeading.textContent = `Multiple Choice Questions - Score: ${state.test.marking.totals.mcqScore}/${state.test.marking.totals.mcqMax}`;
    }
    if (saqHeading && state.test.marking.totals.saqMax > 0) {
        saqHeading.textContent = `Short Answer Questions - Score: ${state.test.marking.totals.saqScore}/${state.test.marking.totals.saqMax}`;
    }

    // MCQ ticks and per-question 1/1 / 0/1
    const mcqDivs = document.querySelectorAll('#questions-container .question[data-qtype="mcq"]');
    mcqDivs.forEach((div, i) => {
        const marking = state.test.marking.mcq[i];
        if (!marking) {
            return;
        }

        const p = div.querySelector("p");
        if (p) {
            // Remove any old appended spans
            p.querySelectorAll("span").forEach(s => s.remove());

            const scoreSpan = document.createElement("span");
            scoreSpan.innerText = marking.isCorrect ? " 1/1" : " 0/1";
            p.appendChild(scoreSpan);
        }

        // Add ticks to labels
        const labels = div.querySelectorAll("label");
        labels.forEach((label, cIndex) => {
            // Remove old tick spans if they exist
            label.querySelectorAll(".correct-tick, .incorrect-tick").forEach(s => s.remove());

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

    // SAQ feedback paragraphs
    const saqDivs = document.querySelectorAll('#questions-container .question[data-qtype="saq"]');
    saqDivs.forEach((div, i) => {
        // Remove old feedback paragraphs we might have appended
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

    // Update button
    document.getElementById("mainButton").innerText = "Save";
}

/***************************************************************
 *  SAVE SYSTEM (MULTIPLE SAVES, DATA-ONLY)
 ***************************************************************/
const SAVES_INDEX_KEY = "__SAVED_TESTS_INDEX_V1__";
const TEST_KEY_PREFIX = "saved_test_v2_";

function makeTestKey(id) {
    return `${TEST_KEY_PREFIX}${id}`;
}

function loadSavesIndex() {
    try {
        return JSON.parse(localStorage.getItem(SAVES_INDEX_KEY) || "[]");
    } catch {
        return [];
    }
}

function storeSavesIndex(index) {
    localStorage.setItem(SAVES_INDEX_KEY, JSON.stringify(index));
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
        config: {
            mcqCount: state.config.mcqCount,
            choicesPerQuestion: state.config.choicesPerQuestion,
            saqCount: state.config.saqCount,
            saqMaxScore: state.config.saqMaxScore
        },
        questions: state.test.questions,
        answers: state.test.answers,
        marking: state.test.marking
    };
}

function saveTestObject(testObj) {
    localStorage.setItem(makeTestKey(testObj.meta.id), JSON.stringify(testObj));

    const index = loadSavesIndex();
    index.unshift({ id: testObj.meta.id, name: testObj.meta.name, createdAt: testObj.meta.createdAt });
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
    const index = loadSavesIndex().filter(x => x.id !== id);
    storeSavesIndex(index);
}

/***************************************************************
 *  SIDEBARS (SAVED TESTS & SETTINGS)
 ***************************************************************/
function closeAllSidebars() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("settingsSidebar").classList.remove("open");
    document.getElementById("sidebarOverlay").classList.remove("show");
}

function openSidebar() {
    document.getElementById("settingsSidebar").classList.remove("open");
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebarOverlay").classList.add("show");
    getOptions();
}

function closeSidebar() {
    closeAllSidebars();
}

function openSettingsSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("settingsSidebar").classList.add("open");
    document.getElementById("sidebarOverlay").classList.add("show");
    document.getElementById("apiKeyInput").value = getApiKey();
    document.getElementById("apiKeyStatus").textContent = "";
}

function closeSettingsSidebar() {
    closeAllSidebars();
}

function getOptions() {
    const sidebarDiv = document.getElementById("sidebar-content");
    sidebarDiv.innerHTML = "";

    const index = loadSavesIndex();
    if (index.length === 0) {
        sidebarDiv.innerHTML = "<p class='empty-saves-msg'>No saved tests yet.</p>";
        return;
    }

    index.forEach(item => {
        const quizDiv = document.createElement("div");
        quizDiv.id = `quiz-${item.id}`;
        quizDiv.className = "saved-quiz-item";

        const quizLink = document.createElement("a");
        quizLink.textContent = item.name;
        quizLink.className = "saved-quiz-link";
        quizLink.onclick = () => loadPageState(item.id);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.textContent = "🗑";
        deleteBtn.className = "delete-btn";
        deleteBtn.title = "Delete saved test";
        deleteBtn.onclick = () => {
            deleteTestById(item.id);
            getOptions();
        };

        quizDiv.appendChild(quizLink);
        quizDiv.appendChild(deleteBtn);
        sidebarDiv.appendChild(quizDiv);
    });
}

/***************************************************************
 *  POPUP (SAVE NAME)
 ***************************************************************/
function showPopup() {
    document.getElementById("popupOverlay").classList.add("show");
    document.getElementById("popup").classList.add("show");
    document.getElementById("nameInput").focus();
}

function closePopup() {
    document.getElementById("popup").classList.remove("show");
    document.getElementById("popupOverlay").classList.remove("show");
}

function submitName() {
    const name = document.getElementById("nameInput").value;
    document.getElementById("nameInput").value = "";
    closePopup();
    savePageState(name);
}

/***************************************************************
 *  SAVE/LOAD PAGE STATE
 ***************************************************************/
function savePageState(name) {
    try {
        const testObj = buildSavedTestObject(name);
        saveTestObject(testObj);
        getOptions();
        document.getElementById("mainButton").innerText = "Saved!";
    } catch (e) {
        console.error("Save failed:", e);
        alert("Save failed. Storage might be full.");
    }
}

function loadPageState(id) {
    const obj = loadTestById(id);
    if (!obj) {
        alert("Could not load that save.");
        return;
    }

    // Restore config
    state.config.mcqCount = obj.config?.mcqCount ?? 0;
    state.config.choicesPerQuestion = obj.config?.choicesPerQuestion ?? 2;
    state.config.saqCount = obj.config?.saqCount ?? 0;
    state.config.saqMaxScore = obj.config?.saqMaxScore ?? 4;
    syncCountersToUI();

    // Restore metadata & test
    state.pdf.name = obj.meta?.pdfName ?? null;
    state.test.questions = obj.questions ?? { mcq: [], saq: [] };
    state.test.answers = obj.answers ?? { mcqSelectedIndex: [], saqText: [] };
    state.test.marking = obj.marking ?? null;

    // Mode depends on whether it was marked
    if (state.test.marking && state.test.marking.status === "marked") {
        state.mode = "marked";
    } else {
        state.mode = "taking";
    }

    hideError();

    // Render and apply marking if needed
    renderQuestions();
    applyMarkingToUI();

    closeSidebar();
}

/***************************************************************
 *  MAIN FORM SUBMIT HANDLER
 ***************************************************************/
async function handleSubmit(event) {
    event.preventDefault();

    const mainButton = document.getElementById("mainButton");
    if (mainButton.disabled) {
        return;
    }

    hideError();

    if (state.mode === "setup") {
        if (!fileUploaded || !state.pdf.extractedText) {
            showError("Please upload a PDF file before generating questions.");
            return;
        }
        if (state.config.mcqCount === 0 && state.config.saqCount === 0) {
            showError("Please select at least 1 question to generate.");
            return;
        }
    }

    if (state.mode === "marked") {
        showPopup();
        return;
    }

    mainButton.disabled = true;
    mainButton.innerText = "Loading...";

    try {
        if (state.mode === "setup") {
            await generateQuestionsFromPDF();
            renderQuestions();
            return;
        }

        if (state.mode === "taking") {
            await markTest();
            renderQuestions();       // re-render to ensure clean base
            applyMarkingToUI();      // then apply ticks/feedback

            if (typeof JSConfetti !== "undefined") {
                if (!jsConfettiInstance) {
                    jsConfettiInstance = new JSConfetti();
                }
                jsConfettiInstance.addConfetti();
            }
            return;
        }
    } catch (e) {
        console.error(e);
        showError(e.message || "Something went wrong.");
    } finally {
        mainButton.disabled = false;
        updateMainButtonText();
    }
}

/***************************************************************
 *  INIT
 ***************************************************************/
document.getElementById("nameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        submitName();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closePopup();
        closeAllSidebars();
    }
});

// Make counters display correct initial values
syncCountersToUI();

// Load sidebar options on startup
getOptions();
