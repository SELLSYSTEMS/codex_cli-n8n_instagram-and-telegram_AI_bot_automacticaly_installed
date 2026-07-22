import { langfuseRequest, rows } from './langfuse-api.mjs';

const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');
const keep = new Set(process.argv.filter((value) => value.startsWith('--keep=')).map((value) => value.slice('--keep='.length)));
const batchSizeArgument = process.argv.find((value) => value.startsWith('--batch-size='));
const batchSize = Number(batchSizeArgument?.slice('--batch-size='.length) ?? 20);

if (!all) throw new Error('Refusing cleanup without --all. Add --dry-run for a preview.');
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
  throw new Error('--batch-size must be an integer between 1 and 50.');
}

const pageSize = 100;
const traceById = new Map();

for (let page = 1; ; page += 1) {
  const response = await langfuseRequest('traces', { query: { limit: pageSize, page } });
  const pageRows = rows(response);
  for (const trace of pageRows) traceById.set(trace.id, trace);

  const totalPages = Number(response?.meta?.totalPages ?? response?.meta?.total_pages ?? 0);
  if (!pageRows.length || (totalPages > 0 && page >= totalPages) || (totalPages === 0 && pageRows.length < pageSize)) break;
  if (page >= 10_000) throw new Error('Cleanup pagination exceeded 10,000 pages.');
}

const traces = [...traceById.values()];
const targets = traces.filter((trace) => !keep.has(trace.id));

if (dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    scanned: traces.length,
    wouldDelete: targets.length,
    preview: targets.slice(0, 100).map((item) => ({ id: item.id, name: item.name, timestamp: item.timestamp })),
    kept: [...keep],
  }, null, 2));
  process.exit(0);
}

let deleted = 0;
for (let offset = 0; offset < targets.length; offset += batchSize) {
  const batch = targets.slice(offset, offset + batchSize);
  const results = await Promise.allSettled(batch.map((trace) => langfuseRequest(`traces/${trace.id}`, { method: 'DELETE' })));
  const failures = results
    .map((result, index) => ({ result, trace: batch[index] }))
    .filter(({ result }) => result.status === 'rejected');

  deleted += batch.length - failures.length;
  process.stderr.write(`Deleted ${deleted}/${targets.length} Langfuse traces\n`);

  if (failures.length) {
    const details = failures.map(({ result, trace }) => `${trace.id}: ${result.reason?.message ?? result.reason}`).join('\n');
    throw new Error(`Failed to delete ${failures.length} Langfuse traces:\n${details}`);
  }
}

console.log(JSON.stringify({ ok: true, dryRun: false, scanned: traces.length, deleted, kept: [...keep] }, null, 2));
