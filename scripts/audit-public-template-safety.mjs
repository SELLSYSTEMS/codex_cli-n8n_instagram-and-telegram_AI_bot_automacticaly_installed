#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((file) => !file.startsWith('.git/'))
  .filter((file) => file !== 'scripts/audit-public-template-safety.mjs');

const forbidden = [
  { label: 'company name', pattern: /Sell\.Systems/i },
  { label: 'company domain', pattern: /sell\.systems/i },
  { label: 'private n8n host', pattern: /n8nlandingtmplfgma/i },
  { label: 'private Supabase project ref', pattern: /mqyqmudbyypnxhwwkisc/i },
  { label: 'private GitHub owner', pattern: /SELLSYSTEMS/i },
  { label: 'private Facebook page id', pattern: /325292730665434/ },
  { label: 'private Instagram business id', pattern: /17841401717222279/ },
  { label: 'private controller name', pattern: /Iurii\s+Paimurzin/i },
  { label: 'private current thread id', pattern: /1516361263313852/ },
  { label: 'private offer: Quick Workflow Audit', pattern: /Quick Workflow Audit/i },
  { label: 'private offer: Lead Response Audit', pattern: /Lead Response Audit/i },
  { label: 'private price anchor', pattern: /\$(?:165|230|360|475|745|1,260|1,515|3,180|5,615)\b/ },
];

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
