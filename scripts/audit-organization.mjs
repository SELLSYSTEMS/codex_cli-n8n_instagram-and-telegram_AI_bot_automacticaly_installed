#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requirePath(relativePath) {
  if (!exists(relativePath)) {
    errors.push('Missing required path: ' + relativePath);
  }
}

const requiredDirectories = [
  '.private/active/commercial',
  '.private/active/knowledge',
  '.private/active/knowledge/source-packs',
  '.private/active/tests',
  '.private/operations',
  '.private/archives',
  '.private/pointers',
  '.runtime',
  'config',
  'docs',
  'schemas',
  'scripts',
  'workflows'
];

const requiredFiles = [
  '.private/README.md',
  '.private/ARCHIVE_INDEX.md',
  '.private/layout.json',
  '.private/operations/CURRENT_STATE.md',
  '.private/operations/PRODUCTION_OWNERSHIP_MAP.md',
  '.private/operations/compatibility-aliases.json',
  'config/project-layout.default.json',
  'config/data-ownership.default.json',
  'docs/operations-and-data-ownership.md'
];

for (const directory of requiredDirectories) {
  requirePath(directory);
  if (exists(directory) && !fs.statSync(path.join(root, directory)).isDirectory()) {
    errors.push('Required directory is not a directory: ' + directory);
  }
}

for (const file of requiredFiles) {
  requirePath(file);
}

for (const forbidden of ['.state', 'logs']) {
  if (exists(forbidden)) {
    errors.push('Deprecated top-level runtime path exists: ' + forbidden);
  }
}

const compatibilityRegistryPath = '.private/operations/compatibility-aliases.json';
let compatibilityRegistry = null;
try {
  compatibilityRegistry = JSON.parse(read(compatibilityRegistryPath));
} catch (error) {
  errors.push('Could not parse compatibility alias registry: ' + error.message);
}

const registryAliases = compatibilityRegistry?.aliases;
const forbiddenAliasPaths = compatibilityRegistry?.forbidden_paths;
const activeAliases = Array.isArray(registryAliases) ? registryAliases : [];
const forbiddenPrivateAliases = new Set(Array.isArray(forbiddenAliasPaths) ? forbiddenAliasPaths : []);

if (compatibilityRegistry?.status !== 'retired') {
  errors.push('Compatibility alias registry must be retired after the completed restart and smoke-test gate.');
}
if (!Array.isArray(registryAliases) || activeAliases.length !== 0) {
  errors.push('Compatibility alias registry must not contain active aliases.');
}
if (!Array.isArray(forbiddenAliasPaths) || forbiddenPrivateAliases.size === 0) {
  errors.push('Compatibility alias registry must define retired paths that may not reappear.');
}
for (const relativePath of forbiddenPrivateAliases) {
  if (exists(relativePath)) {
    errors.push('Retired compatibility alias has reappeared: ' + relativePath);
  }
}

const allowedPrivateRootEntries = new Set([
  'README.md',
  'ARCHIVE_INDEX.md',
  'layout.json',
  'active',
  'operations',
  'archives',
  'pointers',
]);

if (exists('.private')) {
  for (const entry of fs.readdirSync(path.join(root, '.private'))) {
    if (!allowedPrivateRootEntries.has(entry)) {
      errors.push('Unclassified .private root entry: .private/' + entry);
    }
  }
}

const deprecatedReferences = [...forbiddenPrivateAliases];

for (const relativePath of [
  'package.json',
  'scripts/commercial-action-tool.mjs',
  'scripts/brain-graph.mjs',
  'scripts/ingest-knowledge.mjs'
]) {
  if (!exists(relativePath)) {
    continue;
  }
  const source = read(relativePath);
  for (const deprecated of deprecatedReferences) {
    if (source.includes(deprecated)) {
      errors.push('Deprecated private path in ' + relativePath + ': ' + deprecated);
    }
  }
}

if (exists('.env')) {
  const env = read('.env');
  if (/^MODEL_ROUTES_FILE=/m.test(env)) {
    errors.push('Deprecated environment key remains: MODEL_ROUTES_FILE');
  }
  if (/^MODEL_HEALTH_FILE=/m.test(env)) {
    errors.push('Deprecated environment key remains: MODEL_HEALTH_FILE');
  }
  if (!/^MODEL_ROUTES_RUNTIME=["']?\.runtime\/model-routes\.json["']?$/m.test(env)) {
    errors.push('MODEL_ROUTES_RUNTIME must use .runtime/model-routes.json');
  }
  if (!/^MODEL_HEALTH_STATE=["']?\.runtime\/model-health\.json["']?$/m.test(env)) {
    errors.push('MODEL_HEALTH_STATE must use .runtime/model-health.json');
  }
} else {
  warnings.push('Local .env is absent; runtime path keys were not inspected.');
}

try {
  const ownership = JSON.parse(read('config/data-ownership.default.json'));
  if (ownership.database.canonicalSchema !== 'agent') {
    errors.push('Canonical database schema must be agent.');
  }
  if (ownership.database.defaultBackend !== 'local-postgresql-pgvector') {
    errors.push('Default database backend must be local-postgresql-pgvector.');
  }
} catch (error) {
  errors.push('Could not parse data ownership config: ' + error.message);
}

try {
  const packageJson = JSON.parse(read('package.json'));
  if (packageJson.scripts['organization:audit'] !== 'node scripts/audit-organization.mjs') {
    errors.push('package.json is missing the canonical organization:audit command.');
  }
} catch (error) {
  errors.push('Could not parse package.json: ' + error.message);
}

const result = {
  ok: errors.length === 0,
  canonicalDatabaseSchema: 'agent',
  runtimeRoot: '.runtime',
  privateRoots: [
    '.private/active',
    '.private/operations',
    '.private/archives',
    '.private/pointers'
  ],
  errors,
  warnings
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (errors.length > 0) {
  process.exitCode = 1;
}
