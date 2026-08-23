#!/usr/bin/env node
import { evaluateTrace, listRecentBrainTraces } from './langfuse-judge.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const explicitTrace = argument('--trace-id');
const limit = Number(argument('--limit', explicitTrace ? 1 : 10));
const force = process.argv.includes('--force');
const traces = explicitTrace ? [{ id: explicitTrace }] : await listRecentBrainTraces(limit);

if (!traces.length) {
  console.log(JSON.stringify({ status: 'no_traces' }));
  process.exit(0);
}

let failures = 0;
for (const trace of traces) {
  try {
    const result = await evaluateTrace(trace.id, { force, sampleRate: force ? 1 : undefined });
    console.log(JSON.stringify(result));
  } catch (error) {
    failures += 1;
    console.error(
      JSON.stringify({
        trace_id: trace.id,
        status: 'error',
        message: error.message,
        detail: error.payload || null,
      }),
    );
  }
}

process.exitCode = failures ? 1 : 0;
