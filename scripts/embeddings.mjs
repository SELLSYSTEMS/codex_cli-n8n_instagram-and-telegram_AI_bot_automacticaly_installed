const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const API_URL = process.env.EMBEDDING_API_URL
  || process.env.OPENAI_EMBEDDING_API_URL
  || 'https://api.openai.com/v1/embeddings';

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL
  || process.env.EMBEDDING_MODEL
  || 'text-embedding-3-small';

export const EMBEDDING_DIMENSION = positiveInteger(process.env.EMBEDDING_DIMENSION, 384);
export const EMBEDDING_FINGERPRINT = `openai-compatible:${EMBEDDING_MODEL}:${EMBEDDING_DIMENSION}`;

const API_KEY = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '';
const BATCH_SIZE = positiveInteger(process.env.EMBEDDING_BATCH_SIZE, 64);
const TIMEOUT_MS = positiveInteger(process.env.EMBEDDING_TIMEOUT_MS, 30_000);
const MAX_RETRIES = positiveInteger(process.env.EMBEDDING_MAX_RETRIES, 2);
const RETRY_BASE_MS = positiveInteger(process.env.EMBEDDING_RETRY_BASE_MS, 400);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function validateEmbedding(value, expectedIndex) {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSION) {
    throw new Error(`Embedding ${expectedIndex} has an invalid dimension`);
  }

  if (value.some((number) => !Number.isFinite(number))) {
    throw new Error(`Embedding ${expectedIndex} contains a non-finite value`);
  }

  return value;
}

async function requestBatch(input) {
  if (!API_KEY) {
    throw new Error('EMBEDDING_API_KEY or OPENAI_API_KEY is required');
  }

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input,
          encoding_format: 'float',
          dimensions: EMBEDDING_DIMENSION,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        const error = new Error(`Embedding provider returned HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }

      const payload = await response.json();
      if (!Array.isArray(payload.data) || payload.data.length !== input.length) {
        throw new Error('Embedding provider returned an invalid item count');
      }

      return payload.data
        .slice()
        .sort((left, right) => left.index - right.index)
        .map((item, index) => {
          if (item.index !== index) {
            throw new Error('Embedding provider returned invalid indexes');
          }
          return validateEmbedding(item.embedding, index);
        });
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable === true
        || error?.name === 'AbortError'
        || error instanceof TypeError;

      if (!retryable || attempt >= MAX_RETRIES) {
        throw error;
      }

      await sleep(RETRY_BASE_MS * (2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export async function embedTexts(texts) {
  if (!Array.isArray(texts)) {
    throw new TypeError('embedTexts expects an array');
  }

  if (texts.length === 0) {
    return [];
  }

  const normalized = texts.map((text) => {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new TypeError('Every embedding input must be a non-empty string');
    }
    return text;
  });

  const embeddings = [];
  for (let index = 0; index < normalized.length; index += BATCH_SIZE) {
    embeddings.push(...await requestBatch(normalized.slice(index, index + BATCH_SIZE)));
  }
  return embeddings;
}

export async function embedQuery(text) {
  const [embedding] = await embedTexts([text]);
  return embedding;
}

export async function embedPassages(texts) {
  return embedTexts(texts);
}

export function vectorLiteral(embedding) {
  if (
    !Array.isArray(embedding)
    || embedding.length !== EMBEDDING_DIMENSION
    || embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Expected a finite ${EMBEDDING_DIMENSION}-dimensional embedding`);
  }

  return `[${embedding.join(',')}]`;
}
