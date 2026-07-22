# Langfuse observability, evaluation, and demo runbook

## Scope

Langfuse is the observability and evaluation layer for the Brain API. n8n remains a replaceable channel shell. Langfuse must never contain channel credentials, raw secrets, or public-template company data.

This installation runs self-hosted Langfuse v3. The JavaScript SDK emits OpenTelemetry-compatible traces, but the server must use the v3 public API for queries and automation. Observations API v2 and Metrics API v2 require Langfuse v4 and must not be called until self-hosted v4 is officially supported and deliberately migrated.

## Production trace contract

One customer turn is one `brain.message` trace. One conversation is one stable Langfuse session. A trace contains:

| Level | Langfuse object | Required content |
| --- | --- | --- |
| Customer turn | trace | normalized input, final Brain result, channel, tenant, contact, thread, session, release, environment |
| Orchestration | agent/span | agent input/output and state transition |
| Memory | span | load/save operation, record counts, timing, no credentials |
| Retrieval | retriever | query, returned document metadata, rank/similarity, empty-result state |
| LLM call | generation | provider, route, model, parameters, prompt/messages, completion, provider request ID, exact usage, exact cost, latency |
| Tool/action | tool | typed arguments, typed result, status, duration, idempotency identifier |
| Evaluation | score | deterministic runtime checks, LLM-judge quality, and optional human annotation |

Generation usage comes from the provider response. DeepSeek cache-hit and cache-miss tokens remain separate metadata and cost inputs; usage buckets must not double-count cached tokens. Explicit provider cost is preferred over inferred model pricing.

## Evaluation layers

### Runtime contract scores

Every completed Brain trace receives deterministic scores:

- `response_contract_valid`
- `reply_policy_consistent`
- `memory_state_returned`
- `model_route_recorded`
- `commercial_action_valid`
- `escalation_policy_consistent`

A duplicate, suppressed, or escalated-silent turn is valid without a model route only when no outbound message is emitted. These checks validate software contracts; they do not replace semantic evaluation.

### Channel-free acceptance judge

The scenario harness evaluates natural dialogue quality without Instagram, Telegram, WhatsApp, or n8n. It covers discovery, ambiguity, objections, trust, pricing, multiple services, technical support, memory continuity, escalation silence, and reset. The judge writes `scenario_quality` scores and the importer links the final turn of each multi-turn case to a Langfuse Dataset Run while preserving all turn trace IDs in run metadata.

### Human review

Create an Annotation Queue in Langfuse for low-score, high-value, escalation, and random-sample traces. Reviewers should score factual grounding, conversational quality, commercial judgment, safety, and correct next action. Corrections become candidate dataset items; they do not directly mutate production prompts.

## Safe acceptance sequence

Run from the repository root. Do not delete old traces until the control trace passes strict verification.

```bash
node scripts/langfuse-bootstrap.mjs
```

Restart the Brain API with the repository service script so the current instrumentation is loaded. Send one unique internal test turn with `metadata.awaitTelemetry=true`, then verify its returned trace ID:

```bash
node scripts/langfuse-verify.mjs --trace-id=TRACE_ID --timeout-ms=90000
```

The verifier fails unless trace input/output, session identity, nested agent/memory/retrieval/generation observations, provider token usage, positive cost, and all runtime scores exist.

Only after that passes, remove obsolete traces:

```bash
node scripts/langfuse-cleanup.mjs --all
```

Run the complete channel-free suite and import the newest report:

```bash
node scripts/brain-scenarios.mjs
node scripts/langfuse-import-scenarios.mjs
node scripts/langfuse-verify.mjs --timeout-ms=90000
```

Keep datasets, dataset items, score configurations, prompts, and model definitions when cleaning traces. They are evaluation infrastructure, not bad telemetry.

## Langfuse UI customer demonstration

Use this sequence for a clear product demonstration:

1. Open `Tracing > Traces`, filter `brain.message`, and select a successful paid-model turn. Show normalized input and the exact Brain output.
2. Expand the observation tree. Show agent orchestration, memory, retrieval, generation, and tool/action boundaries. Explain that channel code does not own business reasoning.
3. Open the generation. Show exact prompt/messages, response, provider/model route, request ID, latency, token usage, cache details, and monetary cost.
4. Open the trace scores. Contrast deterministic runtime contract checks with semantic `scenario_quality` and human scores.
5. Open `Sessions` and show continuity across multiple turns without collapsing a whole conversation into one oversized trace.
6. Open `Datasets` and the latest `brain-acceptance-*` run. Compare scenarios, quality, failures, and linked production-shaped traces.
7. Open the Annotation Queue. Demonstrate how an operator reviews weak or commercially important turns and records a correction.
8. Open dashboards and compare model, channel, tenant, release, latency, cost, errors, evaluation scores, retrieval quality, escalation, and no-reply behavior.

## Recommended dashboards and filters

Create dashboards for:

- Turn volume and success/error rate by channel, tenant, release, and model route.
- End-to-end and generation latency with p50, p95, and p99.
- Input/output/cache tokens and cost by provider/model, tenant, channel, and day.
- Runtime score pass rate and semantic quality distribution.
- Retrieval result count, empty retrieval rate, and quality score correlation.
- Escalation rate, suppressed-turn rate, reset recovery, and duplicate suppression.
- High-value conversations with poor score, high cost, or repeated tool failure.

Use stable metadata keys and low-cardinality dimensions for dashboards. Keep message text, customer IDs, and document bodies out of metric dimensions.

## Optimization loop

Langfuse supports the evidence loop, not model training itself:

1. Observe production-shaped traces.
2. Detect regressions through scores and dashboards.
3. Review representative failures in an Annotation Queue.
4. Convert approved examples and corrections into versioned dataset items.
5. Change a prompt, retrieval policy, tool contract, or model route in a controlled version.
6. Run the same dataset as an experiment and compare quality, latency, and cost.
7. Promote only when gates pass; retain release/version metadata for rollback.

Fine-tuning or model training happens in the selected model platform. Langfuse supplies curated examples, labels, traces, experiment results, and regression evidence for that process.

## Privacy and public-template rules

- Store Langfuse credentials only in the ignored local `.env` or a secrets manager.
- Redact authorization headers, tokens, cookies, passwords, and private keys before export.
- Apply retention and access controls appropriate to customer data.
- Use stable pseudonymous user/contact identifiers where possible.
- Never export production traces, company prompts, documents, tenant IDs, private domains, or customer conversations to the public template repository.
- Disable content capture for sensitive tenants when required; retain operational metadata and scores where policy permits.

## Failure diagnosis

- Missing input/output: verify the root `brain.message` trace and generation attributes are emitted before flush.
- Flat or missing observations: verify parent context propagation and correct Langfuse observation types.
- Zero tokens/cost: inspect the raw provider usage object and explicit cost mapping; do not infer DeepSeek cache pricing from one flat input rate.
- Missing scores: use `metadata.awaitTelemetry=true` for tests and wait for score publication before process exit.
- Missing Dataset Run: confirm scenario metadata contains a stable scenario ID and import the newest `.runtime/test-results` report.
- Empty v2 metrics/observations calls: expected on self-hosted v3; use v3 UI/public APIs until an official self-hosted v4 migration exists.
