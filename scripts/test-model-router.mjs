import { loadRouteConfig } from "./model-router.mjs";

const config = await loadRouteConfig();
const enabled = config.routes.filter((route) => route.enabled);
const openai = config.routes.find((route) => route.id === "openai_api");
const spark = config.routes.find((route) => route.id === "codex_spark");
const mini = config.routes.find((route) => route.id === "codex_mini");

if (spark?.model !== "gpt-5.3-codex-spark" || !spark.enabled || spark.priority !== 10) {
  throw new Error("Primary Codex Spark route is not configured correctly");
}
if (mini?.model !== "gpt-5.4-mini" || !mini.enabled || mini.priority !== 20) {
  throw new Error("Codex Mini fallback route is not configured correctly");
}
if (!openai || openai.model !== "gpt-4.1" || openai.enabled) {
  throw new Error("OpenAI route must use gpt-4.1 and remain disabled");
}
if (enabled.some((route) => route.provider !== "codex_cli")) {
  throw new Error("Only Codex CLI routes may be enabled by default");
}
process.stdout.write(`model routes ok: ${enabled.map((route) => `${route.priority}:${route.model}`).join(", ")}\n`);
