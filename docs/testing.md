# Testing strategy

## Channel-free tests first

Call the Brain API directly. This isolates reasoning, memory, RAG, tools, and model routing from Meta, Telegram, WhatsApp, and n8n delivery issues.

Required suites:

- first-contact discovery;
- long multi-turn continuity;
- correction of earlier facts;
- multilingual and mixed-language dialogue;
- vague and incomplete requests;
- price and currency questions;
- technical support;
- objections and hesitation;
- purchase intent and next-step conversion;
- irrelevant or adversarial input;
- prompt injection against private data;
- unsupported claims and uncertainty;
- escalation once, silence afterward, authorized reset;
- duplicate event idempotency;
- same customer across linked channels;
- strict tenant isolation;
- primary model quota fallback;
- all providers unavailable.

Use synthetic companies in public tests. Private company evaluations stay outside this repository.

## Channel smoke tests second

For each selected channel, verify webhook receipt, normalization, Brain API call, outbound delivery, idempotency, retries, and logs. Do not use channel tests to diagnose brain quality.

## Decision-ready commercial regression

The suite must include a conversation in which a buyer progressively confirms the use case, channel, automation scope, and human handoff behavior. The final turn is already decision-ready.

Passing behavior:

- Synthesizes the agreed solution without repeating the whole interview.
- Connects the solution to a useful business outcome.
- Proposes one concrete, proportionate next action that advances the transaction.
- Requests a commitment or the minimum missing input needed for that action.
- Remains factual and does not invent a price or delivery promise.

Critical failure:

- Only says the requirement was understood, accepted, saved, or recorded.
- Asks another low-value implementation question after enough information exists to progress.
- Ends without a commercial next step despite explicit buying intent.

This is evaluated semantically by the model judge. Do not add keyword, language, or fixed-response conditions to production behavior.
## Run one conversation scenario

Use the exact scenario id to iterate on one behavior without consuming model quota on the full suite:

```bash
node scripts/brain-scenarios.mjs --case decision-ready-support-bot-close
```

The harness still exercises the live Brain API and configured model router. The filter changes only which fixture is executed; it does not add response templates or semantic branching to production behavior.
