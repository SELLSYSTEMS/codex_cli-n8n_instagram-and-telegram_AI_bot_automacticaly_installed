# Internal bot testing without Instagram or Telegram

This project has two testing layers:

1. **Channel tests**: real Instagram or Telegram messages. Use these only to prove webhook subscriptions, channel permissions, and outbound delivery.
2. **Bot-brain tests**: direct RAG, memory, escalation, and response-generation checks without any external channel. Use these for fast daily iteration.

The bot-brain test path must not send messages to Instagram, Telegram, Messenger, or WhatsApp.

## Recommended local test command

Use the local harness:

```bash
node scripts/internal-bot-test.mjs \
  --thread local-sales-test-001 \
  --message "What can Sell.Systems build for Instagram DM automation?"
```

The script reads `.env`, calls OpenAI for embeddings and chat generation, retrieves company memory from Supabase vectors, writes test conversation events with `channel = internal_test`, and prints a JSON result.

It does not call Instagram or Telegram APIs.

## Test escalation silence

Trigger escalation:

```bash
node scripts/internal-bot-test.mjs \
  --thread local-sales-test-001 \
  --message "I want a human operator to review this"
```

Send another message in the same thread:

```bash
node scripts/internal-bot-test.mjs \
  --thread local-sales-test-001 \
  --message "Are you still there?"
```

Expected result: `status = silent_already_escalated` and `response = null`.

Reset the thread:

```bash
node scripts/internal-bot-test.mjs --reset --thread local-sales-test-001
```

After reset, the bot can answer again.

## Why this is better than using Instagram for every test

Instagram testing is slow and mixes channel bugs with bot-logic bugs. The internal harness isolates these layers:

- Supabase schema and RPCs
- vector retrieval
- private company memory
- response generation
- escalation marker logic
- conversation logging

Use real Instagram only after the internal harness passes.

## Data separation

Internal tests use:

- `conversation_events.channel = internal_test`
- `thread_states.channel = internal_test`

The production Instagram flow uses:

- `conversation_events.channel = instagram`
- `thread_states.channel = instagram`

This prevents internal tests from mutating production Instagram thread state.
