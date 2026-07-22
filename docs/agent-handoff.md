# AI Agent Handoff

This file is the compact continuity contract for any AI developer continuing the project.

## Architecture invariants

- Channel adapters are thin transports. Instagram, Telegram, WhatsApp, and internal tests must call the same shared brain.
- The shared brain owns reasoning, conversation continuity, retrieval, tool use, escalation state, and commercial progression.
- Local PostgreSQL with pgvector is the default durable store. Supabase is an optional deployment choice only when explicitly requested.
- Customer-facing behavior is LLM-driven. Do not implement semantic behavior with language checks, keyword trees, canned reply branches, or channel-specific sales logic.
- Public artifacts must contain placeholders and generic examples only. Company knowledge, credentials, customer data, prompts, and runtime reports stay private.

## Required response behavior

- Infer the customer's language, intent, readiness, objections, and next useful action from the full conversation.
- Ask only for information that materially changes the recommendation, scope, price, timing, or risk.
- Treat discovery as a means to progress, not an endless questionnaire.
- Once the customer has confirmed the problem and proposed direction, move to a concrete commercial commitment.
- A reply that only acknowledges, records, or paraphrases the last detail is a critical failure at a decision-ready stage.
- Never invent prices, capabilities, delivery dates, or policies. Use retrieved facts; otherwise offer the smallest next step needed to prepare an accurate proposal.
- Escalate only when the model cannot safely or effectively continue. Once escalated, remain silent until an operator resets the marker.

## Model evidence

- `model_route` is an alias, not sufficient proof of the exact model by itself.
- Resolve the alias against the active model-route configuration and health state at the time of execution.
- Store route, provider, exact model, reasoning effort, fallback attempts, and timestamps with every brain execution when changing observability code.
- Never claim an exact historical model when those fields were not persisted; state the configured resolution and the evidence limitation.

## Regression gate

Before declaring the bot ready:

1. Run channel-free brain scenarios against isolated test conversation IDs.
2. Include multilingual, terse, skeptical, technical, pricing, security, support, high-intent, and decision-ready paths.
3. Confirm memory continuity across every turn.
4. Confirm retrieval facts are grounded and no unsupported claims are introduced.
5. Confirm a decision-ready customer receives a concrete next action rather than an acknowledgement.
6. Confirm escalation silence and operator reset behavior.
7. Run one smoke test per real channel only after the shared-brain suite passes.

## Diagnostic order

When a channel reply is poor, inspect in this order:

1. Separate inbound messages from delivery/status callbacks.
2. Reconstruct the complete conversation in chronological order.
3. Check the shared brain response and stored memory before blaming the channel adapter.
4. Resolve the model route using runtime configuration and health evidence.
5. Add a generic regression scenario that captures the behavioral failure.
6. Fix the shared prompt, tools, memory, or retrieval layer once; do not patch individual channels.
