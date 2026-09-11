import test from 'node:test';
import assert from 'node:assert/strict';
import { isSyntheticCrmContext } from './crm-test-classifier.mjs';

test('recognizes every supported synthetic CRM context', () => {
  const cases = [
    { channel: 'internal-test' },
    { channel: 'internal_test' },
    { channel: 'internal-e2e' },
    { channel: 'scenario_test' },
    { channel: 'diagnostic_test' },
    { metadata: { synthetic: true } },
    { metadata: { synthetic: 'true' } },
    { metadata: { test: '1' } },
    { metadata: { runtime: 'scenario' } },
    { metadata: { environment: 'diagnostic' } },
    { tenantKey: 'internal-test-sales' },
    { tenant_key: 'scenario_test_buyer' },
  ];

  for (const input of cases) {
    assert.equal(isSyntheticCrmContext(input), true, JSON.stringify(input));
  }
});

test('does not classify ordinary production traffic as synthetic', () => {
  assert.equal(isSyntheticCrmContext({
    channel: 'whatsapp',
    tenantKey: 'acme-production',
    metadata: { synthetic: false, runtime: 'production' },
  }), false);
});
