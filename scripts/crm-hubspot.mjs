import { setTimeout as sleep } from 'node:timers/promises';

try {
  process.loadEnvFile?.('.env');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const API_BASE = String(process.env.HUBSPOT_API_BASE_URL || 'https://api.hubapi.com').replace(/\/$/, '');
const PROPERTY_GROUP = 'brain_ai';
const UNIQUE_KEY_PROPERTY = 'brain_customer_key';

const propertyDefinitions = [
  { name: UNIQUE_KEY_PROPERTY, label: 'AI customer key', type: 'string', fieldType: 'text', hasUniqueValue: true },
  { name: 'brain_tenant_key', label: 'AI tenant', type: 'string', fieldType: 'text' },
  { name: 'brain_channels', label: 'Conversation channels', type: 'string', fieldType: 'text' },
  { name: 'brain_contact_language', label: 'Preferred conversation language', type: 'string', fieldType: 'text' },
  { name: 'brain_preferred_channel', label: 'Preferred future contact channel', type: 'string', fieldType: 'text' },
  { name: 'brain_preferred_contact_time', label: 'Preferred contact time', type: 'string', fieldType: 'text' },
  { name: 'brain_contact_timezone', label: 'Contact timezone', type: 'string', fieldType: 'text' },
  { name: 'brain_conversation_status', label: 'Conversation status', type: 'string', fieldType: 'text' },
  { name: 'brain_conversation_summary', label: 'Conversation summary', type: 'string', fieldType: 'textarea' },
  { name: 'brain_intent', label: 'Current intent', type: 'string', fieldType: 'text' },
  { name: 'brain_conversation_phase', label: 'Conversation phase', type: 'string', fieldType: 'text' },
  { name: 'brain_customer_readiness', label: 'Customer readiness', type: 'string', fieldType: 'text' },
  { name: 'brain_next_best_action', label: 'Next best action', type: 'string', fieldType: 'textarea' },
  { name: 'brain_commercial_progress', label: 'Commercial progress', type: 'string', fieldType: 'text' },
  { name: 'brain_decision_status', label: 'Decision status', type: 'string', fieldType: 'text' },
  { name: 'brain_last_action', label: 'Last agent action', type: 'string', fieldType: 'text' },
  { name: 'brain_last_confidence', label: 'Agent confidence', type: 'number', fieldType: 'number' },
  { name: 'brain_message_count', label: 'Conversation message count', type: 'number', fieldType: 'number' },
  {
    name: 'brain_escalated',
    label: 'Escalated to a human',
    type: 'bool',
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Yes', value: 'true', hidden: false, displayOrder: 0 },
      { label: 'No', value: 'false', hidden: false, displayOrder: 1 },
    ],
  },
  { name: 'brain_last_interaction_at', label: 'Last interaction at', type: 'string', fieldType: 'text' },
];

function token() {
  const value = String(process.env.HUBSPOT_ACCESS_TOKEN || '').trim();
  if (!value) throw new Error('HUBSPOT_ACCESS_TOKEN is required when HubSpot CRM sync is enabled');
  return value;
}

function text(value, limit = 65500) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, limit);
}

function withoutEmpty(properties) {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined && value !== null && String(value) !== ''),
  );
}

function retryDelay(response, attempt) {
  const header = response?.headers?.get('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  if (header) {
    const dateDelay = Date.parse(header) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(60_000, dateDelay);
  }
  return Math.min(30_000, 750 * (2 ** attempt) + Math.floor(Math.random() * 250));
}

function apiError(status, payload) {
  const message = payload?.message || payload?.error || `HubSpot request failed with HTTP ${status}`;
  const error = new Error(`HubSpot HTTP ${status}: ${text(message, 500)}`);
  error.status = status;
  error.category = payload?.category;
  error.correlationId = payload?.correlationId;
  return error;
}

export async function hubspotRequest(path, options = {}) {
  const method = options.method || 'GET';
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(Number(process.env.HUBSPOT_REQUEST_TIMEOUT_MS || 15000)),
      });
    } catch (error) {
      if (attempt + 1 >= maxAttempts) throw error;
      await sleep(Math.min(30_000, 750 * (2 ** attempt)));
      continue;
    }

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { message: raw };
      }
    }

    if (response.ok) return payload || {};
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < maxAttempts) {
      await sleep(retryDelay(response, attempt));
      continue;
    }
    throw apiError(response.status, payload);
  }

  throw new Error('HubSpot request exhausted retries');
}

export async function getHubSpotAccount() {
  const account = await hubspotRequest('/account-info/2026-03/details');
  return {
    portalId: String(account.portalId || ''),
    accountType: account.accountType || null,
    timeZone: account.timeZone || null,
    uiDomain: account.uiDomain || 'app.hubspot.com',
  };
}

async function ensurePropertyGroup() {
  const groups = await hubspotRequest('/crm/v3/properties/contacts/groups');
  if ((groups.results || []).some((group) => group.name === PROPERTY_GROUP)) return false;
  try {
    await hubspotRequest('/crm/v3/properties/contacts/groups', {
      method: 'POST',
      body: { name: PROPERTY_GROUP, label: 'AI Conversation', displayOrder: -1 },
    });
    return true;
  } catch (error) {
    if (error.status === 409) return false;
    throw error;
  }
}

export async function ensureHubSpotSchema() {
  const groupCreated = await ensurePropertyGroup();
  const existing = await hubspotRequest('/crm/v3/properties/contacts');
  const names = new Set((existing.results || []).map((property) => property.name));
  const created = [];

  for (const definition of propertyDefinitions) {
    if (names.has(definition.name)) continue;
    try {
      await hubspotRequest('/crm/v3/properties/contacts', {
        method: 'POST',
        body: {
          groupName: PROPERTY_GROUP,
          hidden: false,
          displayOrder: -1,
          ...definition,
        },
      });
      created.push(definition.name);
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  return { groupCreated, created, totalManagedProperties: propertyDefinitions.length };
}

function profileValue(profile, ...keys) {
  for (const key of keys) {
    const value = profile?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function contactProperties(snapshot) {
  const state = snapshot.conversation?.semantic_state || {};
  const profile = snapshot.contact.profile || {};
  const channels = [...new Set(snapshot.identities.map((identity) => identity.channel).filter(Boolean))];
  const email = profileValue(profile, 'email', 'email_address');
  const phone = profileValue(profile, 'phone', 'phone_number');

  return withoutEmpty({
    [UNIQUE_KEY_PROPERTY]: snapshot.customerKey,
    firstname: text(profile.name || profile.full_name, 255),
    email: text(email, 255),
    phone: text(phone, 64),
    company: text(profile.company, 255),
    jobtitle: text(profile.role, 255),
    brain_tenant_key: text(snapshot.tenant.key, 255),
    brain_channels: text(channels.join(', '), 1000),
    brain_contact_language: text(profile.language, 255),
    brain_preferred_channel: text(profile.preferred_contact_channel, 255),
    brain_preferred_contact_time: text(profile.preferred_contact_time, 255),
    brain_contact_timezone: text(profile.timezone, 255),
    brain_conversation_status: text(snapshot.conversation?.status || 'active', 255),
    brain_conversation_summary: text(snapshot.conversation?.summary, 65000),
    brain_intent: text(state.intent, 1000),
    brain_conversation_phase: text(state.conversation_phase, 1000),
    brain_customer_readiness: text(state.customer_readiness, 1000),
    brain_next_best_action: text(state.next_best_action, 65000),
    brain_commercial_progress: text(state.commercial_progress, 1000),
    brain_decision_status: text(state.decision_status, 1000),
    brain_last_action: text(state.last_action, 1000),
    brain_last_confidence: Number.isFinite(Number(state.last_confidence)) ? String(Number(state.last_confidence)) : '',
    brain_message_count: String(snapshot.messageCount || 0),
    brain_escalated: snapshot.conversation?.escalated_at ? 'true' : 'false',
    brain_last_interaction_at: text(snapshot.conversation?.updated_at || snapshot.contact.updated_at, 255),
  });
}

async function searchContact(customerKey) {
  const response = await hubspotRequest('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName: UNIQUE_KEY_PROPERTY, operator: 'EQ', value: customerKey }] }],
      properties: [UNIQUE_KEY_PROPERTY, 'email', 'phone'],
      limit: 1,
    },
  });
  return response.results?.[0] || null;
}

async function searchContactByProperty(propertyName, value) {
  if (!value) return null;
  const response = await hubspotRequest('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: {
      filterGroups: [{
        filters: [{ propertyName, operator: 'EQ', value }],
      }],
      properties: [
        'email', 'firstname', 'lastname', 'phone', 'company', UNIQUE_KEY_PROPERTY,
      ],
      limit: 1,
    },
  });
  return response.results?.[0] || null;
}

async function upsertContact(snapshot) {
  const properties = contactProperties(snapshot);
  const profile = snapshot.contact.profile || {};

  if (snapshot.link?.external_contact_id) {
    try {
      return await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(snapshot.link.external_contact_id)}`, {
        method: 'PATCH',
        body: { properties },
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  const identified = Boolean(
    properties.email
    || properties.phone
    || properties.firstname
    || properties.company
    || profileValue(profile, 'name', 'full_name')
  );
  if (!identified) {
    return { skipped: true, reason: 'contact_profile_not_identified' };
  }
  let existing = null;

  existing = await searchContact(snapshot.customerKey)
    || await searchContactByProperty('email', properties.email)
    || await searchContactByProperty('phone', properties.phone);
  if (existing?.id) {
    return hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      body: { properties },
    });
  }

  try {
    return await hubspotRequest('/crm/v3/objects/contacts', {
      method: 'POST',
      body: { properties },
    });
  } catch (error) {
    if (error.status !== 409) throw error;
    existing = await searchContact(snapshot.customerKey)
      || await searchContactByProperty('email', properties.email)
      || await searchContactByProperty('phone', properties.phone);
    if (!existing?.id) throw error;
    return hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH',
      body: { properties },
    });
  }
}

function escapeHtml(value) {
  return text(value, 20000)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function noteBody(snapshot, eventKey) {
  const state = snapshot.conversation?.semantic_state || {};
  const inbound = snapshot.latestInbound?.content || '';
  const outbound = snapshot.latestOutbound?.content || '';
  return [
    '<h3>AI conversation checkpoint</h3>',
    `<p><strong>Channel:</strong> ${escapeHtml(snapshot.conversation?.channel || snapshot.identities[0]?.channel || 'unknown')}</p>`,
    `<p><strong>Phase:</strong> ${escapeHtml(state.conversation_phase || 'unknown')}<br>`,
    `<strong>Readiness:</strong> ${escapeHtml(state.customer_readiness || 'unknown')}<br>`,
    `<strong>Next best action:</strong> ${escapeHtml(state.next_best_action || 'not set')}</p>`,
    snapshot.conversation?.summary ? `<p><strong>Summary:</strong> ${escapeHtml(snapshot.conversation.summary)}</p>` : '',
    inbound ? `<p><strong>Customer:</strong> ${escapeHtml(inbound)}</p>` : '',
    outbound ? `<p><strong>Assistant:</strong> ${escapeHtml(outbound)}</p>` : '',
    `<p><small>Event ${escapeHtml(eventKey)}</small></p>`,
  ].filter(Boolean).join('\n').slice(0, 65000);
}

async function createConversationNote(contactId, snapshot, eventKey) {
  if (String(process.env.HUBSPOT_CREATE_NOTES || 'true').toLowerCase() !== 'true') return null;
  if (!snapshot.latestInbound && !snapshot.latestOutbound) return null;
  const associationTypeId = Number(process.env.HUBSPOT_NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID || 202);
  return hubspotRequest('/crm/v3/objects/notes', {
    method: 'POST',
    body: {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: noteBody(snapshot, eventKey),
      },
      associations: [{
        to: { id: String(contactId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }],
      }],
    },
  });
}

let schemaPromise;

export async function projectToHubSpot(snapshot, job) {
  schemaPromise ||= ensureHubSpotSchema().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;

  const account = await getHubSpotAccount();
  const contact = await upsertContact(snapshot);
  if (contact.skipped) {
    return {
      skipped: true,
      skipReason: contact.reason,
      externalContactId: snapshot.link?.external_contact_id || null,
      externalRecordUrl: snapshot.link?.external_record_url || null,
      syncState: {
        ...(snapshot.link?.sync_state || {}),
        lastEventKey: job.dedupe_key,
        lastSkippedAt: new Date().toISOString(),
        lastSkipReason: contact.reason,
      },
    };
  }
  const previousEvent = snapshot.link?.sync_state?.lastNoteEventKey;
  const note = previousEvent === job.dedupe_key
    ? null
    : await createConversationNote(contact.id, snapshot, job.dedupe_key);
  const recordUrl = account.portalId
    ? `https://${account.uiDomain}/contacts/${account.portalId}/record/0-1/${contact.id}`
    : null;

  return {
    externalContactId: String(contact.id),
    externalRecordUrl: recordUrl,
    syncState: {
      lastEventKey: job.dedupe_key,
      lastNoteEventKey: note?.id ? job.dedupe_key : previousEvent || null,
      lastNoteId: note?.id ? String(note.id) : snapshot.link?.sync_state?.lastNoteId || null,
      lastSyncedAt: new Date().toISOString(),
    },
  };
}
