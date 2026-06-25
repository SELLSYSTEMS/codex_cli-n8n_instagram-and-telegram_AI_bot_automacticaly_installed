#!/usr/bin/env node
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: render-runtime-workflow.js <workflow.json>');
  process.exit(1);
}

const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));

function envLiteral(name, original) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return original;
  }
  return JSON.stringify(value);
}

function renderString(value) {
  return value
    .replace(/\$env\.([A-Z0-9_]+)/g, (match, name) => envLiteral(name, match))
    .replace(/\$env\[(["'])([A-Z0-9_]+)\1\]/g, (match, _quote, name) => envLiteral(name, match));
}

function renderEnvRefs(value) {
  if (typeof value === 'string') {
    return renderString(value);
  }
  if (Array.isArray(value)) {
    return value.map(renderEnvRefs);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, renderEnvRefs(child)]));
  }
  return value;
}

const rendered = renderEnvRefs(workflow);
process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
