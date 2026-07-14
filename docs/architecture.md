# Architecture

## Durable core

The durable system is the Brain API plus PostgreSQL contracts. It owns:

- tenant isolation;
- cross-channel identity links;
- conversation history and summaries;
- lead and workflow state;
- RAG retrieval;
- approved business tools;
- escalation state and reset;
- model selection and fallback;
- structured reply actions;
- observability and tests.

## Replaceable shell

n8n receives channel events, normalizes transport fields, calls the Brain API, and performs the returned delivery action. It must not decide customer intent, language, sales strategy, objections, or escalation through keyword branches.

A different orchestrator can replace n8n by implementing the same adapter contract.

## Storage selection

Local PostgreSQL plus pgvector is mandatory by default. Supabase is an alternative deployment profile only when the initial operator prompt explicitly selects it. An installer must never infer Supabase from old repository history or available credentials.

## Model policy

Routes are ordered by numeric priority. Disabled routes are never called. Quota or retryable provider failures may advance to the next enabled route. Authentication, invalid requests, and policy failures are recorded rather than silently hidden.

## Data boundary

Public code contains contracts and synthetic examples only. Tenant prompts, knowledge, credentials, production IDs, user data, evaluations, and runtime route overrides stay private.
