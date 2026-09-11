#!/usr/bin/env node

import assert from 'node:assert/strict';
import { normalizeDurableMemory } from './durable-memory.mjs';

const normalized = normalizeDurableMemory({
  current_objective: 'Launch a support bot',
  active_workstreams: [{
    workstream_id: 'support-bot',
    solution_scope: {
      channels: ['website', 'whatsapp'],
      deployment: { phase: 'v1', region: 'global' },
    },
  }],
});

assert.equal(normalized.active_workstreams[0].solution_scope.deployment.phase, 'v1');
assert.deepEqual(normalized.active_workstreams[0].solution_scope.channels, ['website', 'whatsapp']);
assert.notEqual(normalized.active_workstreams[0].solution_scope, '[object Object]');
console.log('durable-memory nested structure: pass');
