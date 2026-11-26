# AI Auto-Marking Exam Generator

A lightweight web application that turns PDF lecture notes into custom university-level practice exams—complete with multiple-choice and short-answer questions—and automatically marks your answers with AI-powered feedback.

## Key Features

- **PDF Text Extraction**: Extracts text directly in the browser from uploaded PDF files using PDF.js.
- **Customizable Exam Generation**: Choose the exact number of multiple-choice questions (MCQs), answer choices per MCQ, and short-answer questions (SAQs).
- **Automated Marking & Feedback**:
  - MCQs are graded locally with instant visual indicators (`✔` / `✘`) and section scores.
  - SAQs are graded in a single batch via OpenAI (`gpt-4o-mini`) with per-question scores and constructive feedback.
- **Serverless API Proxy + Optional Key Override**: Requests go through `/api/openai` by default so your OpenAI API key stays hidden on the server, while users can still optionally supply their own key in the Settings drawer.
- **Save & Reload Tests**: Save completed tests under custom names in `localStorage`, revisit marked results anytime from the Saved Tests drawer, or delete old saves.
- **Zero Build Step**: Pure vanilla HTML, CSS, and JavaScript—no frontend frameworks or bundlers required.

## Tech Stack

- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+)
- **Backend Proxy**: Vercel Node.js Serverless Function (`api/openai.js`)
- **PDF Parsing**: [PDF.js](https://mozilla.github.io/pdf.js/) (`3.4.120` via CDN)
- **AI Generation & Marking**: [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) (`gpt-4o-mini`, JSON mode)
- **Celebration Effects**: [js-confetti](https://github.com/loonywizard/js-confetti) (via CDN)
- **Storage**: Browser `localStorage`

## Project Structure

```text
.
├── api/
│   └── openai.js   # Vercel serverless proxy (keeps OPENAI_API_KEY secret on the server)
├── index.html      # Main page layout, drawers, and form markup
├── styles.css      # Application styling
├── app.js          # App state, PDF extraction, OpenAI calls, marking, storage, and UI logic
├── .gitignore      # Ignores *.txt, .env files, and .vercel
└── README.md       # Project documentation
```

## Serverless Proxy Architecture

By default, the browser never sees your OpenAI API key:

1. `app.js` sends `POST /api/openai` with `{ messages, response_format }` and **no** `Authorization` header.
2. `api/openai.js` validates that:
   - The HTTP method is `POST` (returns `405` otherwise).
   - The `Origin` / `Referer` header is from `localhost` or a `*.vercel.app` domain (returns `403` otherwise).
   - `process.env.OPENAI_API_KEY` is configured (returns `500` otherwise).
3. The proxy forwards the request to `https://api.openai.com/v1/chat/completions` using a server-enforced model (`gpt-4o-mini`) and `max_tokens` cap (`2500`), then returns OpenAI's status code and JSON response.
4. **Optional User Override**: If a user enters their own OpenAI API key in **Settings (`⚙️`)**, `app.js` saves it to `localStorage` and calls OpenAI directly using that key. Clearing the key automatically falls back to `/api/openai`.

## Deploying on Vercel

1. Push this repository to GitHub (or import it directly into [Vercel](https://vercel.com)).
2. In your Vercel project dashboard, go to **Settings → Environment Variables**.
3. Add a new environment variable:
   - **Name**: `OPENAI_API_KEY`
   - **Value**: your OpenAI secret key (`sk-...`)
   - **Environments**: Production, Preview (and Development if desired)
4. Deploy (or redeploy after adding the variable). Vercel automatically serves `index.html` at `/` and maps `api/openai.js` to `/api/openai`.

## Running Locally

### Option 1: With the Serverless Proxy (`vercel dev`)
1. Install the [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`).
2. Create a `.env` file in the project root (ignored by git):
   ```env
   OPENAI_API_KEY=sk-your-openai-key-here
   ```
3. Start the local dev server:
   ```bash
   vercel dev
   ```
4. Open the local URL printed by Vercel (typically `http://localhost:3000`). Requests will route through `/api/openai` automatically.

### Option 2: Static File Server + Custom API Key
If you don't use Vercel locally, you can still open `index.html` or run any static server (e.g., `python -m http.server 8000`), then open **Settings (`⚙️`)** and save an OpenAI API key in your browser to call OpenAI directly.
