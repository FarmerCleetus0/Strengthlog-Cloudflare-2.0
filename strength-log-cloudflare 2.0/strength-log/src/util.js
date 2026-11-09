export const json = (data, status = 200) => Response.json(data, { status });
export const bad = (msg, status = 400) => json({ error: msg }, status);
export const DEV_RE = /^[A-Za-z0-9-]{16,64}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const num = (v, max = 100000) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
};
export const round1 = (n) => Math.round(n * 10) / 10;
export const parseJ = (v) => {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
};

// ---- AI provider layer -------------------------------------------------------------
// Default: Cloudflare Workers AI through the `AI` binding (no API key to create or store).
// Optional upgrade: if an ANTHROPIC_API_KEY secret exists, Claude is used instead.
const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"; // vision + JSON-schema output; override with an AI_MODEL variable
export const hasAI = (env) => !!(env.ANTHROPIC_API_KEY || env.AI);
export const NO_KEY = "AI features aren't set up yet. Add the Workers AI binding (see the README).";

function parseLoose(t) {
  t = t.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const i = t.indexOf("{"), k = t.lastIndexOf("}");
  if (i >= 0 && k > i) { try { return JSON.parse(t.slice(i, k + 1)); } catch { /* ignore */ } }
  return null;
}
// Workers AI can return the structured result in a few shapes depending on model and options.
function pickResult(out) {
  const cands = [out?.response, out?.result?.response, out?.choices?.[0]?.message?.content];
  for (const c of cands) {
    if (c && typeof c === "object" && !Array.isArray(c)) return c;
    if (typeof c === "string") { const j = parseLoose(c); if (j && typeof j === "object") return j; }
  }
  return null;
}

async function viaWorkersAi(env, { system, content, schema, maxTokens }) {
  const hasImage = content.some((p) => p.type === "image");
  const user = hasImage
    ? content.map((p) => p.type === "image"
        ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
        : { type: "text", text: p.text })
    : content.map((p) => p.text).join("\n");
  const sys = system + "\n\nReturn ONLY a JSON object that matches this JSON Schema, with no other text:\n" + JSON.stringify(schema);
  try {
    const out = await env.AI.run(env.AI_MODEL || WORKERS_AI_MODEL, {
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      max_tokens: maxTokens,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: schema },
    });
    return pickResult(out);
  } catch (e) {
    const err = new Error(String(e?.message ?? e));
    err.status = /capacity|rate|limit|too many|quota|neuron/i.test(err.message) ? 429 : 502;
    console.error("workers ai error", err.message.slice(0, 300));
    throw err;
  }
}

async function viaClaude(env, { claudeModel, system, content, schema, toolName, toolDescription, maxTokens, force }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: claudeModel, max_tokens: maxTokens, system,
      tools: [{ name: toolName, description: toolDescription, input_schema: schema }],
      tool_choice: force ? { type: "tool", name: toolName } : { type: "auto" },
      messages: [{ role: "user", content: content.map((p) => p.type === "image"
        ? { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } }
        : { type: "text", text: p.text }) }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("anthropic error", res.status, t.slice(0, 300));
    const e = new Error("anthropic " + res.status);
    e.status = res.status;
    throw e;
  }
  const msg = await res.json();
  return (msg.content || []).find((b) => b.type === "tool_use")?.input ?? null;
}

// content: [{type:"text",text} | {type:"image",mediaType,data(base64)}]. Returns the parsed object, or null.
export function askJSON(env, opts) {
  return env.ANTHROPIC_API_KEY ? viaClaude(env, opts) : viaWorkersAi(env, opts);
}
