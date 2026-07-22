import {
  ensureDataset,
  ensureDatasetItem,
  ensureModel,
  ensureScoreConfig,
} from './langfuse-api.mjs';

const dataset = {
  name: 'brain-production-acceptance-v1',
  description: 'Generic, company-neutral acceptance cases for a multichannel conversational Brain.',
  metadata: { owner: 'platform', purpose: 'regression-and-demo', version: 1 },
  inputSchema: {
    type: 'object',
    required: ['scenarioId', 'message'],
    properties: { scenarioId: { type: 'string' }, message: { type: 'string' }, history: { type: 'array' } },
  },
  expectedOutputSchema: {
    type: 'object',
    properties: { behavior: { type: 'string' }, prohibited: { type: 'array' } },
  },
};

const cases = [
  {
    scenarioId: 'vague-discovery',
    message: 'We may need an AI assistant, but I am not sure what should be automated.',
    expected: { behavior: 'Understand the business situation before proposing a transaction.', prohibited: ['invented facts', 'premature payment request'] },
  },
  {
    scenarioId: 'context-continuity',
    message: 'Which of the two options we discussed would you choose for my team?',
    history: [{ role: 'user', content: 'We have a small support team and many repeated questions.' }],
    expected: { behavior: 'Use prior conversation context and avoid restarting discovery.', prohibited: ['claiming no context'] },
  },
  {
    scenarioId: 'commercial-readiness',
    message: 'The scope and price work for me. What exactly do you need from us to start?',
    expected: { behavior: 'Provide a concrete, safe next step without reopening solved discovery.', prohibited: ['unnecessary generic pitch'] },
  },
  {
    scenarioId: 'objection',
    message: 'This sounds useful, but the risk and implementation effort worry me.',
    expected: { behavior: 'Explore the real concern and reduce uncertainty with relevant evidence.', prohibited: ['pressure', 'fabricated guarantee'] },
  },
  {
    scenarioId: 'escalation-reset',
    message: 'A human resolved the issue and reset the handoff. Continue helping me with the next step.',
    expected: { behavior: 'Resume naturally after an explicit escalation reset.', prohibited: ['repeating the handoff notice'] },
  },
];

const booleanScores = [
  'response_contract_valid',
  'reply_policy_consistent',
  'memory_state_returned',
  'model_route_recorded',
  'commercial_action_valid',
  'escalation_policy_consistent',
  'golden_trace_verified',
];

await ensureDataset(dataset);
for (const item of cases) {
  await ensureDatasetItem(dataset.name, {
    input: { scenarioId: item.scenarioId, message: item.message, history: item.history || [] },
    expectedOutput: item.expected,
    metadata: { scenarioId: item.scenarioId, category: 'acceptance', generic: true },
    status: 'ACTIVE',
  });
}
for (const name of booleanScores) {
  await ensureScoreConfig({ name, dataType: 'BOOLEAN', description: `Automated ${name.replaceAll('_', ' ')} check.` });
}
await ensureScoreConfig({
  name: 'scenario_quality',
  dataType: 'NUMERIC',
  minValue: 0,
  maxValue: 1,
  description: 'Normalized scenario quality score from the regression harness.',
});

await ensureModel({
  modelName: 'deepseek-chat-current',
  matchPattern: '^(deepseek-chat)$',
  unit: 'TOKENS',
  inputPrice: 0.00000027,
  outputPrice: 0.00000110,
  startDate: '2026-01-01T00:00:00.000Z',
});
await ensureModel({
  modelName: 'deepseek-reasoner-current',
  matchPattern: '^(deepseek-reasoner)$',
  unit: 'TOKENS',
  inputPrice: 0.00000055,
  outputPrice: 0.00000219,
  startDate: '2026-01-01T00:00:00.000Z',
});

console.log(JSON.stringify({
  ok: true,
  dataset: dataset.name,
  datasetItems: cases.length,
  scoreConfigs: booleanScores.length + 1,
  models: ['deepseek-chat', 'deepseek-reasoner'],
}, null, 2));
