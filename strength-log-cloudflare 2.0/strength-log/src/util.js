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

// Calls the Anthropic Messages API directly (no SDK needed in a Worker).
export async function claude(env, payload) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("anthropic error", res.status, t.slice(0, 300));
    const e = new Error("anthropic " + res.status);
    e.status = res.status;
    throw e;
  }
  return res.json();
}
export const NO_KEY = "AI features need an ANTHROPIC_API_KEY secret set on the Worker.";
