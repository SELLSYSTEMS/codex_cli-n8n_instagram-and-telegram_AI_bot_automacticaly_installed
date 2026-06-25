#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.startsWith('.git/'))
  .filter((file) => file !== 'scripts/audit-public-template-safety.mjs');

const forbidden = [
  { label: 'hardcoded n8n API key', pattern: /N8N_API_KEY\s*=\s*['"]?eyJ[a-zA-Z0-9_-]+\./ },
  { label: 'hardcoded OpenAI API key', pattern: /sk-(?:proj|live|test)-[a-zA-Z0-9_-]{20,}/ },
  { label: 'hardcoded Supabase secret key', pattern: /sb_secret_[a-zA-Z0-9_-]{20,}/ },
  { label: 'hardcoded Meta access token', pattern: /\bEAA[A-Za-z0-9]{80,}/ },
  { label: 'hardcoded Telegram bot token', pattern: /\b\d{8,12}:AA[A-Za-z0-9_-]{20,}/ },
  { label: 'private runtime URL', pattern: /https?:\/\/(?:[^/\s"']+\.)?(?:example-private|internal-runtime)\.[^\s"']+/i },
];

const localDenylist = [
  'PUBLIC_TEMPLATE_DENY_COMPANY_NAME',
  'PUBLIC_TEMPLATE_DENY_COMPANY_DOMAIN',
  'PUBLIC_TEMPLATE_DENY_N8N_HOST',
  'PUBLIC_TEMPLATE_DENY_SUPABASE_PROJECT_REF',
  'PUBLIC_TEMPLATE_DENY_FACEBOOK_PAGE_ID',
  'PUBLIC_TEMPLATE_DENY_INSTAGRAM_BUSINESS_ID',
  'PUBLIC_TEMPLATE_DENY_OPERATOR_NAME',
]
  .map((key) => [key, process.env[key]])
  .filter(([, value]) => value && value.length >= 3)
  .map(([key, value]) => ({
    label: `local denylist marker ${key}`,
    pattern: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  }));

forbidden.push(...localDenylist);

const findings = [];

for (const file of files) {
  if (/\.(png|jpg|jpeg|gif|webp|pdf|gz|zip|tar)$/i.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const check of forbidden) {
    if (check.pattern.test(text)) {
      findings.push(`${file}: ${check.label}`);
    }
  }
}

if (findings.length) {
  console.error('Public-template safety audit failed. Remove private runtime data from tracked files:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Public-template safety audit passed. No private runtime markers found in tracked files.');
