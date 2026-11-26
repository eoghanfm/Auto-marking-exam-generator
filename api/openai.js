const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const ENFORCED_MODEL = "gpt-4.1-mini";
const MAX_TOKENS = 2500;

function isAllowedOrigin(originOrReferer) {
    if (!originOrReferer) {
        return false;
    }

    try {
        const { protocol, hostname } = new URL(originOrReferer);
        if (protocol !== "http:" && protocol !== "https:") {
            return false;
        }

        return (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            (hostname.endsWith(".vercel.app") && hostname.length > ".vercel.app".length)
        );
    } catch {
        return false;
    }
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return res.status(405).json({
            error: { message: "Method not allowed. Use POST." }
        });
    }

    const requestOrigin = req.headers.origin || req.headers.referer || "";
    if (!isAllowedOrigin(requestOrigin)) {
        return res.status(403).json({
            error: { message: "Forbidden: requests are only allowed from localhost or .vercel.app domains." }
        });
    }

    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
        return res.status(500).json({
            error: { message: "Server misconfiguration: OPENAI_API_KEY environment variable is not set." }
        });
    }

    let body = req.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return res.status(400).json({
                error: { message: "Invalid JSON request body." }
            });
        }
    }

    const { messages, response_format } = body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: { message: "Request body must include a non-empty messages array." }
        });
    }

    const payload = {
        model: ENFORCED_MODEL,
        messages,
        max_tokens: MAX_TOKENS
    };

    if (response_format && typeof response_format === "object") {
        payload.response_format = response_format;
    }

    try {
        const upstream = await fetch(OPENAI_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });

        const rawText = await upstream.text();
        let data;
        try {
            data = JSON.parse(rawText);
        } catch {
            data = { error: { message: rawText || "Unexpected non-JSON response from OpenAI." } };
        }

        return res.status(upstream.status).json(data);
    } catch (err) {
        console.error("Error forwarding request to OpenAI:", err);
        return res.status(502).json({
            error: { message: "Failed to reach OpenAI API from proxy server." }
        });
    }
}
