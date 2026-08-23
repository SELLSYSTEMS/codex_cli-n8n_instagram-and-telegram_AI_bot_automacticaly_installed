# Replaceable CRM projection

## Purpose

The Brain owns conversation truth in local PostgreSQL. A CRM is an asynchronous, replaceable projection for operators, sales teams, and demonstrations. The first adapter targets HubSpot, but no channel or reasoning code imports HubSpot semantics.

## Data flow

```text
channel -> Brain API -> local PostgreSQL -> durable CRM outbox -> CRM adapter -> HubSpot
```

- The customer reply completes before an external CRM call is required.
- Every completed turn enqueues an idempotent outbox event.
- A stable internal customer UUID becomes the unique CRM key.
- Email and phone are enrichment attributes, not identity-merging rules.
- Contact properties show the latest semantic state.
- Associated notes show conversation checkpoints and recent messages.
- `429` and `5xx` responses are retried with bounded exponential backoff.
- Failed jobs remain visible in PostgreSQL and do not interrupt a channel.

## HubSpot demo surface

The setup command creates a property group named **AI Conversation**. Each synchronized contact then exposes:

- tenant and connected channels;
- current conversation status and summary;
- intent, phase, readiness, commercial progress, and decision status;
- model-selected next best action and latest action;
- confidence, message count, escalation state, and last interaction time;
- associated conversation checkpoint notes.

This is intentionally a compact operator view rather than a second source of memory.

## Configure locally

Real values belong only in the ignored `.env` file:

```dotenv
CRM_SYNC_ENABLED=true
CRM_PROVIDER=hubspot
CRM_WORKER_INTERVAL_MS=5000
CRM_MAX_ATTEMPTS=8
HUBSPOT_ACCESS_TOKEN=replace-locally
HUBSPOT_API_BASE_URL=https://api.hubapi.com
HUBSPOT_CREATE_NOTES=true
HUBSPOT_NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID=202
```

Apply and initialize:

```bash
npm run db:apply
npm run crm:setup
npm run crm:verify
```

Synchronize existing local contacts for a demo:

```bash
npm run crm:backfill
npm run crm:status
```

New turns are enqueued automatically. The Brain process drains the queue in the background. An operator can force a retry with `npm run crm:drain`.

## Deduplication contract

`brain_customer_key` is a HubSpot custom property with `hasUniqueValue=true`. Its value is derived from the local tenant key and immutable local contact UUID. This prevents duplicates across repeated messages, channels, process restarts, and backfills without incorrectly merging people who share a name.

Cross-channel identity linking remains an explicit Brain operation. Once identities point to the same local contact, all channels project to the same CRM record.

## Replacing HubSpot

Implement another adapter behind the same projection boundary and select it with `CRM_PROVIDER`. Keep the outbox schema and customer key contract unchanged. Do not add CRM-specific logic to n8n workflows, channel adapters, prompts, or semantic decision code.

## Presentation checklist

1. Run `npm run crm:verify` and confirm `ok: true`.
2. Send a channel message or use the internal channel-free harness.
3. Run `npm run crm:drain` if an immediate refresh is needed.
4. Open the contact URL returned by `npm run crm:status`.
5. Show the **AI Conversation** property group and the associated checkpoint note.
6. Demonstrate that a repeated event updates the same contact instead of creating a duplicate.

