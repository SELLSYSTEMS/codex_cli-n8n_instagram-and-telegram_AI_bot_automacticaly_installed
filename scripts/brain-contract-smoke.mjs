import assert from 'node:assert/strict';
import {
  boundedHistory,
  compactCommercialAction,
  deriveSemanticState,
} from './semantic-state.mjs';
import { isExecutableCommercialAction } from './commercial-action-tool.mjs';

const prior = {
  intent: 'buy',
  material_blocker: 'Need a launch date',
  confirmed_commitments: ['Build a sales bot'],
  solution_scope: {
    channel: 'website',
    capabilities: ['help', 'sell'],
  },
};

const preserved = deriveSemanticState({
  intent: '',
  confirmed_commitments: [],
  solution_scope: {},
  semantic_state: {
    active_workstream: 'tea-store assistant',
  },
}, prior);

assert.equal(preserved.intent, 'buy');
assert.equal(preserved.material_blocker, 'Need a launch date');
assert.deepEqual(preserved.confirmed_commitments, ['Build a sales bot']);
assert.deepEqual(preserved.solution_scope, prior.solution_scope);
assert.equal(preserved.active_workstream, 'tea-store assistant');

const cleared = deriveSemanticState({
  semantic_state: {
    material_blocker: null,
  },
}, prior);
assert.equal(cleared.material_blocker, null);

const accumulated = deriveSemanticState({
  confirmed_commitments: ['Launch after one month', 'Build a sales bot'],
  solution_scope: {
    capabilities: ['qualify leads'],
  },
}, prior);
assert.deepEqual(accumulated.confirmed_commitments, [
  'Build a sales bot',
  'Launch after one month',
]);
assert.deepEqual(accumulated.solution_scope.capabilities, [
  'help',
  'sell',
  'qualify leads',
]);

assert.equal(compactCommercialAction({
  action_id: null,
  arguments: {
    grounded_total_usd: null,
  },
}), null);
assert.equal(compactCommercialAction({
  action_id: '  create_payment_link  ',
  arguments: {
    grounded_total_usd: 500,
  },
}).action_id, 'create_payment_link');

const history = Array.from({ length: 20 }, (_, index) => ({ sequence: index + 1 }));
const bounded = boundedHistory(history);
assert.equal(bounded.length, 12);
assert.equal(bounded[0].sequence, 9);
assert.equal(bounded.at(-1).sequence, 20);

const operationalCatalog = {
  checkout: {
    provider_configured: true,
    provider_name: 'test-provider',
    url: 'https://checkout.example.test/pay',
    deposit_enabled: true,
    deposit_fraction: 0.35,
    full_payment_enabled: false,
  },
  payment_options: [
    {
      id: 'deposit',
      enabled: true,
      fraction_of_grounded_total: 0.35,
    },
  ],
};

assert.equal(isExecutableCommercialAction({
  action_id: 'clarify_ambiguous_reference',
  enabled: true,
}, operationalCatalog), false);
assert.equal(isExecutableCommercialAction({
  action_id: 'present_checkout',
  enabled: true,
}, operationalCatalog), true);
assert.equal(isExecutableCommercialAction({
  action_id: 'present_checkout',
  enabled: false,
}, operationalCatalog), false);

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  checks: [
    'state-preservation',
    'explicit-nested-clear',
    'commitment-and-scope-accumulation',
    'commercial-action-compaction',
    'executable-tool-boundary',
    'bounded-history',
  ],
})}\n`);
