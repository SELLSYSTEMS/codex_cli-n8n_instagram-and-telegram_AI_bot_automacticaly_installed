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
