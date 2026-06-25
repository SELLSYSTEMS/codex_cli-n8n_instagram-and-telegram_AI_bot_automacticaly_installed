#!/usr/bin/env node
import fs from 'node:fs';

function loadEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = {
    tenant: 'demo',
    channel: 'internal_quality',
    thread: `qa-${Date.now()}`,
    user: 'internal-qa-user',
    sender: 'Internal QA',
    message: '',
    reset: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--tenant') args.tenant = next();
    else if (arg === '--channel') args.channel = next();
    else if (arg === '--thread') args.thread = next();
    else if (arg === '--user') args.user = next();
    else if (arg === '--sender') args.sender = next();
    else if (arg === '--message') args.message = next();
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/internal-bot-test.mjs --message "..." [--thread id] [--reset] [--json]\n\nCalls the live n8n internal RAG test webhook. Secrets are loaded from .env and are never printed.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.message && !args.reset) throw new Error('Missing --message. Use --reset only to clear escalation/thread state.');
  return args;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function formatShort(data) {
  const lines = [];
  lines.push(`status: ${data.status ?? 'unknown'}`);
  lines.push(`language: ${data.detected_language ?? 'unknown'}`);
  lines.push(`intent: ${data.detected_intent ?? 'unknown'}`);
  lines.push(`stage: ${data.sales_stage ?? 'unknown'}`);
  lines.push(`psychotype: ${data.customer_psychotype ?? 'unknown'}`);
  lines.push(`handoff: ${String(Boolean(data.requires_handoff))}`);
  if (data.memory_debug) lines.push(`memory: history=${data.memory_debug.history_events ?? 'n/a'} docs=${data.memory_debug.retrieved_documents ?? 'n/a'} parsed=${data.memory_debug.parsed_json ?? 'n/a'}`);
  if (data.answer) lines.push(`answer: ${data.answer}`);
  if (data.reason && !data.answer) lines.push(`reason: ${data.reason}`);
  return lines.join('\n');
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = requiredEnv('N8N_BASE_URL').replace(/\/$/, '');
  const token = requiredEnv('INTERNAL_TEST_TOKEN');
  const url = `${baseUrl}/webhook/internal-rag-test`;
  const body = {
    tenant_id: args.tenant,
    channel: args.channel,
    thread_id: args.thread,
    external_user_id: args.user,
    sender_name: args.sender,
    message_text: args.message,
    reset: args.reset,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-test-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatShort(data));
  }

  if (!response.ok || data.message === 'Error in workflow' || data.status === 'error') {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
