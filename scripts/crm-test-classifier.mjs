const SYNTHETIC_CHANNELS = new Set([
  'internal-test',
  'internal_test',
  'internal-e2e',
  'internal_e2e',
  'scenario-test',
  'scenario_test',
  'diagnostic-test',
  'diagnostic_test',
]);

const SYNTHETIC_RUNTIME_VALUES = new Set([
  'test',
  'testing',
  'scenario',
  'diagnostic',
  'synthetic',
  'internal-test',
  'internal_test',
  'internal-e2e',
  'internal_e2e',
]);

const SYNTHETIC_TENANT_KEYS = new Set([
  'internal-test',
  'internal_test',
  'internal-e2e',
  'internal_e2e',
  'scenario-test',
  'scenario_test',
  'diagnostic-test',
  'diagnostic_test',
]);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

function enabled(value) {
  return value === true || ['1', 'true', 'yes', 'on'].includes(normalized(value));
}

function syntheticTenant(tenantKey) {
  const value = normalized(tenantKey);
  return SYNTHETIC_TENANT_KEYS.has(value)
    || value.startsWith('internal-test-')
    || value.startsWith('internal_test_')
    || value.startsWith('internal-e2e-')
    || value.startsWith('internal_e2e_')
    || value.startsWith('scenario-test-')
    || value.startsWith('scenario_test_')
    || value.startsWith('diagnostic-test-')
    || value.startsWith('diagnostic_test_');
}

export function isSyntheticCrmContext({ channel, metadata, tenantKey, tenant_key: tenantKeySql } = {}) {
  const details = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return SYNTHETIC_CHANNELS.has(normalized(channel))
    || enabled(details.synthetic)
    || enabled(details.test)
    || SYNTHETIC_RUNTIME_VALUES.has(normalized(details.runtime))
    || SYNTHETIC_RUNTIME_VALUES.has(normalized(details.environment))
    || syntheticTenant(tenantKey ?? tenantKeySql);
}
