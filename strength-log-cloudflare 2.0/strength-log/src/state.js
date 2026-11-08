import { json, bad, DEV_RE } from "./util.js";

// D1 limits a single row to roughly 2 MB, so the cap sits just under that.
const MAX_BYTES = 1_900_000;
const hasData = (d) =>
  !!d && ((Array.isArray(d.hist) && d.hist.length > 0) || (Array.isArray(d.routines) && d.routines.length > 0) || !!d.active);

export async function handleState(req, env) {
  const device = req.headers.get("x-device-id") ?? "";
  if (!DEV_RE.test(device)) return bad("Missing device id", 401);
  const getRow = () => env.DB.prepare("SELECT data, updated_at FROM app_state WHERE device_id = ?").bind(device).first();

  if (req.method === "GET") {
    const row = await getRow();
    return json(row ? { data: JSON.parse(row.data), updatedAt: row.updated_at } : { data: null });
  }

  if (req.method === "PUT") {
    const text = await req.text();
    if (text.length > MAX_BYTES) return bad("Backup is too large", 413);
    let body;
    try { body = JSON.parse(text); } catch { return bad("Invalid JSON"); }
    const data = body?.data;
    if (!data || typeof data !== "object" || !Array.isArray(data.ex) || !Array.isArray(data.hist)) return bad("Invalid data");

    // Never let an empty, freshly-started app overwrite a backup that has workouts in it
    // unless the user explicitly asked for it.
    if (!body.force && !hasData(data)) {
      const row = await getRow();
      if (row) {
        const old = JSON.parse(row.data);
        if (hasData(old)) return json({ ok: false, conflict: true, data: old, updatedAt: row.updated_at }, 409);
      }
    }
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO app_state (device_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    ).bind(device, JSON.stringify(data), now).run();
    return json({ ok: true, updatedAt: now });
  }
  return bad("Method not allowed", 405);
}
