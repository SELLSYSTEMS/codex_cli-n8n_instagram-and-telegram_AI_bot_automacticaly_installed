const VERSION = 3;
const MAX_TEXT = 1200;
const MAX_SUMMARY = 2400;
const MAX_LIST = 12;
const MAX_WORKSTREAMS = 8;
const MAX_REFERENCES = 16;

function text(value, max = MAX_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return text(value, depth === 0 ? MAX_TEXT : 400);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return text(JSON.stringify(value), 400);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_LIST)
      .map((entry) => boundedValue(entry, depth + 1))
      .filter((entry) => entry !== null && entry !== '');
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 16)
        .map(([key, entry]) => [text(key, 80), boundedValue(entry, depth + 1)])
        .filter(([, entry]) => entry !== null && entry !== ''),
    );
  }
  return text(value, 400);
}

function list(value, max = MAX_LIST, itemMax = 400) {
  const input = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const output = [];
  for (const item of input) {
    const normalized = typeof item === 'object' && item !== null
      ? boundedValue(item, 1)
      : text(item, itemMax);
    const signature = JSON.stringify(normalized);
    if (!signature || signature === '""' || seen.has(signature)) continue;
    seen.add(signature);
    output.push(normalized);
    if (output.length >= max) break;
  }
  return output;
}

function sparseObject(value, maxFields = 16, itemMax = 400) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .slice(0, maxFields)
      .map(([key, entry]) => [text(key, 80), typeof entry === 'object' ? boundedValue(entry, 1) : text(entry, itemMax)])
      .filter(([, entry]) => entry !== null && entry !== ''),
  );
}

function first(source, ...keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key];
  }
  return undefined;
}

function boundedEnum(value, allowed, fallback) {
  const normalized = text(value, 80);
  return allowed.includes(normalized) ? normalized : fallback;
}

export function normalizeDurableMemory(candidate = {}, previous = {}) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const workstreams = first(source, 'active_workstreams', 'workstreams') ?? first(prior, 'active_workstreams') ?? [];
  const references = first(source, 'authoritative_evidence_references', 'evidence_references', 'evidence_ids')
    ?? first(prior, 'authoritative_evidence_references')
    ?? [];

  return {
    memory_schema_version: VERSION,
    current_objective: text(first(source, 'current_objective', 'objective', 'active_scope') ?? prior.current_objective, MAX_SUMMARY),
    active_workstreams: list(workstreams, MAX_WORKSTREAMS, 600),
    settled_customer_facts: list(first(source, 'settled_customer_facts', 'customer_facts', 'confirmed_facts') ?? prior.settled_customer_facts),
    confirmed_commitments: list(first(source, 'confirmed_commitments', 'commitments') ?? prior.confirmed_commitments),
    unresolved_material_question: text(first(source, 'unresolved_material_question', 'material_blocker', 'open_question') ?? prior.unresolved_material_question, MAX_TEXT),
    last_completed_outcome: text(first(source, 'last_completed_outcome', 'last_outcome', 'last_action') ?? prior.last_completed_outcome, MAX_SUMMARY),
    active_commercial_lifecycle: sparseObject(first(source, 'active_commercial_lifecycle', 'commercial_lifecycle', 'commercial_action') ?? prior.active_commercial_lifecycle, 12, 500),
    commercial_readiness: boundedEnum(
      first(source, 'commercial_readiness') ?? first(prior, 'commercial_readiness'),
      ['not_ready', 'considering', 'explicitly_ready'],
      'not_ready',
    ),
    scope_sufficiency: boundedEnum(
      first(source, 'scope_sufficiency') ?? first(prior, 'scope_sufficiency'),
      ['insufficient', 'proposal_ready', 'transaction_ready'],
      'insufficient',
    ),
    sparse_contact_profile: sparseObject(first(source, 'sparse_contact_profile', 'contact_profile') ?? prior.sparse_contact_profile, 16, 400),
    established_response_language: text(first(source, 'established_response_language', 'response_language') ?? prior.established_response_language, 80),
    authoritative_evidence_references: list(references, MAX_REFERENCES, 180),
  };
}

export function durableMemoryBytes(memory) {
  return Buffer.byteLength(JSON.stringify(normalizeDurableMemory(memory)), 'utf8');
}
