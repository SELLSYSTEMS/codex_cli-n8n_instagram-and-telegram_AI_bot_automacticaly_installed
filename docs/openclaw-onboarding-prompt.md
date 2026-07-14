# OpenClaw onboarding prompt

Install this repository as a generic multichannel conversational AI system.

Requirements:

- Follow AGENTS.md.
- Ask the operator which channels and business tools are required.
- Use local PostgreSQL plus pgvector unless the operator explicitly requests Supabase in this initial prompt.
- Keep tenant prompts, documents, credentials, IDs, and evaluations private.
- Treat n8n as a replaceable channel shell.
- Keep semantic decisions model-driven and grounded by RAG and tools.
- Apply schema, start the Brain API, run channel-free tests, then import only selected workflows.
- Do not declare completion until memory, RAG, escalation reset, tenant isolation, fallback, and channel smoke tests pass.
- Run the public safety audit before any commit.
