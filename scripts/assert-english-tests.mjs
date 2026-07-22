#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectories = [
  { path: join(root, 'tests', 'scenarios'), include: (name) => name.endsWith('.json') },
  { path: join(root, '.private'), include: (name) => name.endsWith('-cases.json') },
];

const files = fixtureDirectories.flatMap(({ path, include }) => {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && include(entry.name))
    .map((entry) => join(path, entry.name));
});

const failures = [];

function scenariosFrom(document, file) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document.scenarios)) return document.scenarios;
  if (Array.isArray(document.cases)) return document.cases;
  failures.push(`${relative(root, file)}: expected a top-level array, scenarios[], or cases[]`);
  return [];
}

function inspectStrings(value, path, file) {
  if (typeof value === 'string') {
    if (/[^\x00-\x7F]/.test(value)) {
      failures.push(`${relative(root, file)}:${path}: contains non-ASCII test content`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectStrings(item, `${path}[${index}]`, file));
    return;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => inspectStrings(item, `${path}.${key}`, file));
  }
}

for (const file of files) {
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(`${relative(root, file)}: invalid JSON (${error.message})`);
    continue;
  }

  const scenarios = scenariosFrom(document, file);
  scenarios.forEach((scenario, index) => {
    const id = scenario?.id || scenario?.name || `index-${index}`;
    if (scenario?.language !== 'en') {
      failures.push(`${relative(root, file)}:${id}: language must be exactly "en"`);
    }
  });
  inspectStrings(document, '$', file);
}

if (failures.length > 0) {
  console.error('English-only test policy failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`English-only test policy passed for ${files.length} fixture files.`);
