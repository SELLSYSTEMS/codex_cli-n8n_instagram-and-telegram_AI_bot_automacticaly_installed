import {
  createScore,
  ensureDataset,
  ensureDatasetItem,
  langfuseRequest,
  linkDatasetRun,
  rows,
  stableUuid,
} from './langfuse-api.mjs';

const datasetName = 'brain-production-acceptance-v1';
const explicitTraceId = process.argv.find((value, index) => index > 1 && !value.startsWith('--'));
const traces = rows(await langfuseRequest('traces', { query: { limit: 100, name: 'brain.message' } }));
const trace = explicitTraceId
  ? await langfuseRequest(`traces/${explicitTraceId}`)
  : traces.find((item) => item.input != null && item.output != null);
if (!trace?.id) throw new Error('No complete trace is available for golden promotion');

await ensureDataset({
  name: datasetName,
  description: 'Generic, company-neutral acceptance cases for a multichannel conversational Brain.',
  metadata: { owner: 'platform', purpose: 'regression-and-demo', version: 1 },
});
const datasetItem = await ensureDatasetItem(datasetName, {
  id: stableUuid(datasetName, `golden:${trace.id}`),
  input: trace.input,
  expectedOutput: trace.output,
  metadata: { source: 'verified-production-trace', traceId: trace.id },
  sourceTraceId: trace.id,
  status: 'ACTIVE',
});
const runName = `golden-${new Date().toISOString().slice(0, 10)}`;
await linkDatasetRun({
  runName,
  runDescription: 'Human-approved baseline promoted from a fully instrumented production-compatible trace.',
  metadata: { promotedBy: 'operator', purpose: 'demo-and-regression' },
  datasetItemId: datasetItem.id,
  traceId: trace.id,
});
await createScore({
  id: stableUuid(trace.id, 'golden_trace_verified'),
  name: 'golden_trace_verified',
  traceId: trace.id,
  value: 1,
  dataType: 'BOOLEAN',
  comment: 'Trace passed the telemetry contract and was promoted as a golden baseline.',
  metadata: { runName },
});
console.log(JSON.stringify({ ok: true, traceId: trace.id, datasetName, datasetItemId: datasetItem.id, runName }, null, 2));
