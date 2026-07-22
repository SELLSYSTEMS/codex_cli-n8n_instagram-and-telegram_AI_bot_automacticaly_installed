import { runBrain as runRawBrain } from './brain-graph.mjs';
import {
  flushTelemetry,
  telemetryEnabled,
  withBrainTrace,
  withObservation,
} from './telemetry.mjs';
import { publishRuntimeScores } from './langfuse-api.mjs';

function first(value, fallback = undefined) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function identity(input) {
  const tenantId = first(input?.tenantId, first(input?.tenant_id, 'default'));
  const channel = first(input?.channel, 'internal');
  const userId = first(input?.externalUserId, first(input?.external_user_id, first(input?.userId, 'anonymous')));
  const threadId = first(input?.threadId, first(input?.thread_id, `${channel}:${userId}`));
  return { tenantId, channel, userId, threadId };
}

function messageText(input) {
  return input?.text ?? input?.message?.text ?? input?.message ?? input?.input ?? '';
}

function retrievalOutput(result) {
  return result?.retrieval
    ?? result?.retrievedContext
    ?? result?.retrieved_context
    ?? result?.context?.knowledge
    ?? result?.knowledge
    ?? result?.evidence
    ?? [];
}

function memoryOutput(result) {
  return result?.memory ?? result?.state ?? result?.conversation ?? result?.thread ?? null;
}

export async function runBrain(input) {
  const id = identity(input);
  const tags = ['brain-api', id.channel, `tenant:${id.tenantId}`];
  let traceId = null;
  const instrumented = await withBrainTrace({
    name: 'brain.message',
    input,
    userId: `${id.tenantId}:${id.userId}`,
    sessionId: `${id.tenantId}:${id.threadId}`,
    tags,
    metadata: {
      tenantId: id.tenantId,
      channel: id.channel,
      threadId: id.threadId,
      scenarioId: input?.metadata?.scenarioId ?? input?.scenarioId,
      source: input?.metadata?.source ?? 'brain-api',
    },
  }, async ({ traceId: activeTraceId }) => {
    traceId = activeTraceId;
    const result = await withObservation('brain.agent', {
      type: 'agent',
      input: { message: messageText(input), identity: id },
      metadata: { graph: 'shared-brain', channel: id.channel },
    }, () => runRawBrain(input));

    await withObservation('memory.conversation', {
      type: 'span',
      input: { tenantId: id.tenantId, threadId: id.threadId, userId: id.userId },
      metadata: { store: 'postgresql', operation: 'load-and-persist' },
    }, async () => memoryOutput(result));

    await withObservation('rag.retrieve', {
      type: 'retriever',
      input: { query: messageText(input), tenantId: id.tenantId },
      metadata: { store: 'postgresql-pgvector' },
    }, async () => retrievalOutput(result));

    return {
      ...result,
      telemetry: {
        ...(result?.telemetry || {}),
        provider: 'langfuse',
        traceId: activeTraceId,
        enabled: telemetryEnabled(),
      },
    };
  });

  if (telemetryEnabled()) {
    await flushTelemetry();
    const publish = () => publishRuntimeScores(traceId, instrumented, { channel: id.channel, tenantId: id.tenantId });
    if (input?.metadata?.awaitTelemetry === true || id.channel === 'internal-test' || id.channel === 'scenario_test') {
      await publish();
    } else {
      setTimeout(() => publish().catch((error) => console.error('[langfuse-score]', error.message)), 750).unref?.();
    }
  }
  return instrumented;
}
