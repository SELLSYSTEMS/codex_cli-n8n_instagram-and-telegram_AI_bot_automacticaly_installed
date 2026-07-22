import { readFileSync } from 'node:fs';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  createObservationAttributes,
  createTraceAttributes,
  propagateAttributes,
} from '@langfuse/tracing';

function loadEnvFile(path = '.env') {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch {
    // Runtime environments may inject variables without a local file.
  }
}

loadEnvFile();

const enabled = Boolean(
  process.env.LANGFUSE_PUBLIC_KEY
  && process.env.LANGFUSE_SECRET_KEY
  && (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST),
);
const captureContent = process.env.LANGFUSE_CAPTURE_CONTENT !== 'false';
const redactPii = process.env.LANGFUSE_REDACT_PII === 'true';
const maxString = Number(process.env.LANGFUSE_MAX_STRING_LENGTH || 32000);
const maxArray = Number(process.env.LANGFUSE_MAX_ARRAY_LENGTH || 100);
const maxDepth = Number(process.env.LANGFUSE_MAX_DEPTH || 10);

const secretKeyPattern = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|cookie|set-cookie|signature|secret)/i;
const secretValuePatterns = [
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bEAA[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

function sanitizeString(value) {
  let result = value;
  for (const pattern of secretValuePatterns) result = result.replace(pattern, '[REDACTED_SECRET]');
  if (redactPii) {
    result = result
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/(?<!\w)\+?\d[\d ()-]{7,}\d(?!\w)/g, '[REDACTED_PHONE]');
  }
  if (result.length > maxString) return `${result.slice(0, maxString)}...[TRUNCATED:${result.length - maxString}]`;
  return result;
}

export function sanitizeTelemetry(value, depth = 0, seen = new WeakSet()) {
  if (!captureContent && depth > 0) return '[CONTENT_CAPTURE_DISABLED]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object') return String(value);
  if (depth >= maxDepth) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, maxArray).map((item) => sanitizeTelemetry(item, depth + 1, seen));
    if (value.length > maxArray) result.push(`[TRUNCATED:${value.length - maxArray}]`);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = secretKeyPattern.test(key) ? '[REDACTED_SECRET]' : sanitizeTelemetry(item, depth + 1, seen);
  }
  return result;
}

let sdk;
let processor;
if (enabled) {
  processor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST,
    exportMode: 'immediate',
    shouldExportSpan: ({ otelSpan }) =>
      otelSpan.attributes['langfuse.observation.type'] !== undefined
      || otelSpan.attributes['langfuse.trace.name'] !== undefined,
  });
  sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
}

const tracer = trace.getTracer('multichannel-brain', '1.0.0');

function compact(value) {
  return value === undefined ? undefined : sanitizeTelemetry(value);
}

function propagationMetadata(value = {}) {
  return Object.fromEntries(
    Object.entries(compact(value) || {}).flatMap(([key, item]) => {
      if (item === undefined) return [];
      return [[key, typeof item === 'string' ? item : JSON.stringify(item)]];
    }),
  );
}

function observationAttributes(options = {}) {
  return createObservationAttributes(options.type || 'span', {
    name: options.name,
    input: compact(options.input),
    output: compact(options.output),
    metadata: compact(options.metadata),
    model: options.model,
    modelParameters: compact(options.modelParameters),
    usageDetails: options.usageDetails,
    costDetails: options.costDetails,
    level: options.level,
    statusMessage: options.statusMessage,
  });
}

export async function withObservation(name, options, fn) {
  if (!enabled) return fn(null);
  return tracer.startActiveSpan(name, { attributes: observationAttributes({ ...options, name }) }, async (span) => {
    const startedAt = Date.now();
    try {
      const output = await fn(span);
      if (options.captureResult !== false) {
        span.setAttributes(observationAttributes({ name, ...options, output }));
      }
      span.setAttribute('app.latency_ms', Date.now() - startedAt);
      span.setStatus({ code: SpanStatusCode.OK });
      return output;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.setAttributes(observationAttributes({
        name,
        ...options,
        level: 'ERROR',
        statusMessage: error.message,
        output: { error: error.message },
      }));
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function withBrainTrace(options, fn) {
  if (!enabled) return fn({ traceId: null, span: null });
  const name = options.name || 'brain.message';
  const traceContext = {
    traceName: name,
    userId: options.userId == null ? undefined : String(options.userId),
    sessionId: options.sessionId == null ? undefined : String(options.sessionId),
    metadata: propagationMetadata({
      ...options.metadata,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.NODE_ENV || 'production',
    }),
    tags: Array.isArray(options.tags) ? options.tags.map(String) : undefined,
    version: process.env.BRAIN_VERSION || 'local',
  };
  const attributes = {
    ...createTraceAttributes({
      input: compact(options.input),
    }),
    ...observationAttributes({ name, type: 'agent', input: options.input, metadata: options.metadata }),
  };
  return propagateAttributes(traceContext, () => tracer.startActiveSpan(name, { attributes }, async (span) => {
    const traceId = span.spanContext().traceId;
    try {
      const output = await fn({ traceId, span });
      span.setAttributes({
        ...createTraceAttributes({ output: compact(output) }),
        ...observationAttributes({ name, type: 'agent', output }),
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return output;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.setAttributes({
        ...createTraceAttributes({ output: { error: error.message } }),
        ...observationAttributes({ name, type: 'agent', level: 'ERROR', statusMessage: error.message }),
      });
      throw error;
    } finally {
      span.end();
    }
  }));
}

function parseBody(body) {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch { return null; }
}

function modelRequest(url, init) {
  let parsed;
  try { parsed = new URL(typeof url === 'string' ? url : url.url); } catch { return null; }
  const deepseek = parsed.hostname === 'api.deepseek.com';
  const openai = parsed.hostname === 'api.openai.com';
  if ((!deepseek && !openai) || !/(chat\/completions|responses)$/.test(parsed.pathname)) return null;
  return { provider: deepseek ? 'deepseek' : 'openai', body: parseBody(init?.body), url: parsed };
}

function usageFrom(provider, usage = {}) {
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? input + output;
  const hit = usage.prompt_cache_hit_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, input - hit);
  return {
    input,
    output,
    total,
    cache_read_input_tokens: hit,
    cache_creation_input_tokens: provider === 'deepseek' ? miss : 0,
  };
}

function deepseekCost(model, usage) {
  const reasoner = /reasoner/i.test(model || '');
  const hitRate = reasoner ? 0.14 : 0.07;
  const missRate = reasoner ? 0.55 : 0.27;
  const outputRate = reasoner ? 2.19 : 1.10;
  const input = ((usage.cache_read_input_tokens || 0) * hitRate
    + (usage.cache_creation_input_tokens || 0) * missRate) / 1_000_000;
  const output = (usage.output || 0) * outputRate / 1_000_000;
  return { input, output, total: input + output };
}

function responseOutput(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.output !== undefined) return data.output;
  if (data.choices !== undefined) return data.choices;
  return data;
}

const fetchMarker = Symbol.for('multichannel-brain.langfuse.fetch');
if (enabled && globalThis.fetch && !globalThis[fetchMarker]) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (url, init = {}) => {
    const request = modelRequest(url, init);
    if (!request) return nativeFetch(url, init);
    const model = request.body?.model || 'unknown';
    const input = request.body?.messages ?? request.body?.input ?? request.body;
    const modelParameters = request.body
      ? Object.fromEntries(Object.entries(request.body).filter(([key]) => !['messages', 'input', 'tools'].includes(key)))
      : {};
    return tracer.startActiveSpan(`${request.provider}.${model}`, {
      attributes: observationAttributes({
        name: `${request.provider}.${model}`,
        type: 'generation',
        input,
        model,
        modelParameters,
        metadata: {
          provider: request.provider,
          endpoint: request.url.pathname,
          tools: request.body?.tools,
        },
      }),
    }, async (span) => {
      const startedAt = Date.now();
      try {
        const response = await nativeFetch(url, init);
        let data;
        try { data = await response.clone().json(); } catch { data = null; }
        const usage = usageFrom(request.provider, data?.usage);
        const cost = request.provider === 'deepseek' ? deepseekCost(model, usage) : undefined;
        span.setAttributes(observationAttributes({
          name: `${request.provider}.${model}`,
          type: 'generation',
          input,
          output: responseOutput(data),
          model,
          modelParameters,
          usageDetails: usage,
          costDetails: cost,
          level: response.ok ? 'DEFAULT' : 'ERROR',
          statusMessage: response.ok ? undefined : `HTTP ${response.status}`,
          metadata: {
            provider: request.provider,
            endpoint: request.url.pathname,
            httpStatus: response.status,
            latencyMs: Date.now() - startedAt,
            providerRequestId: response.headers.get('x-request-id') || data?.id,
            cacheHitTokens: usage.cache_read_input_tokens,
            cacheMissTokens: usage.cache_creation_input_tokens,
          },
        }));
        span.setAttribute('http.response.status_code', response.status);
        span.setAttribute('app.latency_ms', Date.now() - startedAt);
        span.setStatus({ code: response.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        return response;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.setAttributes(observationAttributes({
          name: `${request.provider}.${model}`,
          type: 'generation',
          model,
          input,
          output: { error: error.message },
          level: 'ERROR',
          statusMessage: error.message,
        }));
        throw error;
      } finally {
        span.end();
      }
    });
  };
  globalThis[fetchMarker] = true;
}

export async function flushTelemetry() {
  if (!enabled) return;
  await processor?.forceFlush?.();
}

export async function shutdownTelemetry() {
  if (!enabled) return;
  await processor?.forceFlush?.();
  await sdk?.shutdown?.();
}

export function telemetryEnabled() {
  return enabled;
}

export function activeTraceId() {
  return trace.getSpan(context.active())?.spanContext().traceId || null;
}
