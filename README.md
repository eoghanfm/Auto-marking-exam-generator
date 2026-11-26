# AI Auto-Marking Exam Generator

A lightweight, client-side web application that turns PDF lecture notes into custom university-level practice exams—complete with multiple-choice and short-answer questions—and automatically marks your answers with AI-powered feedback.

## Key Features

- **PDF Text Extraction**: Extracts text directly in the browser from uploaded PDF files using PDF.js.
- **Customizable Exam Generation**: Choose the exact number of multiple-choice questions (MCQs), answer choices per MCQ, and short-answer questions (SAQs).
- **Automated Marking & Feedback**:
  - MCQs are graded locally with instant visual indicators (`✔` / `✘`) and section scores.
  - SAQs are graded in a single batch via OpenAI (`gpt-4o-mini` by default to keep API costs minimal) with per-question scores and constructive feedback.
- **Save & Reload Tests**: Save completed tests under custom names in `localStorage`, revisit marked results anytime from the Saved Tests drawer, or delete old saves.
- **Zero Build Step**: Pure vanilla HTML, CSS, and JavaScript—no frameworks, bundlers, or backend server required.

## Tech Stack

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+)
- **PDF Parsing**: [PDF.js](https://mozilla.github.io/pdf.js/) (`3.4.120` via CDN)
- **AI Generation & Marking**: [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) (`gpt-4o-mini`, JSON mode)
- **Celebration Effects**: [js-confetti](https://github.com/loonywizard/js-confetti) (via CDN)
- **Storage**: Browser `localStorage`

## Project Structure

```text
.
├── index.html      # Main page layout, drawers, and form markup
├── styles.css      # Application styling
├── app.js          # App state, PDF extraction, OpenAI calls, marking, storage, and UI logic
├── .gitignore      # Ignores *.txt files (e.g. local API key files)
└── README.md       # Project documentation
```

## Running Locally

1. **Clone or download** this repository.
2. **Open the app**:
   - Double-click `index.html` to open it directly in your browser, **or**
   - Serve the folder with any static file server (recommended):
     ```bash
     python -m http.server 8000
     ```
     Then visit `http://localhost:8000`.
3. **Add your OpenAI API key**:
   - Click the **Settings (`⚙️`)** icon in the top-right corner.
   - Paste your OpenAI API key (`sk-...`) and click **Save Key**.
   - Your key is stored locally in your browser's `localStorage` and is only sent directly to the OpenAI API.
4. **Generate & take an exam**:
   - Click **Upload PDF** and select a text-based PDF (lecture slides, notes, or readings).
   - Adjust the MCQ and SAQ counters, then click **Generate Questions**.
   - Answer the questions and click **Submit Answers** to mark your test.
   - Click **Save** to store your marked exam and view it later in the **Saved Tests (`☰`)** drawer.

> **Note:** Because API requests are made directly from the browser, this project is intended for local/personal use. Do not hardcode or commit API keys to version control.
