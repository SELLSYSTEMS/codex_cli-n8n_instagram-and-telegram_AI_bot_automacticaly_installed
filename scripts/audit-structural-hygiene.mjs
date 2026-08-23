#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];
const ignoredTrees = new Set(['.git', '.private', '.runtime', 'node_modules']);
const forbiddenRootDirectories = ['.codex-backups', '.codex-timers'];
const allowedEnvironmentFiles = new Set(['.env', '.env.example']);
const rootJunkPattern = /\.(?:bak|log|orig|pid|tmp)$/i;

for (const directory of forbiddenRootDirectories) {
  if (fs.existsSync(path.join(repoRoot, directory))) {
    failures.push('Transient directory must not live at repository root: ' + directory);
  }
}

for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
  if (entry.isFile() && rootJunkPattern.test(entry.name)) {
    failures.push('Transient file must not live at repository root: ' + entry.name);
  }
}

function inspectPublicTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (directory === repoRoot && entry.isDirectory() && ignoredTrees.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(repoRoot, absolutePath);

    if (entry.isDirectory()) {
      inspectPublicTree(absolutePath);
      continue;
    }

    if (entry.name.startsWith('.env') && !allowedEnvironmentFiles.has(relativePath)) {
      failures.push('Unexpected environment file in public tree: ' + relativePath);
    }
  }
}

inspectPublicTree(repoRoot);

const migrationsDirectory = path.join(repoRoot, 'schemas', 'migrations');
if (!fs.existsSync(path.join(migrationsDirectory, 'README.md'))) {
  failures.push('Missing schemas/migrations/README.md');
}

const migrationFiles = fs.existsSync(migrationsDirectory)
  ? fs.readdirSync(migrationsDirectory)
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort()
  : [];

if (migrationFiles.length === 0) {
  failures.push('At least one ordered schema migration is required');
}

migrationFiles.forEach((name, index) => {
  const expectedPrefix = String(index + 1).padStart(3, '0') + '_';
  if (!name.startsWith(expectedPrefix)) {
    failures.push('Migration sequence is not contiguous at ' + name + '; expected ' + expectedPrefix);
  }

  const sql = fs.readFileSync(path.join(migrationsDirectory, name), 'utf8');
  if (/^\s*(?:BEGIN|COMMIT)\s*;/im.test(sql)) {
    failures.push('Migration transaction boundaries belong to the runner: ' + name);
  }
});

const schemaPath = path.join(repoRoot, 'schemas', 'local-postgres-brain.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
if (!/unique\s*\(\s*tenant_id\s*,\s*provider\s*,\s*external_contact_id\s*\)/i.test(schema)) {
  failures.push('CRM external contact uniqueness must include tenant_id');
}
if (!/unique\s*\(\s*tenant_id\s*,\s*provider\s*,\s*dedupe_key\s*\)/i.test(schema)) {
  failures.push('CRM outbox dedupe uniqueness must include tenant_id');
}
if (/unique\s*\(\s*provider\s*,\s*external_contact_id\s*\)/i.test(schema)) {
  failures.push('Global CRM external contact uniqueness is forbidden');
}
if (/unique\s*\(\s*provider\s*,\s*dedupe_key\s*\)/i.test(schema)) {
  failures.push('Global CRM outbox dedupe uniqueness is forbidden');
}

const report = {
  ok: failures.length === 0,
  checks: {
    rootTransientDirectories: forbiddenRootDirectories.length,
    migrationCount: migrationFiles.length,
      allowedRootEnvironmentFiles: [...allowedEnvironmentFiles],
    tenantScopedCrmConstraints: true
  },
  warnings,
  failures
};

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (!report.ok) {
  process.exitCode = 1;
}
