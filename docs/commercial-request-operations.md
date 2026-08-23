# Commercial request operations

## Canonical ownership

`agent.commercial_requests` is the only durable lifecycle for seller-owned proposal, checkout, invoice, payment, or delivery preparation. Conversation text, CRM notes, n8n execution data, and escalation state are projections or adjacent concerns; none of them replaces this table.

The Brain creates requests only through the validated `request_custom_proposal` action. Human operators update lifecycle state through the local CLI, which calls the tenant-scoped database function. Channel workflows must not write this table directly.

## States

| State | Meaning | Terminal |
| --- | --- | --- |
| `requested` | The Brain recorded a qualified seller-owned action. | No |
| `preparing` | An operator or worker is preparing the artifact. | No |
| `ready` | The artifact exists and is ready for controlled delivery. | No |
| `delivered` | Delivery was confirmed by the responsible action. | Yes |
| `cancelled` | Work was intentionally stopped. | Yes |

Transitions may remain at the same state or move forward. They cannot move backward, and terminal requests cannot be reopened. Create a new request for genuinely new work.

## Operator commands

The CLI accepts only the canonical `LOCAL_POSTGRES_URL` from the ignored local `.env` file.

```bash
npm run commercial:requests -- list --tenant-key TENANT_KEY
npm run commercial:requests -- list --tenant-key TENANT_KEY --all
npm run commercial:requests -- list --tenant-key TENANT_KEY --conversation-id CONVERSATION_UUID
npm run commercial:requests -- transition --tenant-key TENANT_KEY --request-id REQUEST_UUID --status preparing --note "Owner accepted"
npm run commercial:requests -- transition --tenant-key TENANT_KEY --request-id REQUEST_UUID --status ready --note "Checkout prepared"
npm run commercial:requests -- transition --tenant-key TENANT_KEY --request-id REQUEST_UUID --status delivered --note "Delivery confirmed"
```

CLI output excludes `customer_commitment` and `context` by design. Inspect private payloads only through an authorized operational surface with an explicit business need.

## Runtime invariant

An active request is loaded into durable Brain state on every turn. The model must not recreate it, repeat the same confirmation, or claim an artifact that the lifecycle has not confirmed. It should answer the newest customer question and continue from the actual state.

`test_only=true` requests must never trigger external delivery workers.
