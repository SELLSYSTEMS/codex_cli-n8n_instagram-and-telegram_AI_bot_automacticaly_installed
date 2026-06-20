#!/usr/bin/env node
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: render-runtime-workflow.js <workflow.json>');
  process.exit(1);
}

const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
process.stdout.write(`${JSON.stringify(workflow, null, 2)}\n`);
