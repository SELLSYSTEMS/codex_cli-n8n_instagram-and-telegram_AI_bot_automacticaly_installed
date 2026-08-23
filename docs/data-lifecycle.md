# Data lifecycle and ownership

## Canonical runtime database

The default runtime is the local PostgreSQL database referenced only by `LOCAL_POSTGRES_URL`. Active Brain data lives in the `agent` schema. The `public.bot_*` objects are frozen compatibility artifacts and must not receive new features, migrations, or runtime writes.

Supabase is an optional installation target only when the human operator explicitly selects it in the initial installation prompt. It is not a fallback for the default local runtime.

## Environment contract

- `LOCAL_POSTGRES_URL` is the only accepted runtime database variable.
- Real credentials remain in the ignored local `.env` or a secrets manager.
- Public examples contain placeholders only.
- Runtime checks must fail closed when the canonical variable, required executable, schema, or extension is missing.

## Production and test isolation

Internal and regression conversations use `scenario_test` or `internal_test` channels and explicit test metadata. They may exercise Brain memory and tools, but they must never create CRM projections, delivery jobs, real customer records, or external actions.

Reserved identities such as `.example.test` are test-only and are excluded from CRM backfill.

## CRM projection lifecycle

The canonical outbox is `agent.crm_sync_outbox`.

- `pending`: ready for a worker.
- `processing`: leased by one worker.
- `retry`: transient failure waiting for another attempt.
- `completed`: projected successfully.
- `dead`: genuine production failure that exhausted retries and needs review.
- `cancelled`: intentionally quarantined test, legacy, invalid, or operator-cancelled work.

Idempotency is tenant-scoped. Provider contact links and outbox dedupe keys must never collide across tenants.

## Commercial progression lifecycle

Decision-ready custom work is represented by `agent.commercial_requests`, not by a conversational promise and not by the escalation marker. The Brain may create or refresh a request only through the validated `request_custom_proposal` commercial action. The table is tenant-scoped and idempotent on `(tenant_id, conversation_id, action_id)`.

Request states are `requested`, `preparing`, `ready`, `delivered`, and `cancelled`. External proposal, invoice, or payment systems may project from this record, but the Brain must not claim those artifacts exist until their own action confirms creation. Internal test conversations set `test_only=true`; downstream workers must not dispatch those records externally.

The Brain loads active requests (`requested`, `preparing`, or `ready`) on every turn and exposes them as durable state. A matching active request cannot be recreated or announced as new; the conversation must continue from its actual lifecycle state with a scope-specific next move. Uniqueness applies only to active requests, so a genuinely new request may be created after an earlier request becomes `delivered` or `cancelled`.

Operators transition requests through the tenant-scoped `agent.transition_commercial_request` function, exposed locally by `npm run commercial:requests`. Transitions are forward-only, terminal requests cannot be reopened, and `operator_note` plus `resolved_at` preserve the operational audit trail. The default list view shows active requests and intentionally omits customer payloads and private context.

## Migration discipline

- Bootstrap definitions live in `schemas/local-postgres-brain.sql`.
- Incremental changes live in ordered files under `schemas/migrations`.
- A migration is append-only after deployment.
- Bootstrap and migrations must converge to the same constraints.
- Apply schema changes through `scripts/apply-local-postgres-schema.sh`, never by ad hoc production edits.

## Operational gate

Before declaring an installation ready:

1. Run `./scripts/check-runtime-prereqs.sh`.
2. Apply the local schema and ordered migrations.
3. Run organization, source-of-truth, structural-hygiene, project-order, and public-template audits.
4. Confirm Brain health and the configured model route.
5. Run channel-free regression scenarios and verify test rows did not enter CRM or delivery queues.
6. Run only the selected channel smoke tests.
7. Review `dead` outbox rows; intentionally excluded work belongs in `cancelled`, not `dead`.
