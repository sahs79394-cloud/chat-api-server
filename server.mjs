import { createServer } from "node:http";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function callOpenAI(messages, stream = false) {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, stream, max_completion_tokens: 8192 }),
  });
  return response;
}

// Handles simple chat: POST body { message, history? } → SSE stream OR JSON
async function handleSimpleChat(req, res, body) {
  const { message, history = [], stream = false } = body;
  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message field is required" }));
    return;
  }
  const messages = [
    ...history.map((h) => ({ role: h.role || "user", content: h.content })),
    { role: "user", content: message },
  ];

  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const oaiRes = await callOpenAI(messages, true);
    if (!oaiRes.ok) {
      res.write(`data: ${JSON.stringify({ error: await oaiRes.text() })}\n\n`);
      res.end(); return;
    }
    const reader = oaiRes.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.delta?.content;
          if (content) { fullContent += content; res.write(`data: ${JSON.stringify({ content })}\n\n`); }
        } catch {}
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } else {
    // Non-streaming: return full JSON response
    const oaiRes = await callOpenAI(messages, false);
    if (!oaiRes.ok) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: await oaiRes.text() })); return;
    }
    const data = await oaiRes.json();
    const reply = data.choices?.[0]?.message?.content || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ reply, content: reply, message: reply, choices: data.choices }));
  }
}

// Handles OpenAI-compatible: POST /v1/chat/completions with { messages, stream? }
async function handleOpenAICompat(req, res, body) {
  const { messages = [], stream = false } = body;
  if (!messages.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "messages array is required" }));
    return;
  }
  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    const oaiRes = await callOpenAI(messages, true);
    if (!oaiRes.ok) {
      res.write(`data: ${JSON.stringify({ error: await oaiRes.text() })}\n\n`); res.end(); return;
    }
    const reader = oaiRes.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } else {
    const oaiRes = await callOpenAI(messages, false);
    const data = await oaiRes.json();
    res.writeHead(oaiRes.ok ? 200 : 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check
  if ((path === "/" || path === "/api/healthz" || path === "/health") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", model: MODEL, apiKeySet: !!OPENAI_API_KEY }));
    return;
  }

  // Info page (GET on any chat path)
  if (req.method === "GET" && ["/api/chat", "/chat", "/v1/chat/completions"].includes(path)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      info: "Chat API server is running",
      usage: "POST /api/chat with { message: 'your text', stream: false }",
      endpoints: ["/api/chat", "/chat", "/v1/chat/completions"],
      apiKeySet: !!OPENAI_API_KEY,
    }));
    return;
  }

  // Chat endpoints (simple format)
  if (req.method === "POST" && ["/api/chat", "/chat", "/message", "/api/message"].includes(path)) {
    if (!OPENAI_API_KEY) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "OPENAI_API_KEY environment variable is not set. Please set it in Railway environment variables." }));
      return;
    }
    try {
      const body = await readBody(req);
      await handleSimpleChat(req, res, body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // OpenAI-compatible endpoint
  if (req.method === "POST" && path === "/v1/chat/completions") {
    if (!OPENAI_API_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "OPENAI_API_KEY not set" }));
      return;
    }
    try {
      const body = await readBody(req);
      await handleOpenAICompat(req, res, body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", availableEndpoints: ["/api/chat", "/chat", "/v1/chat/completions", "/api/healthz"] }));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`API key set: ${OPENAI_API_KEY ? "yes" : "no"}`);
});
