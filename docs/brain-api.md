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
