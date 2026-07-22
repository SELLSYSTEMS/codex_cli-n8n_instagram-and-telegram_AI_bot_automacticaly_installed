import path from 'node:path';
import { fileURLToPath } from 'node:url';
import onnxRuntime from 'onnxruntime-node';

const createSession = onnxRuntime.InferenceSession.create.bind(onnxRuntime.InferenceSession);
onnxRuntime.InferenceSession.create = (model, options = {}) => createSession(model, {
  ...options,
  intraOpNumThreads: Number(process.env.EMBEDDING_INTRA_OP_THREADS || 1),
  interOpNumThreads: Number(process.env.EMBEDDING_INTER_OP_THREADS || 1),
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/multilingual-e5-small';
const CACHE = process.env.LOCAL_EMBEDDING_CACHE || path.join(ROOT, '.runtime', 'models');
const DIMENSION = Number(process.env.LOCAL_EMBEDDING_DIMENSION || 384);

let extractorPromise;

async function extractor() {
  if (!extractorPromise) {
    extractorPromise = import('@xenova/transformers').then(async ({ pipeline, env }) => {
      env.cacheDir = CACHE;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      return pipeline('feature-extraction', MODEL, { quantized: true });
    });
  }
  return extractorPromise;
}

function normalizeRows(value, expected) {
  let rows = value;
  if (rows && typeof rows.tolist === 'function') rows = rows.tolist();
  if (!Array.isArray(rows)) throw new Error('Embedding model returned a non-array value');
  if (expected === 1 && rows.length === DIMENSION && typeof rows[0] === 'number') rows = [rows];
  if (rows.length !== expected) throw new Error('Embedding batch size mismatch');
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== DIMENSION) {
      throw new Error('Embedding dimension mismatch: expected ' + DIMENSION);
    }
  }
  return rows.map((row) => row.map(Number));
}

async function embed(texts, prefix) {
  const clean = texts.map((text) => prefix + String(text || '').replace(/\s+/g, ' ').trim());
  const model = await extractor();
  const output = await model(clean, { pooling: 'mean', normalize: true });
  return normalizeRows(output, clean.length);
}

export async function embedQueries(texts) {
  return embed(texts, 'query: ');
}

export async function embedQuery(text) {
  return (await embedQueries([text]))[0];
}

export async function embedPassages(texts) {
  return embed(texts, 'passage: ');
}

export function vectorLiteral(values) {
  if (!Array.isArray(values) || values.length !== DIMENSION) {
    throw new Error('Invalid vector dimension');
  }
  return '[' + values.map((value) => Number(value).toFixed(8)).join(',') + ']';
}

export const embeddingModel = MODEL;
export const embeddingDimension = DIMENSION;
