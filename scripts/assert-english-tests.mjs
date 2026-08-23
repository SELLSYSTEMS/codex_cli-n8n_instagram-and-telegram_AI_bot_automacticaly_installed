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

const brainPrompt = readFileSync(`${process.cwd()}/prompts/brain-system.md`, 'utf8');
const brainGraphSource = readFileSync(`${process.cwd()}/scripts/brain-graph.mjs`, 'utf8');
const decisionSchema = JSON.parse(readFileSync(`${process.cwd()}/schemas/brain-decision.schema.json`, 'utf8'));
const hubspotSource = readFileSync(`${process.cwd()}/scripts/crm-hubspot.mjs`, 'utf8');

for (const requiredSignal of ['English is the default language', 'If language preference is uncertain, use English', 'Never implement or imitate language-specific keyword trees', 'preferred future contact channel']) {
  if (!brainPrompt.includes(requiredSignal)) failures.push(`brain-system.md is missing policy signal: ${requiredSignal}`);
}

const forbiddenLanguageRouting = [
  /if\s*\([^)]*(?:language|locale)[^)]*\)/i,
  /switch\s*\([^)]*(?:language|locale)/i,
  /(?:language|locale)\s*={2,3}\s*['"]/i,
];
for (const pattern of forbiddenLanguageRouting) {
  if (pattern.test(brainGraphSource)) failures.push(`brain-graph.mjs contains forbidden deterministic language routing: ${pattern}`);
}

const profileSchema = decisionSchema.properties?.contact_profile;
for (const field of ['preferred_contact_channel', 'preferred_contact_time', 'timezone']) {
  if (!profileSchema?.properties?.[field] || !profileSchema.required?.includes(field)) failures.push(`brain decision schema is missing required contact profile field: ${field}`);
}
for (const field of ['brain_contact_language', 'brain_preferred_channel', 'brain_preferred_contact_time', 'brain_contact_timezone']) {
  if (!hubspotSource.includes(field)) failures.push(`HubSpot projection is missing field: ${field}`);
}

if (failures.length > 0) {
  console.error('English-only test policy failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`English-only test policy passed for ${files.length} fixture files.`);
