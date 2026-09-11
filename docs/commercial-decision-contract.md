# Commercial decision integrity

Owner: Brain maintainers. Classification: public architecture guidance.
Source of truth: decision schema, action executor, and canonical PostgreSQL records.
Lifecycle: maintained with the commercial contract; retire when its successor documents the same guarantees.

## One semantic decision, real actions

The model owns discovery, interpretation, language, and conversational progression. The server owns authorization, evidence validation, exact prices, calculations, tenant isolation, idempotency, and persistence. Do not implement conversational stages with keyword rules.

An absent catalog match prohibits quoting an unrelated offer or executing its checkout. It does not prohibit a supported internal custom-proposal request. Such a request requires grounded scope and customer commitment, but not a fabricated catalog price or payment authorization. External mutations and payment steps retain their own stricter authorization requirements.

When no action is selected, return the complete decision-schema action object with `action_id: null`, not a null action object. A persisted active request is an existing fact, not permission to create another request or announce a new one. Never claim completion from a model's proposed action alone.

## Focused verification

Run `node scripts/test-custom-proposal-prompt-contract.mjs` for prompt/schema regressions. Then run the consultative scenarios using internal test identities with channel and CRM side effects excluded. This static check does not prove runtime persistence or conversational quality.

Bound the test process itself as well as individual provider calls. For example, `timeout --signal=TERM --kill-after=5s 15m npm run brain:test:consultative` prevents an unattended run from waiting indefinitely. Exit 124 or 137 is a failed/incomplete run, not a quality pass. Increase the explicit budget when a legitimate larger suite requires it; never treat truncated scenarios as completed.

## Why targeted changes come first

Contradictory instructions can suppress an otherwise valid tool action. GPT-4.1 follows instructions literally, and later conflicting instructions can dominate earlier guidance. Resolve contradictions before adding more prompts, changing providers, or purchasing another broad test run. See the [official GPT-4.1 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-4.1).

Combine compatible structured work into one live decision rather than successive prose-review calls. Keep subjective evaluation offline and measure model calls, retries, fallbacks, and end-to-end latency separately. See the [OpenAI latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization).

Test-process lifecycle is separate from model latency: close owned database pools and bound subprocess shutdown. A long-running shell alone does not establish which component is blocked. See [node-postgres pool lifecycle](https://node-postgres.com/apis/pool) and [Node.js subprocess behavior](https://nodejs.org/api/child_process.html).
