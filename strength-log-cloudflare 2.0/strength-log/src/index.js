import { json } from "./util.js";
import { handleState } from "./state.js";
import { handleMuscles } from "./muscles.js";
import { handleMeals } from "./meals.js";

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/api/state") return await handleState(req, env);
      if (pathname === "/api/muscles") return await handleMuscles(req, env);
      if (pathname === "/api/meals" || pathname.startsWith("/api/meals/")) return await handleMeals(req, env);
      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(req); // everything else is the static app in public/
    } catch (e) {
      console.error("unhandled", e?.message, e?.stack);
      return json({ error: "Server error. Has the database migration been applied?" }, 500);
    }
  },
};
