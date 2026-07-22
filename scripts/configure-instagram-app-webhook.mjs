#!/usr/bin/env node
import crypto from "node:crypto";

process.loadEnvFile?.(".env");

const checkOnly = process.argv.includes("--check");
const graphVersion = process.env.IG_GRAPH_API_VERSION || process.env.META_GRAPH_API_VERSION || "v25.0";
const accessToken = process.env.IG_ACCESS_TOKEN;
const igUserId = process.env.IG_API_USER_ID || process.env.IG_BUSINESS_ACCOUNT_ID;
const n8nBaseUrl = (process.env.N8N_BASE_URL || "").replace(/\/$/, "");
const callbackUrl = process.env.IG_WEBHOOK_CALLBACK_URL || `${n8nBaseUrl}/webhook/instagram-rag-webhook`;
const verifyToken = process.env.IG_WEBHOOK_VERIFY_TOKEN;
const n8nApiKey = process.env.N8N_API_KEY;

const appCandidates = [
  [process.env.META_APP_ID, process.env.META_APP_SECRET, "META_APP"],
  [process.env.FACEBOOK_APP_ID, process.env.FACEBOOK_APP_SECRET, "FACEBOOK_APP"],
  [process.env.IG_PARENT_APP_ID, process.env.IG_PARENT_APP_SECRET, "IG_PARENT_APP"],
  [process.env.IG_APP_ID, process.env.IG_APP_SECRET, "IG_APP"],
  [process.env.INSTAGRAM_APP_ID, process.env.INSTAGRAM_APP_SECRET, "INSTAGRAM_APP"],
  [process.env.IG_LOGIN_APP_ID, process.env.IG_LOGIN_APP_SECRET, "IG_LOGIN_APP"],
].filter(([id, secret]) => id && secret);

function requireValue(value, name) {
  if (!value || /placeholder|replace_me|your_/i.test(value)) {
    throw new Error(`Missing usable ${name} in .env`);
  }
  return value;
}

requireValue(accessToken, "IG_ACCESS_TOKEN");
requireValue(igUserId, "IG_API_USER_ID");
requireValue(callbackUrl, "IG_WEBHOOK_CALLBACK_URL or N8N_BASE_URL");
requireValue(verifyToken, "IG_WEBHOOK_VERIFY_TOKEN");
requireValue(n8nBaseUrl, "N8N_BASE_URL");
requireValue(n8nApiKey, "N8N_API_KEY");

async function requestJson(url, options = {}, allowFailure = false) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!response.ok && !allowFailure) {
    const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  return { ok: response.ok, status: response.status, body };
}

async function resolveApp() {
  const seen = new Set();
  for (const [id, secret, source] of appCandidates) {
    if (seen.has(`${id}:${secret}`)) continue;
    seen.add(`${id}:${secret}`);
    const token = `${id}|${secret}`;
    const probe = await requestJson(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(id)}?fields=id,name&access_token=${encodeURIComponent(token)}`,
      {},
      true,
    );
    if (probe.ok && String(probe.body?.id) === String(id)) return { id, secret, token, source };
  }
  throw new Error("No valid Meta app ID/secret pair was found in .env");
}

function sameUrl(left, right) {
  return String(left || "").replace(/\/$/, "") === String(right || "").replace(/\/$/, "");
}

async function upsertAppSubscription(app, object) {
  const form = new URLSearchParams({
    object,
    callback_url: callbackUrl,
    fields: "messages",
    verify_token: verifyToken,
    include_values: "true",
    access_token: app.token,
  });
  return requestJson(`https://graph.facebook.com/${graphVersion}/${app.id}/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  }, true);
}

async function ensureUserSubscription() {
  const form = new URLSearchParams({
    subscribed_fields: "messages",
    access_token: accessToken,
  });
  return requestJson(`https://graph.instagram.com/${graphVersion}/${igUserId}/subscribed_apps`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function getN8nWorkflow() {
  const response = await requestJson(`${n8nBaseUrl}/api/v1/workflows?limit=250`, {
    headers: { "X-N8N-API-KEY": n8nApiKey },
  });
  const workflows = response.body?.data || [];
  return workflows.find((workflow) =>
    workflow.nodes?.some((node) => node.parameters?.path === "instagram-rag-webhook")
      || /instagram/i.test(workflow.name || ""),
  );
}

async function verifyChallenge() {
  const url = new URL(callbackUrl);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", verifyToken);
  url.searchParams.set("hub.challenge", "instagram_delivery_diagnostic_ok");
  const response = await fetch(url);
  const text = await response.text();
  return {
    ok: response.ok && text.includes("instagram_delivery_diagnostic_ok"),
    status: response.status,
  };
}

async function sendSafeSyntheticEvent(app, workflow) {
  const startedAt = Date.now();
  const payload = {
    object: "instagram",
    entry: [{
      id: String(igUserId),
      time: startedAt,
      messaging: [{
        sender: { id: "diagnostic-self-event" },
        recipient: { id: String(igUserId) },
        timestamp: startedAt,
        message: {
          mid: `diagnostic-${startedAt}`,
          text: "delivery diagnostic self event",
          is_echo: true,
          is_self: true,
        },
      }],
    }],
  };
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac("sha256", app.secret).update(raw).digest("hex")}`;
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    body: raw,
  });
  const accepted = response.ok;

  let execution = null;
  if (accepted && workflow?.id) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const executions = await requestJson(
        `${n8nBaseUrl}/api/v1/executions?workflowId=${encodeURIComponent(workflow.id)}&limit=5`,
        { headers: { "X-N8N-API-KEY": n8nApiKey } },
        true,
      );
      execution = executions.body?.data?.find((item) => Date.parse(item.startedAt || 0) >= startedAt - 3000) || null;
      if (execution && !["new", "running", "waiting"].includes(execution.status)) break;
    }
  }
  return {
    accepted,
    httpStatus: response.status,
    execution: execution ? { id: execution.id, status: execution.status, finished: execution.finished } : null,
  };
}

const app = await resolveApp();
const mutations = [];
if (!checkOnly) {
  for (const object of ["instagram", "page"]) {
    const result = await upsertAppSubscription(app, object);
    mutations.push({ object, ok: result.ok, status: result.status, error: result.body?.error?.message || null });
  }
  await ensureUserSubscription();
}

const [appSubscriptions, userSubscriptions, workflow, challenge] = await Promise.all([
  requestJson(`https://graph.facebook.com/${graphVersion}/${app.id}/subscriptions?access_token=${encodeURIComponent(app.token)}`),
  requestJson(`https://graph.instagram.com/${graphVersion}/${igUserId}/subscribed_apps?access_token=${encodeURIComponent(accessToken)}`),
  getN8nWorkflow(),
  verifyChallenge(),
]);

const appRows = appSubscriptions.body?.data || [];
const currentInstagram = appRows.find((row) => row.object === "instagram" && sameUrl(row.callback_url, callbackUrl));
const currentLegacyPage = appRows.find((row) => row.object === "page" && sameUrl(row.callback_url, callbackUrl));
const userHasMessages = (userSubscriptions.body?.data || []).some((row) =>
  (row.subscribed_fields || []).includes("messages"),
);
const safeEvent = await sendSafeSyntheticEvent(app, workflow);
const executionOk = safeEvent.execution && safeEvent.execution.status !== "error";

const report = {
  mode: checkOnly ? "check" : "configure",
  graphVersion,
  appCredentialSource: app.source,
  appSubscriptions: appRows.map((row) => ({
    object: row.object,
    callbackCurrent: sameUrl(row.callback_url, callbackUrl),
    fields: row.fields || [],
    active: row.active,
  })),
  mutations,
  instagramAppCallbackCurrent: Boolean(currentInstagram),
  legacyPageCallbackCurrent: Boolean(currentLegacyPage),
  instagramUserMessagesSubscribed: userHasMessages,
  n8nWorkflow: workflow ? { id: workflow.id, name: workflow.name, active: workflow.active } : null,
  challenge,
  syntheticDelivery: safeEvent,
};

console.log(JSON.stringify(report, null, 2));

const failures = [];
if (!currentInstagram) failures.push("Meta app has no current object=instagram callback subscription");
if (!userHasMessages) failures.push("Instagram user is not subscribed to messages");
if (!workflow?.active) failures.push("n8n Instagram workflow is missing or inactive");
if (!challenge.ok) failures.push("Meta verification challenge failed");
if (!safeEvent.accepted) failures.push("n8n callback rejected a signed synthetic event");
if (!executionOk) failures.push("signed synthetic event did not produce a successful n8n execution");
if (failures.length) throw new Error(failures.join("; "));
