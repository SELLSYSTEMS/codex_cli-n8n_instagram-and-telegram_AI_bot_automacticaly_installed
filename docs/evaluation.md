# Conversation evaluation

The evaluation layer measures behavior without moving conversational decisions out of the Brain or adding keyword trees to channel workflows.

## Evaluation layers

1. Deterministic runtime scores validate contracts such as model routing, memory state, action shape, and escalation state.
2. The DeepSeek LLM judge evaluates subjective quality on the completed `brain.agent` observation.
3. Offline scenario tests exercise complete multi-turn customer journeys.
4. Calibration cases compare judge output with explicit human labels before rubric or model changes are accepted.
5. Human review remains the authority for ambiguous or high-impact failures.

The judge never changes the response already sent to a user. It is an asynchronous observer.

## Rubric

`conversation-quality-v1` scores:

- relevance
- groundedness
- helpfulness
- continuity
- commercial judgment
- action correctness
- escalation appropriateness
- language continuity

Each applicable dimension is a numeric score from 0 to 1. `judge_overall_quality` provides the quality roll-up, and `judge_pass` is stored as numeric `1` or `0` for compatibility with self-hosted Langfuse score APIs. Reasons, evidence, rubric version, judge model, latency, usage, and critical failures are stored with Langfuse scores.

The rubric is evidence-based and intentionally avoids fixed language or sales rules. It penalizes context loss, fabricated facts or actions, premature payment requests, unexplained language changes, and unjustified escalation.

## Online evaluation

Start the asynchronous worker:

```bash
bash scripts/langfuse-judge-worker.sh start
```

Inspect it:

```bash
bash scripts/langfuse-judge-worker.sh status
bash scripts/langfuse-judge-worker.sh log 50
```

The default production sample rate is 10 percent and selection is deterministic by trace ID. Override it locally:

```bash
LANGFUSE_LLM_JUDGE_SAMPLE_RATE=0.25 bash scripts/langfuse-judge-worker.sh restart
```

The worker evaluates the root `brain.agent` observation and aggregates relevant memory, RAG, tool, action, and model observations as evidence. Scores are idempotent for the same trace, observation, score name, and rubric version.

## Offline and targeted evaluation

Evaluate the newest traces exhaustively:

```bash
node scripts/langfuse-evaluate.mjs --limit 10 --force
```

Evaluate one trace:

```bash
node scripts/langfuse-evaluate.mjs --trace-id TRACE_ID --force
```

`--force` bypasses production sampling and is appropriate for test runs. Offline test suites should evaluate every scenario, not a sample.

## Calibration

Run the generic calibration set:

```bash
node scripts/langfuse-calibrate.mjs
```

The gate requires:

- mean absolute error no greater than 0.20
- pass/fail agreement of at least 0.80

Add reviewed cases to `tests/evaluation/judge-calibration.json` when a new real failure class is found. Do not add production customer content or company-specific data to the public template.

Recalibrate whenever the rubric, judge prompt, judge model, pass threshold, or score interpretation changes. A judge that fails calibration must not be used as a release gate.

## Langfuse demonstration

For a customer demonstration:

1. Open a `brain.message` trace and show its nested agent, memory, RAG, model, and action observations.
2. Open the `brain.agent` observation and show the judge scores with evidence and reasons.
3. Filter low `judge_overall_quality` values to identify weak conversations.
4. Compare test runs on the acceptance dataset before and after a Brain change.
5. Show token usage, latency, model routing, and cost alongside quality.
6. Explain that deterministic checks detect broken contracts while the calibrated LLM judge measures semantic quality.

Do not present an LLM judge score as objective truth. Use it for triage, regression detection, release gates after calibration, and targeted human review.

## Local configuration

Supported local environment variables:

```dotenv
LANGFUSE_LLM_JUDGE_MODEL=deepseek-reasoner
LANGFUSE_LLM_JUDGE_SAMPLE_RATE=0.10
LANGFUSE_LLM_JUDGE_MIN_SCORE=0.75
LANGFUSE_LLM_JUDGE_BATCH_SIZE=25
LANGFUSE_LLM_JUDGE_POLL_MS=15000
```

DeepSeek and Langfuse credentials remain in the ignored local `.env` file. Never put keys, private traces, production domains, or tenant-specific evaluation cases in the public repository.
