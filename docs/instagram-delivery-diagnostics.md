# Instagram webhook and delivery diagnostics

This project supports Instagram API with Instagram Login. Message delivery requires two separate subscriptions:

1. An app-level `object=instagram` webhook subscription whose callback is the active n8n production webhook.
2. A user-level `/subscribed_apps` subscription for the Instagram professional account with the `messages` field.

A valid token or a successful webhook verification challenge does not prove that both subscriptions are current.

## Configure and prove delivery

```bash
npm run instagram:webhook:configure
```

The command:

- discovers a valid app ID/secret pair from `.env` without printing it;
- updates the app-level Instagram subscription;
- updates the legacy Page subscription for compatibility;
- subscribes the Instagram professional account to `messages`;
- confirms the n8n workflow is active;
- runs the Meta verification challenge;
- sends a signed self/echo diagnostic event that cannot trigger a customer reply;
- verifies that n8n records a successful execution.

Read-only re-diagnosis, apart from the safe synthetic delivery event:

```bash
npm run instagram:webhook:diagnose
```

## Live message proof

After the diagnostic command passes, send one new DM from an account that is not the business account. Confirm all of the following:

- Meta delivers a POST to `/webhook/instagram-rag-webhook`;
- the n8n execution succeeds;
- the thin adapter calls the Brain API;
- the reply is sent through the Instagram API;
- the Brain API stores the turn under the correct tenant, channel, and external conversation key.

Self messages, echoes, delivery receipts, and unsupported payloads must be acknowledged but must never invoke the Brain or send another message.
