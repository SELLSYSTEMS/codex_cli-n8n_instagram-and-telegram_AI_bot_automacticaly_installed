# Brain API contract

## POST /v1/messages

Normalized request fields:

- tenant_key
- channel
- channel_account_id
- external_user_id
- external_thread_id
- external_message_id
- text
- raw_event, optional and subject to retention policy

The endpoint is idempotent on tenant, channel, and external_message_id.

Response follows schemas/brain-response.schema.json. The adapter sends text only when action is reply and should_reply is true. Action silent means acknowledge the webhook without outbound delivery. Action escalate stores a durable marker and returns one escalation notice at most once.

## POST /v1/escalations/reset

Requires administrator authentication. Input identifies tenant and thread. Reset clears the durable escalation marker and permits the bot to resume on the next inbound message.

## GET /health

Reports process health, database connectivity, schema compatibility, and route availability without exposing secrets.

## Administration

Any route-management or reset endpoint must use a separate administrator token, bind to a private interface or trusted network, and log the actor and change.

## Commercial-next-step decision contract

The Brain decision includes a required `commercial_next_step` object. It is a structured LLM planner that records the semantically selected progression without hard-coding dialogue logic into channel adapters or n8n.

The planner may recommend discovery, a solution, a commitment, payment, human handoff, or no commercial action. Payment fields remain nullable and may only be populated from tenant-private policy plus grounded price data. The reply must express the selected step naturally; external side effects still require a separately executed `commercial_action`.

Public installations provide their own private commercial policy and knowledge. The public schema contains no tenant price, domain, payment method, or company-specific wording.
