import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(envPath = path.resolve('.env')) {
  if (!fs.existsSync(envPath)) return process.env;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return process.env;
}

export function requiredEnv(names) {
  loadEnv();
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error('Missing environment variables: ' + missing.join(', '));
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

export function brainHeaders(admin = false) {
  const token = admin ? process.env.BRAIN_ADMIN_TOKEN : process.env.BRAIN_API_TOKEN;
  return {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json',
  };
}

export async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error('HTTP ' + response.status + ' from ' + new URL(url).pathname + ': ' + detail.slice(0, 800));
  }
  return body;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
