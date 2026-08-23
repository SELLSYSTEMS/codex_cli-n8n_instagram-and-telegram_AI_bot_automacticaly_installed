#!/usr/bin/env node
import { evaluateTrace, listRecentBrainTraces } from './langfuse-judge.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const daemon = process.argv.includes('--daemon');
const force = process.argv.includes('--force');
const limit = Number(argument('--limit', process.env.LANGFUSE_LLM_JUDGE_BATCH_SIZE || 25));
const pollMs = Number(argument('--poll-ms', process.env.LANGFUSE_LLM_JUDGE_POLL_MS || 15000));
let stopping = false;

async function cycle() {
  const traces = await listRecentBrainTraces(limit);
  const summary = { inspected: traces.length, evaluated: 0, skipped: 0, failed: 0 };
  for (const trace of traces.reverse()) {
    if (stopping) break;
    try {
      const result = await evaluateTrace(trace.id, { force, sampleRate: force ? 1 : undefined });
      if (result.status === 'evaluated') summary.evaluated += 1;
      else summary.skipped += 1;
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    } catch (error) {
      summary.failed += 1;
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          trace_id: trace.id,
          status: 'error',
          message: error.message,
        }),
      );
    }
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), cycle: summary }));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
  });
}

do {
  await cycle();
  if (!daemon || stopping) break;
  await new Promise((resolve) => setTimeout(resolve, pollMs));
} while (!stopping);
