import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

test('OpenAI-compatible embeddings are retried, ordered, batched, and dimension-checked', async (context) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ headers: request.headers, body });

    if (requests.length === 1) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'synthetic retry' } }));
      return;
    }

    const data = body.input.map((_, index) => ({
      index,
      embedding: Array.from({ length: 384 }, (unused, dimension) => index + dimension / 1000),
    })).reverse();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  process.env.EMBEDDING_API_URL = `http://127.0.0.1:${port}/v1/embeddings`;
  process.env.EMBEDDING_API_KEY = 'synthetic-test-key';
  process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  process.env.EMBEDDING_DIMENSION = '384';
  process.env.EMBEDDING_BATCH_SIZE = '2';
  process.env.EMBEDDING_MAX_RETRIES = '2';
  process.env.EMBEDDING_RETRY_BASE_MS = '1';

  const { embedTexts } = await import(`./embeddings.mjs?test=${Date.now()}`);
  const result = await embedTexts(['first', 'second', 'third']);

  assert.equal(result.length, 3);
  assert.ok(result.every((embedding) => embedding.length === 384));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1).map((entry) => entry.body.input.length), [2, 1]);
  assert.ok(requests.every((entry) => entry.headers.authorization === 'Bearer synthetic-test-key'));
  assert.ok(requests.every((entry) => entry.body.model === 'text-embedding-3-small'));
  assert.ok(requests.every((entry) => entry.body.dimensions === 384));
  assert.equal(result[0][1], 0.001);
});
