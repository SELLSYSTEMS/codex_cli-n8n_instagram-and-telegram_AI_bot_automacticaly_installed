# Instagram setup for the first production path

This project starts with Instagram only. Telegram and other channels are roadmap items.

## Required Meta assets

- A Meta Business app in Live mode.
- A Facebook Page connected to the Instagram professional account.
- An Instagram professional account with messaging enabled.
- A Page access token that includes `instagram_manage_messages` and the Page/Instagram asset.
- Instagram webhooks subscribed to message events for the connected account.

## Runtime flow

1. Instagram user sends a DM.
2. Meta sends a webhook event to the n8n production webhook.
3. n8n normalizes the payload and rejects outbound echo events.
4. n8n checks Supabase `thread_states`.
5. If the thread is active, n8n retrieves tenant settings, thread context, and RAG chunks.
6. n8n generates a grounded answer or one-time escalation reply.
7. n8n sends the response through the Instagram Messaging API.
8. Supabase stores audit events in `conversation_events`.

## What not to use for the Instagram DM path

- Do not use AWS/S3 vector wrappers.
- Do not use a local vector store.
- Do not store real secrets in the public repo.
- Do not rely on Facebook Messenger-only setup screens unless the field is explicitly required for Instagram messaging.

## Production webhook behavior

Use the n8n production webhook after the workflow is active. Production webhook calls do not show live test data on the canvas; inspect them in the n8n Executions tab.

## Minimum live test

1. Confirm the workflow `Demo: RAG in n8n` is active.
2. Confirm `.env` on the n8n host has the current Instagram Page access token and `IG_ENABLE_LIVE_SEND=true`.
3. Send one DM to the connected Instagram account from a different Instagram account.
4. Confirm n8n execution succeeds.
5. Confirm Supabase has a `conversation_events` row for the thread.
6. Confirm the bot sent exactly one reply and did not answer its own outbound echo.
