import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(root, "config", "model-routes.default.json");
const localConfigPath = process.env.MODEL_ROUTES_FILE
  ? path.resolve(process.env.MODEL_ROUTES_FILE)
  : path.join(root, "config", "model-routes.local.json");

function cleanError(value) {
  return String(value || "")
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .slice(0, 1200);
}

function normalizeConfig(config) {
  if (!config || !Array.isArray(config.routes)) {
    throw new Error("Model route config must contain a routes array");
  }

  const ids = new Set();
  const routes = config.routes.map((route) => {
    if (!route?.id || !route?.provider || !route?.model) {
      throw new Error("Each model route needs id, provider, and model");
    }
    if (ids.has(route.id)) throw new Error(`Duplicate model route id: ${route.id}`);
    ids.add(route.id);
    return {
      id: String(route.id),
      provider: String(route.provider),
      model: String(route.model),
      enabled: Boolean(route.enabled),
      priority: Number(route.priority ?? 100),
      reasoning_effort: String(route.reasoning_effort || "low"),
      timeout_ms: Number(route.timeout_ms || 180000)
    };
  });

  return {
    version: Number(config.version || 1),
    routes: routes.sort((a, b) => a.priority - b.priority)
  };
}

export async function loadRouteConfig() {
  const defaults = JSON.parse(await readFile(defaultConfigPath, "utf8"));
  let local = null;
  try {
    local = JSON.parse(await readFile(localConfigPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!local) return normalizeConfig(defaults);

  const overrides = new Map((local.routes || []).map((route) => [route.id, route]));
  const merged = defaults.routes.map((route) => ({
    ...route,
    ...(overrides.get(route.id) || {})
  }));

  for (const route of local.routes || []) {
    if (!merged.some((candidate) => candidate.id === route.id)) merged.push(route);
  }

  return normalizeConfig({ ...defaults, ...local, routes: merged });
}

export async function saveRouteConfig(config) {
  const normalized = normalizeConfig(config);
  const temporary = `${localConfigPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, localConfigPath);
  return normalized;
}

function extractJson(text) {
  const trimmed = String(text || "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Model did not return a JSON object");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

function runCommand(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Model process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Model process exited ${code}: ${cleanError(stderr || stdout)}`));
    });
    child.stdin.end(input);
  });
}

async function invokeCodex(route, prompt) {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "portable-agent-"));
  const outputPath = path.join(tempDirectory, "last-message.txt");
  const command = process.env.CODEX_BIN || "codex";
  const args = [
    "exec",
    "--model", route.model,
    "--config", `model_reasoning_effort="${route.reasoning_effort}"`,
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--output-last-message", outputPath,
    "-"
  ];

  try {
    await runCommand(command, args, prompt, route.timeout_ms);
    return extractJson(await readFile(outputPath, "utf8"));
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function responseOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("OpenAI response did not contain output text");
}

async function invokeOpenAI(route, prompt, schema) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: route.model,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "brain_response",
          strict: true,
          schema
        }
      }
    }),
    signal: AbortSignal.timeout(route.timeout_ms)
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI HTTP ${response.status}: ${cleanError(body?.error?.message || JSON.stringify(body))}`);
  }
  return {
    value: extractJson(responseOutputText(body)),
    usage: body.usage || {},
    resolved_model: body.model || route.model
  };
}

async function invokeDeepSeek(route, prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: route.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(route.timeout_ms)
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`DeepSeek HTTP ${response.status}: ${cleanError(body?.error?.message || JSON.stringify(body))}`);
  }
  return {
    value: extractJson(body.choices?.[0]?.message?.content),
    usage: body.usage || {},
    resolved_model: body.model || route.model
  };
}

export async function invokeRoutedModel({ prompt, schema }) {
  const config = await loadRouteConfig();
  const enabledRoutes = config.routes.filter((route) => route.enabled);
  if (!enabledRoutes.length) throw new Error("No model routes are enabled");

  const attempts = [];
  for (const route of enabledRoutes) {
    const started = Date.now();
    try {
      let result;
      if (route.provider === "codex_cli") {
        result = { value: await invokeCodex(route, prompt), usage: {}, resolved_model: route.model };
      } else if (route.provider === "openai") {
        result = await invokeOpenAI(route, prompt, schema);
      } else if (route.provider === "deepseek") {
        result = await invokeDeepSeek(route, prompt);
      } else {
        throw new Error(`Unsupported provider: ${route.provider}`);
      }

      attempts.push({
        route_id: route.id,
        provider: route.provider,
        model: result.resolved_model,
        ok: true,
        latency_ms: Date.now() - started
      });
      return {
        ...result,
        route,
        attempts,
        latency_ms: Date.now() - started
      };
    } catch (error) {
      attempts.push({
        route_id: route.id,
        provider: route.provider,
        model: route.model,
        ok: false,
        latency_ms: Date.now() - started,
        error: cleanError(error.message)
      });
    }
  }

  const error = new Error("All enabled model routes failed");
  error.attempts = attempts;
  throw error;
}
