import http from 'node:http';

const host = process.env.DEEPSEEK_EVALUATOR_PROXY_HOST || '127.0.0.1';
const port = Number(process.env.DEEPSEEK_EVALUATOR_PROXY_PORT || 8791);
const apiKey = process.env.DEEPSEEK_API_KEY;
const upstreamBaseUrl = String(
  process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
).replace(/\/+$/, '');
const upstreamModel = 'deepseek-v4-pro';
const maximumBodyBytes = 2 * 1024 * 1024;
const requestTimeoutMs = 120_000;

if (!apiKey) {
  throw new Error('DEEPSEEK_API_KEY is required');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBodyBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function normalizeEvaluatorRequest(payload) {
  const normalized = {
    ...payload,
    model: upstreamModel,
    thinking: { type: 'disabled' },
  };

  if (normalized.response_format?.type === 'json_schema') {
    if (Array.isArray(normalized.tools) && normalized.tools.length > 0) {
      delete normalized.response_format;
    } else {
      normalized.response_format = { type: 'json_object' };
    }
  }

  if (normalized.response_format?.type === 'json_object') {
    const messages = Array.isArray(normalized.messages) ? [...normalized.messages] : [];
    const hasJsonInstruction = messages.some((message) => {
      if (typeof message?.content === 'string') {
        return /json/i.test(message.content);
      }
      if (Array.isArray(message?.content)) {
        return message.content.some(
          (part) => typeof part?.text === 'string' && /json/i.test(part.text),
        );
      }
      return false;
    });

    if (!hasJsonInstruction) {
      normalized.messages = [
        { role: 'system', content: 'Return a valid JSON object.' },
        ...messages,
      ];
    }
  }

  return normalized;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      status: 'ok',
      provider: 'deepseek',
      model: upstreamModel,
    });
    return;
  }

  const isCompletionRequest =
    request.method === 'POST' &&
    (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions');

  if (!isCompletionRequest) {
    sendJson(response, 404, { error: { message: 'Not found', type: 'not_found' } });
    return;
  }

  let timeout;
  try {
    const payload = normalizeEvaluatorRequest(await readJsonBody(request));
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    const upstreamResponse = await fetch(`${upstreamBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'multichannel-brain-langfuse-evaluator-proxy/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    response.writeHead(upstreamResponse.status, {
      'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    const statusCode = Number(error?.statusCode || (error?.name === 'AbortError' ? 504 : 502));
    sendJson(response, statusCode, {
      error: {
        message:
          statusCode < 500
            ? error.message
            : 'DeepSeek evaluator request failed',
        type: statusCode === 504 ? 'upstream_timeout' : 'upstream_error',
      },
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(port, host, () => {
  process.stdout.write(
    `DeepSeek evaluator proxy listening on http://${host}:${port} with ${upstreamModel}\n`,
  );
});

function shutdown() {
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
