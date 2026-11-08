import { json, bad, DEV_RE, claude, NO_KEY } from "./util.js";

const MODEL = "claude-sonnet-5-5";
const GROUPS = ["Chest", "Front delts", "Side delts", "Rear delts", "Traps", "Lats", "Lower back", "Biceps", "Triceps", "Brachialis", "Forearms", "Abs", "Obliques", "Quads", "Hamstrings", "Glutes", "Adductors", "Calves"];

const TOOL = {
  name: "report_muscles",
  description: "Report the muscle groups trained by each exercise.",
  input_schema: {
    type: "object",
    properties: {
      exercises: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exercise name exactly as given" },
            primary: { type: "array", items: { type: "string", enum: GROUPS }, description: "Main muscles doing the work (usually 1-2)" },
            secondary: { type: "array", items: { type: "string", enum: GROUPS }, description: "Meaningful assisting muscles (0-3)" },
          },
          required: ["name", "primary", "secondary"],
        },
      },
    },
    required: ["exercises"],
  },
};

const SYSTEM = `You are an exercise scientist. For each gym exercise name, list which of these muscle groups it trains: ${GROUPS.join(", ")}.
Base every answer on EMG and biomechanics research and on the exact variation named (grip, stance, angle, equipment), not just the movement family.
"primary" = the muscles with the highest activation, acting as the main agonists (usually 1-3). "secondary" = muscles that assist with meaningful activation (0-4). Leave out muscles that only stabilise lightly.
Conventions: Lats covers the lats and mid-back (rhomboids, teres major); Traps covers upper, middle and lower trapezius; Lower back means the spinal erectors; Forearms includes the wrist flexors/extensors and brachioradialis. Pick the specific delt head(s): presses mostly hit Front delts, lateral raises Side delts, reverse flyes, face pulls and rows Rear delts. Obliques cover rotation, side bends and anti-rotation work.
Variation rules the research supports:
- Chin-ups (palms toward you) load the biceps and pecs more than overhand pull-ups; the lats are highly active in both.
- Conventional deadlift: glutes, hamstrings and spinal erectors, with a substantial quadriceps contribution. Sumo and trap-bar deadlifts shift toward the quads (sumo also the adductors) and the trap bar lowers erector demand. Romanian and stiff-leg deadlifts shift toward hamstrings, glutes and erectors with little quad work.
- Barbell back/front squats: quads, glutes and adductors, with the erectors working isometrically. Hack/machine squats and the leg press take the erectors out.
- Rows: lats and mid-back (traps) are both highly active; barbell and bent-over rows also load the erectors isometrically, chest-supported and seated rows do not. Upright rows work the traps and side delts, not the lats.
- Neutral-grip (hammer) and pronated (reverse) curls shift work to the brachialis and brachioradialis (Forearms); supinated curls emphasise the biceps.
- Hip abduction trains the glutes only; hip thrusts and bridges train mainly the glutes.
- Close-grip bench press loads the triceps as much as the chest.
If a name is unclear or not an exercise, give your best guess from the words; return empty arrays only if it clearly isn't a resistance or bodyweight exercise.
Always call report_muscles once with every exercise.`;

export async function handleMuscles(req, env) {
  if (req.method !== "POST") return bad("Not found", 404);
  const device = req.headers.get("x-device-id") ?? "";
  if (!DEV_RE.test(device)) return bad("Missing device id", 401);
  if (!env.ANTHROPIC_API_KEY) return bad(NO_KEY, 503);
  const body = await req.json().catch(() => null);
  const names = Array.isArray(body?.names)
    ? [...new Set(body.names.filter((n) => typeof n === "string").map((n) => n.trim().slice(0, 80)).filter(Boolean))].slice(0, 40)
    : [];
  if (!names.length) return bad("No exercises");

  try {
    const msg = await claude(env, {
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "report_muscles" },
      messages: [{ role: "user", content: "Exercises:\n" + names.map((n) => "- " + n).join("\n") }],
    });
    const tool = (msg.content || []).find((b) => b.type === "tool_use");
    const list = tool?.input?.exercises;
    if (!Array.isArray(list)) return bad("Couldn't work out the muscles. Try again.", 502);
    const valid = new Set(GROUPS);
    const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
    const map = {};
    for (const ex of list) {
      const key = byLower.get(String(ex?.name ?? "").trim().toLowerCase());
      if (!key) continue;
      const m = {};
      for (const g of Array.isArray(ex.secondary) ? ex.secondary : []) if (valid.has(g)) m[g] = 0.5;
      for (const g of Array.isArray(ex.primary) ? ex.primary : []) if (valid.has(g)) m[g] = 1;
      map[key] = m;
    }
    return json({ map });
  } catch (e) {
    console.error("muscles failed", e?.status, e?.message);
    if (e?.status === 429) return bad("The AI is busy right now. Try again in a minute.", 429);
    return bad("Couldn't reach the AI. Try again.", 502);
  }
}
