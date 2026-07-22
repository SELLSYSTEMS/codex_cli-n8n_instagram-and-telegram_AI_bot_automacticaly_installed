#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { pruneKnowledge, replaceKnowledge } from './db.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supportedExtensions = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml']);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function walkFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return supportedExtensions.has(path.extname(target).toLowerCase()) ? [target] : [];
  return fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => walkFiles(path.join(target, entry.name)));
}

function chunksFrom(text, size, overlap) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const floor = start + Math.floor(size * 0.62);
      const newline = normalized.lastIndexOf('\n', end);
      const space = normalized.lastIndexOf(' ', end);
      const boundary = Math.max(newline, space);
      if (boundary >= floor) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

const manifestPath = path.resolve(repositoryRoot, argumentValue('--manifest') || process.env.KNOWLEDGE_MANIFEST_PATH || '.private/knowledge-manifest.json');
if (!fs.existsSync(manifestPath)) throw new Error(`Knowledge manifest not found: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) throw new Error('Knowledge manifest must contain sources');

const tenantKey = process.env.BRAIN_TENANT_KEY || process.env.TENANT_KEY || manifest.tenantKey;
if (!tenantKey) throw new Error('Set BRAIN_TENANT_KEY or TENANT_KEY; tenant identity must not be hard-coded in the manifest');
const tenantName = process.env.BRAIN_TENANT_NAME || process.env.TENANT_NAME || tenantKey;
const chunkSize = Math.max(300, Number(process.env.KB_CHUNK_SIZE || manifest.chunkSize || 900));
const chunkOverlap = Math.max(0, Math.min(chunkSize - 1, Number(process.env.KB_CHUNK_OVERLAP || manifest.chunkOverlap || 120)));
const retained = [];
const results = [];

for (const source of manifest.sources) {
  if (!source || typeof source.path !== 'string') throw new Error('Every manifest source requires path');
  const absolute = path.resolve(repositoryRoot, source.path);
  const files = walkFiles(absolute).sort();
  if (!files.length && !source.optional) throw new Error(`Required knowledge source is missing or empty: ${source.path}`);
  for (const file of files) {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join('/');
    const sourceKey = source.sourceKey && files.length === 1 ? source.sourceKey : relative;
    const content = fs.readFileSync(file, 'utf8');
    const chunks = chunksFrom(content, chunkSize, chunkOverlap);
    if (!chunks.length) continue;
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const metadata = {
      ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}),
      curated: true,
      sourcePath: relative
    };
    const result = await replaceKnowledge({
      tenantKey,
      tenantName,
      sourceKey,
      title: source.title || path.basename(file),
      contentHash,
      metadata,
      chunks
    });
    retained.push(sourceKey);
    results.push(result);
  }
}

if (!retained.length) throw new Error('Curated knowledge set produced no chunks');
const prune = manifest.prune === false ? { removed: 0, skipped: true } : await pruneKnowledge({ tenantKey, tenantName, sourceKeys: retained });
process.stdout.write(`${JSON.stringify({ documents: results.length, chunks: results.reduce((sum, item) => sum + Number(item.chunks || 0), 0), unchanged: results.filter((item) => item.unchanged).length, pruned: prune.removed || 0 })}\n`);
