#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const evidence = {};

const requiredFiles = [
  'AGENTS.md',
  'README.md',
  'docs/source-of-truth.md',
  'docs/public-template-safety.md',
  'docs/storage-profiles.md',
  'schemas/README.md',
  'schemas/local-postgres-brain.sql',
  'scripts/audit-public-template-safety.mjs',
  'scripts/inventory-database-layout.mjs',
];

const forbiddenFiles = [
  '.env.example',
  'schemas/supabase.sql',
  'scripts/apply-supabase-schema.sh',
  'scripts/sync-workflows.sh',
  'workflows/demo-rag-instagram-supabase.json',
  'workflows/knowledge-upload-to-supabase.json',
];

const expectedWorkflowNames = [
  'Channel - Instagram - Shared AI Brain',
  'Channel - Telegram - Shared AI Brain',
  'Channel - WhatsApp - Shared AI Brain',
  'Internal - Brain Test Harness',
  'Operator - Cross-channel Identity Link',
  'Operator - Escalation Reset',
  'Operator - Knowledge Ingest',
  'Operator - Model Route Control',
].sort();

async function exists(relativePath) {
  try {
    await readFile(path.join(root, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'EISDIR') return true;
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function walk(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(relativePath));
    if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

for (const file of requiredFiles) {
  if (!await exists(file)) failures.push(`missing required canonical file: ${file}`);
}

for (const file of forbiddenFiles) {
  if (await exists(file)) failures.push(`forbidden obsolete public path exists: ${file}`);
}

const sqlFiles = (await walk('schemas')).filter((file) => file.endsWith('.sql')).sort();
const canonicalBootstrap = path.join('schemas', 'local-postgres-brain.sql');
const migrationsPrefix = `${path.join('schemas', 'migrations')}${path.sep}`;
const bootstrapSqlFiles = sqlFiles.filter((file) => path.dirname(file) === 'schemas');
const migrationSqlFiles = sqlFiles.filter((file) => file.startsWith(migrationsPrefix));
const unexpectedSqlFiles = sqlFiles.filter(
  (file) => !bootstrapSqlFiles.includes(file) && !migrationSqlFiles.includes(file),
);
evidence.sqlFiles = sqlFiles;
evidence.bootstrapSqlFiles = bootstrapSqlFiles;
evidence.migrationSqlFiles = migrationSqlFiles;
evidence.unexpectedSqlFiles = unexpectedSqlFiles;
if (bootstrapSqlFiles.length !== 1 || bootstrapSqlFiles[0] !== canonicalBootstrap) {
  failures.push('schemas must contain exactly one canonical SQL bootstrap: schemas/local-postgres-brain.sql');
}
if (unexpectedSqlFiles.length > 0) {
  failures.push(`unexpected SQL files outside bootstrap and migrations: ${unexpectedSqlFiles.join(', ')}`);
}

if (await exists('schemas/local-postgres-brain.sql')) {
  const sql = await readFile(path.join(root, 'schemas/local-postgres-brain.sql'), 'utf8');
  if (!/create\s+schema\s+if\s+not\s+exists\s+agent\b/i.test(sql)) {
    failures.push('canonical SQL does not declare the agent schema');
  }
  if (/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.bot_/i.test(sql)) {
    failures.push('canonical SQL creates legacy public.bot_* tables');
  }
}

const workflowFiles = (await walk('workflows')).filter((file) => file.endsWith('.json')).sort();
const workflows = [];
for (const file of workflowFiles) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root, file), 'utf8'));
  } catch (error) {
    failures.push(`invalid workflow JSON: ${file}: ${error.message}`);
    continue;
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.nodes) || typeof candidate.name !== 'string') {
      continue;
    }
    workflows.push({ file, name: candidate.name, active: candidate.active });
  }
}

const workflowNames = workflows.map((workflow) => workflow.name).sort();
evidence.workflows = workflows;
if (JSON.stringify(workflowNames) !== JSON.stringify(expectedWorkflowNames)) {
  failures.push(`workflow contract mismatch: expected ${JSON.stringify(expectedWorkflowNames)}, found ${JSON.stringify(workflowNames)}`);
}
for (const workflow of workflows) {
  if (workflow.active !== false) failures.push(`public workflow export must be inactive: ${workflow.name} (${workflow.file})`);
}

if (await exists('.gitignore')) {
  const ignored = (await readFile(path.join(root, '.gitignore'), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  evidence.ignoreRules = ignored.filter((line) => line.includes('.env') || line.includes('.private'));
  if (!ignored.includes('.env')) failures.push('.gitignore must ignore .env');
  if (!ignored.some((line) => line === '.private' || line === '.private/')) {
    failures.push('.gitignore must ignore .private/');
  }
} else {
  failures.push('missing .gitignore');
}

const report = {
  ok: failures.length === 0,
  canonicalDatabase: 'agent',
  storageDefault: 'local-postgresql-pgvector',
  workflowCount: workflows.length,
  failures,
  evidence,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
