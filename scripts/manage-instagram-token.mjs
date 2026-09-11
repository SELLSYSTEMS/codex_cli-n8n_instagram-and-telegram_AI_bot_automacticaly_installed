import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const mode = process.argv.includes('--refresh') ? 'refresh' : 'check';
const workflowName = 'Channel - Instagram - Shared AI Brain';

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function required(env, key) {
  const value = env[key];
  if (!value || /placeholder/i.test(value)) throw new Error(`${key} is missing from local .env`);
  return value;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { message: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function instagramRequest(pathname, parameters, token) {
  const url = new URL(pathname, 'https://graph.instagram.com');
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  url.searchParams.set('access_token', token);
  return jsonRequest(url);
}

async function n8nRequest(env, pathname) {
  const base = required(env, 'N8N_BASE_URL').replace(/\/$/, '');
  return jsonRequest(`${base}/api/v1${pathname}`, {
    headers: { 'X-N8N-API-KEY': required(env, 'N8N_API_KEY') },
  });
}

async function replaceEnvToken(source, token) {
  const escaped = token.replace(/'/g, "'\\''");
  const replacement = `IG_ACCESS_TOKEN='${escaped}'`;
  const expression = /^IG_ACCESS_TOKEN=.*$/m;
  const output = expression.test(source)
    ? source.replace(expression, replacement)
    : `${source.replace(/\s*$/, '\n')}${replacement}\n`;
  const metadata = await stat(envPath);
  const temporaryPath = `${envPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, output, { encoding: 'utf8', mode: metadata.mode });
  await rename(temporaryPath, envPath);
}

function inspectWorkflow(workflow) {
  const byName = new Map((workflow.nodes || []).map((item) => [item.name, item]));
  const schedule = byName.get('Refresh Instagram Token Weekly');
  const refresh = byName.get('Refresh Instagram Long-Lived Token');
  const sender = byName.get('Send Instagram reply');
  const authorization = sender?.parameters?.headerParameters?.parameters
    ?.find((header) => header.name?.toLowerCase() === 'authorization')?.value || '';
  const staticData = workflow.staticData || {};

  return {
    active: workflow.active === true,
    schedule_installed: schedule?.type === 'n8n-nodes-base.scheduleTrigger',
    refresh_endpoint_installed: refresh?.parameters?.url === 'https://graph.instagram.com/refresh_access_token',
    refreshed_token_store_installed: byName.has('Store Refreshed Instagram Token'),
    dynamic_delivery_token_installed: authorization.includes('_igAccessToken'),
    persisted_token_present: Boolean(staticData.instagramAccessToken),
    persisted_token_source: staticData.instagramTokenSource || null,
    persisted_token_updated_at: staticData.instagramTokenUpdatedAt || null,
    persisted_token_expires_at: staticData.instagramTokenExpiresAt || null,
  };
}

const envSource = await readFile(envPath, 'utf8');
const env = parseEnv(envSource);
let token = required(env, 'IG_ACCESS_TOKEN');
let refreshResult = null;

if (mode === 'refresh') {
  refreshResult = await instagramRequest('/refresh_access_token', { grant_type: 'ig_refresh_token' }, token);
  if (!refreshResult.access_token) throw new Error('Instagram refresh response did not contain access_token');
  token = refreshResult.access_token;
  await replaceEnvToken(envSource, token);
}

const apiVersion = env.IG_GRAPH_API_VERSION || 'v25.0';
const identity = await instagramRequest(`/${apiVersion}/me`, { fields: 'id,user_id,username' }, token);
const workflows = await n8nRequest(env, '/workflows?limit=250');
const summary = (workflows.data || []).find((item) => item.name === workflowName);
if (!summary) throw new Error(`Live n8n workflow not found: ${workflowName}`);
const workflow = summary.nodes ? summary : await n8nRequest(env, `/workflows/${summary.id}`);
const wiring = inspectWorkflow(workflow);
const expectedUserId = env.IG_API_USER_ID || null;
const apiUserId = String(identity.id || '');
const linkedInstagramUserId = identity.user_id ? String(identity.user_id) : null;
const report = {
  mode,
  token_valid: Boolean(apiUserId),
  instagram_api_user_id: apiUserId || null,
  linked_instagram_user_id: linkedInstagramUserId,
  instagram_user_id_matches_env: expectedUserId ? apiUserId === String(expectedUserId) : null,
  instagram_username: identity.username || null,
  refresh_completed: Boolean(refreshResult?.access_token),
  refreshed_expires_in_seconds: refreshResult?.expires_in || null,
  workflow_id: workflow.id,
  workflow_name: workflow.name,
  ...wiring,
};

console.log(JSON.stringify(report, null, 2));

const requiredChecks = [
  report.token_valid,
  report.active,
  report.schedule_installed,
  report.refresh_endpoint_installed,
  report.refreshed_token_store_installed,
  report.dynamic_delivery_token_installed,
];
if (requiredChecks.some((value) => value !== true)) process.exitCode = 2;
