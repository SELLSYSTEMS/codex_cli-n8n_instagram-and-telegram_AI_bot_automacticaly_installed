import { createServer } from "node:http";
import { databaseConfigured, resetEscalation } from "./db.mjs";
import { runBrain } from "./brain-graph.mjs";
import { ingestKnowledge } from "./knowledge.mjs";
import { loadRouteConfig, saveRouteConfig } from "./model-router.mjs";

const host = process.env.BRAIN_HOST || "127.0.0.1";
const port = Number(process.env.BRAIN_PORT || 8789);
const maxBodyBytes = Number(process.env.BRAIN_MAX_BODY_BYTES || 2_000_000);

function bearer(request) {
  const value = String(request.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function authorized(request, expected) {
  return !expected || bearer(request) === expected;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function requireAdmin(request) {
  const token = process.env.BRAIN_ADMIN_TOKEN;
  if (!token) throw Object.assign(new Error("BRAIN_ADMIN_TOKEN is not configured"), { status: 503 });
  if (!authorized(request, token)) throw Object.assign(new Error("Unauthorized"), { status: 401 });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      const routes = await loadRouteConfig();
      send(response, 200, {
        ok: true,
        service: "portable-conversational-agent-brain",
        database_configured: databaseConfigured(),
        enabled_routes: routes.routes.filter((route) => route.enabled).map((route) => ({
          id: route.id,
          provider: route.provider,
          model: route.model,
          priority: route.priority
        }))
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      if (!authorized(request, process.env.BRAIN_API_TOKEN || "")) {
        send(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      send(response, 200, await runBrain(await readJson(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/escalations/reset") {
      requireAdmin(request);
      const reset = await resetEscalation(await readJson(request));
      send(response, 200, { ok: true, reset_count: reset.length, conversations: reset });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/knowledge") {
      requireAdmin(request);
      send(response, 200, { ok: true, ...(await ingestKnowledge(await readJson(request))) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/admin/model-routes") {
      requireAdmin(request);
      send(response, 200, { ok: true, ...(await loadRouteConfig()) });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/v1/admin/model-routes") {
      requireAdmin(request);
      send(response, 200, { ok: true, ...(await saveRouteConfig(await readJson(request))) });
      return;
    }

    send(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    send(response, Number(error.status || 500), {
      ok: false,
      error: error.message,
      ...(error.attempts ? { route_attempts: error.attempts } : {})
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Brain API listening on http://${host}:${port}\n`);
});
