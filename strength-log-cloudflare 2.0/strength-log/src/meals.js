import { json, bad, DEV_RE, DAY_RE, num, round1, parseJ, claude, NO_KEY } from "./util.js";

const MODEL = "claude-sonnet-5-5";
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_IMAGES = 4;
const KEY_RE = /^[0-9a-f-]{36}$/;

const mealOut = (r) => ({
  id: r.id, day: r.day, name: r.name, kind: r.kind, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber,
  items: parseJ(r.items), note: r.note, photoKey: r.photo_key, photoKeys: parseJ(r.photo_keys), eatenAt: r.eaten_at, createdAt: r.created_at,
});
const labelOut = (r) => ({
  id: r.id, name: r.name, serving: r.serving, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber,
  photoKey: r.photo_key, uses: r.uses, usedAt: r.used_at, createdAt: r.created_at,
});

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  if (Math.floor((m[2].length * 3) / 4) > MAX_IMAGE_BYTES) return null;
  return { mediaType: m[1], data: m[2] };
}
function imageList(body) {
  const raw = Array.isArray(body?.images) ? body.images : body?.image ? [body.image] : [];
  if (raw.length > MAX_IMAGES) return null;
  const out = raw.map(parseDataUrl);
  return out.every(Boolean) ? out : null;
}
const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const MACRO_TOOL = {
  name: "report_macros",
  description: "Report the estimated nutrition for the food shown or described.",
  input_schema: {
    type: "object",
    properties: {
      is_food: { type: "boolean", description: "False if the image contains no food, drink or nutrition label." },
      kind: { type: "string", enum: ["meal", "label"], description: "'label' if the image is a nutrition facts label / packaging, otherwise 'meal'." },
      name: { type: "string", description: "Short, friendly name for the meal, e.g. 'Chicken burrito bowl' (max 40 chars)." },
      items: {
        type: "array",
        description: "Each distinct food component with estimated portion and macros. For a label, a single item for one serving.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            amount: { type: "string", description: "Estimated portion, e.g. '150 g' or '1 cup'." },
            kcal: { type: "number" }, protein: { type: "number" }, carbs: { type: "number" }, fat: { type: "number" },
          },
          required: ["name", "kcal", "protein", "carbs", "fat"],
        },
      },
      kcal: { type: "number", description: "Total calories (for a label: per one serving)." },
      protein: { type: "number", description: "Total protein in grams." },
      carbs: { type: "number", description: "Total carbohydrates in grams." },
      fat: { type: "number", description: "Total fat in grams." },
      fiber: { type: "number", description: "Total fiber in grams, if known." },
      serving: { type: "string", description: "For labels: the serving size printed, e.g. '2/3 cup (55g)'." },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      tip: { type: "string", description: "One short sentence about assumptions made (portion size, hidden oils, etc.)." },
    },
    required: ["is_food", "kind", "name", "items", "kcal", "protein", "carbs", "fat", "confidence"],
  },
};

const SYSTEM = `You are a sports nutritionist estimating macronutrients for a fitness tracking app.
- For a photo of a meal: identify each component, estimate realistic portion sizes from visual cues (plate size, utensils, hands), include likely cooking oils, sauces and dressings, then sum the totals.
- For a nutrition facts label or packaging: read the values exactly as printed for ONE serving and report the serving size. Do not estimate when the numbers are legible.
- If several photos are given they all belong to ONE meal: e.g. different angles of the same plate, several dishes eaten together, or a meal plus the nutrition label of a packaged item in it. Combine them into one total without double counting food that appears in more than one photo. When a legible label covers an item, use the label's numbers for that item. Use kind 'label' only when the photos are just a packaged product and its label.
- If the user adds a note (e.g. "half portion", "no rice", "2 servings"), apply it to the totals.
- Totals must equal the sum of items. Calories should roughly match 4*protein + 4*carbs + 9*fat.
- Always call the report_macros tool.`;

async function analyze(req, env) {
  if (!env.ANTHROPIC_API_KEY) return bad(NO_KEY, 503);
  const body = await req.json().catch(() => null);
  if (!body) return bad("Invalid request");
  const note = typeof body.note === "string" ? body.note.slice(0, 300).trim() : "";
  const imgs = imageList(body);
  if (!imgs) return bad(`Couldn't read those photos. Use up to ${MAX_IMAGES} JPEG or PNG images.`);
  if (!imgs.length && !note) return bad("Add a photo or describe what you ate.");

  const content = [];
  imgs.forEach((img, i) => {
    if (imgs.length > 1) content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  });
  const what = imgs.length > 1 ? `these ${imgs.length} photos of one meal` : "this food";
  content.push({
    type: "text",
    text: imgs.length
      ? `Estimate the macros for ${what}.${note ? " User note: " + note : ""}`
      : `Estimate the macros for this meal described by the user: ${note}`,
  });

  try {
    const msg = await claude(env, {
      model: MODEL, max_tokens: 1500, system: SYSTEM, tools: [MACRO_TOOL], tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    });
    const tool = (msg.content || []).find((b) => b.type === "tool_use");
    if (!tool) return bad("Couldn't estimate this one. Try another photo.", 502);
    const r = tool.input || {};
    if (r.is_food === false) return bad("No food or nutrition label found in that photo.", 422);
    const items = Array.isArray(r.items)
      ? r.items.slice(0, 20).map((i) => ({
          name: String(i.name ?? "").slice(0, 60),
          amount: i.amount ? String(i.amount).slice(0, 40) : undefined,
          kcal: Math.round(num(i.kcal)), protein: round1(num(i.protein)), carbs: round1(num(i.carbs)), fat: round1(num(i.fat)),
        }))
      : [];
    return json({
      kind: r.kind === "label" ? "label" : "meal",
      name: String(r.name ?? "Meal").slice(0, 60),
      items,
      kcal: Math.round(num(r.kcal)), protein: round1(num(r.protein)), carbs: round1(num(r.carbs)), fat: round1(num(r.fat)),
      fiber: r.fiber != null ? round1(num(r.fiber)) : null,
      serving: r.serving ? String(r.serving).slice(0, 60) : null,
      confidence: ["low", "medium", "high"].includes(r.confidence) ? r.confidence : "medium",
      tip: r.tip ? String(r.tip).slice(0, 200) : null,
    });
  } catch (e) {
    console.error("analyze failed", e?.status, e?.message);
    if (e?.status === 429) return bad("The AI is busy right now. Try again in a minute.", 429);
    return bad("Couldn't reach the AI. Try again.", 502);
  }
}

// Photos can be shared between a meal and a saved label, so only delete one once nothing points at it.
async function dropPhotoIfUnused(env, device, key) {
  const m = await env.DB.prepare(
    "SELECT id FROM meals WHERE device_id = ? AND (photo_key = ? OR EXISTS (SELECT 1 FROM json_each(meals.photo_keys) WHERE value = ?)) LIMIT 1",
  ).bind(device, key, key).first();
  const l = await env.DB.prepare("SELECT id FROM saved_labels WHERE device_id = ? AND photo_key = ? LIMIT 1").bind(device, key).first();
  if (!m && !l) await env.PHOTOS.delete(key).catch(() => {});
}

async function rememberLabel(env, device, l, photoKey) {
  const name = String(l.name || "").trim().slice(0, 60);
  if (!name) return;
  const v = {
    serving: l.serving ? String(l.serving).slice(0, 60) : null,
    kcal: Math.round(num(l.kcal)), protein: round1(num(l.protein)), carbs: round1(num(l.carbs)), fat: round1(num(l.fat)),
    fiber: l.fiber != null && l.fiber !== "" ? round1(num(l.fiber)) : null,
  };
  const id = Number(l.id);
  const hit = Number.isInteger(id) && id > 0
    ? await env.DB.prepare("SELECT * FROM saved_labels WHERE device_id = ? AND id = ? LIMIT 1").bind(device, id).first()
    : await env.DB.prepare("SELECT * FROM saved_labels WHERE device_id = ? AND lower(name) = lower(?) LIMIT 1").bind(device, name).first();
  const now = new Date().toISOString();
  if (hit) {
    await env.DB.prepare(
      "UPDATE saved_labels SET name = ?, serving = ?, kcal = ?, protein = ?, carbs = ?, fat = ?, fiber = ?, photo_key = ?, uses = ?, used_at = ? WHERE id = ?",
    ).bind(name, v.serving, v.kcal, v.protein, v.carbs, v.fat, v.fiber, photoKey ?? hit.photo_key, hit.uses + 1, now, hit.id).run();
    if (hit.photo_key && photoKey && hit.photo_key !== photoKey) await dropPhotoIfUnused(env, device, hit.photo_key);
  } else {
    await env.DB.prepare(
      "INSERT INTO saved_labels (device_id, name, serving, kcal, protein, carbs, fat, fiber, photo_key, uses, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
    ).bind(device, name, v.serving, v.kcal, v.protein, v.carbs, v.fat, v.fiber, photoKey, now, now).run();
  }
}

async function labels(req, env, device, idPart) {
  if (!idPart && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM saved_labels WHERE device_id = ? ORDER BY used_at DESC LIMIT 200").bind(device).all();
    return json(results.map(labelOut));
  }
  if (idPart && req.method === "DELETE") {
    const id = Number(idPart);
    if (!Number.isInteger(id)) return bad("Invalid id");
    const row = await env.DB.prepare("DELETE FROM saved_labels WHERE id = ? AND device_id = ? RETURNING *").bind(id, device).first();
    if (!row) return bad("Not found", 404);
    if (row.photo_key) await dropPhotoIfUnused(env, device, row.photo_key);
    return json({ ok: true });
  }
  return bad("Not found", 404);
}

export async function handleMeals(req, env) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/meals\/?/, "").split("/").filter(Boolean);

  // Public photo route: keys are unguessable UUIDs.
  if (parts[0] === "photo" && parts[1] && req.method === "GET") {
    if (!KEY_RE.test(parts[1])) return new Response("Not found", { status: 404 });
    const obj = await env.PHOTOS.get(parts[1]);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  }

  const device = req.headers.get("x-device-id") ?? "";
  if (!DEV_RE.test(device)) return bad("Missing device id", 401);

  if (parts[0] === "labels") return labels(req, env, device, parts[1]);

  if (parts[0] === "analyze") {
    if (req.method !== "POST") return bad("Method not allowed", 405);
    return analyze(req, env);
  }

  if (parts.length === 0 && req.method === "GET") {
    const from = url.searchParams.get("from") ?? url.searchParams.get("day") ?? "";
    const to = url.searchParams.get("to") ?? from;
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) return bad("Invalid day");
    const { results } = await env.DB.prepare(
      "SELECT * FROM meals WHERE device_id = ? AND day >= ? AND day <= ? ORDER BY eaten_at ASC, id ASC",
    ).bind(device, from, to).all();
    return json(results.map(mealOut));
  }

  if (parts.length === 0 && req.method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || !DAY_RE.test(b.day)) return bad("Invalid meal");
    const keys = [];
    for (const img of imageList(b) ?? []) {
      const key = crypto.randomUUID();
      await env.PHOTOS.put(key, b64ToBytes(img.data), { httpMetadata: { contentType: img.mediaType }, customMetadata: { device } });
      keys.push(key);
    }
    // Re-logging a saved label can reuse its stored photo.
    if (!keys.length && typeof b.photoKey === "string" && KEY_RE.test(b.photoKey)) keys.push(b.photoKey);
    const photoKey = keys[0] ?? null;
    const now = new Date().toISOString();
    const row = await env.DB.prepare(
      "INSERT INTO meals (device_id, day, name, kind, kcal, protein, carbs, fat, fiber, items, note, photo_key, photo_keys, eaten_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    ).bind(
      device, b.day, String(b.name || "Meal").slice(0, 60),
      ["meal", "label", "manual"].includes(b.kind) ? b.kind : "meal",
      Math.round(num(b.kcal)), round1(num(b.protein)), round1(num(b.carbs)), round1(num(b.fat)),
      b.fiber != null && b.fiber !== "" ? round1(num(b.fiber)) : null,
      Array.isArray(b.items) ? JSON.stringify(b.items.slice(0, 20)) : null,
      b.note ? String(b.note).slice(0, 300) : null,
      photoKey, keys.length ? JSON.stringify(keys) : null, now, now,
    ).first();
    if (row.kind === "label" && b.saveLabel && typeof b.saveLabel === "object") {
      await rememberLabel(env, device, b.saveLabel, photoKey).catch((e) => console.error("save label failed", e?.message));
    }
    return json(mealOut(row), 201);
  }

  if (parts.length === 1 && req.method === "DELETE") {
    const id = Number(parts[0]);
    if (!Number.isInteger(id)) return bad("Invalid id");
    const row = await env.DB.prepare("DELETE FROM meals WHERE id = ? AND device_id = ? RETURNING *").bind(id, device).first();
    if (!row) return bad("Not found", 404);
    const ks = parseJ(row.photo_keys) ?? (row.photo_key ? [row.photo_key] : []);
    for (const k of ks) await dropPhotoIfUnused(env, device, k);
    return json({ ok: true });
  }

  return bad("Not found", 404);
}
