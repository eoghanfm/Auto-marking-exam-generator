# AI Auto-Marking Exam Generator

A web app that turns lecture slides and study notes (PDFs) into customizable practice exams with instant multiple-choice grading and AI-powered short-answer feedback.

🔗 **[Live Demo](https://your-vercel-url.vercel.app)**

![AI Auto-Marking Exam Generator Preview](assets/preview.png)

## Features
- **Client-Side PDF Parsing:** Extracts text directly in the browser using `pdf.js` so files never need to be uploaded to a storage server.
- **Configurable Exam Mix:** Choose the number of multiple-choice questions, choices per question, and short-answer questions.
- **Automated Grading & Feedback:** Instant scoring for MCQs and rubric-style AI feedback (out of 4 marks) for short-answer responses, enforced via OpenAI structured JSON outputs (`gpt-4.1-mini`).
- **Saved Exams:** Persist and reload past exams and results in `localStorage` without requiring user accounts.
- **Secure Key Handling:** Routes requests through a Vercel serverless proxy (`/api/openai`) with origin checks and token caps, while allowing optional BYOK overrides in Settings.

## Tech Stack
- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES6+), `pdf.js`
- **Backend / Hosting:** Vercel Serverless Functions (`/api/openai`), OpenAI Chat Completions API

## Running Locally
1. Clone the repository and open `index.html` in your browser.
2. Open the **Settings** drawer (top right) and paste your own OpenAI API key (stored locally in `localStorage`), or run `npx vercel dev` with `OPENAI_API_KEY` set in a `.env` file.
