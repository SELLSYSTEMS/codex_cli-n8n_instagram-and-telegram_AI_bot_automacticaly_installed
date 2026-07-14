# Channel adapters

Every adapter performs only transport responsibilities:

- authenticate and verify the webhook;
- reject malformed or unsupported events;
- ignore delivery receipts and message echoes;
- normalize channel identifiers and text;
- preserve the provider message ID for idempotency;
- call POST /v1/messages;
- dispatch reply, silent, or escalation action;
- send through the channel API;
- record delivery outcome and retry safely.

Semantic conversation policy belongs in the brain. Adding a channel must not require duplicating prompts or memory logic.
