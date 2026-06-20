# Import/export strategy for future AI developers

The public repo should ship reusable artifacts instead of asking every future AI developer to rebuild the system from scratch.

## Portable artifacts

Use these as the stable import/export surface:

- `schemas/supabase.sql`: Supabase tables, vector extension, indexes, and RPCs.
- `workflows/demo-rag-instagram-supabase.json`: production Instagram DM RAG workflow.
- `workflows/knowledge-upload-to-supabase.json`: knowledge upload workflow.
- `workflows/internal-rag-bot-test-harness.json`: optional n8n-only internal testing workflow.
- `scripts/internal-bot-test.mjs`: local autonomous bot-brain test harness.
- `docs/*.md`: setup, operator, architecture, and roadmap instructions.
- `SKILL.md`: AI-agent onboarding instructions.

## Recommended setup sequence

1. Clone the repo.
2. Create a local `.env` with private credentials. Do not commit it.
3. Apply `schemas/supabase.sql` to Supabase.
4. Import the n8n workflow JSON files.
5. Configure n8n environment variables or credentials.
6. Ingest company memory through `Knowledge Upload to Supabase`.
7. Run `scripts/internal-bot-test.mjs` before connecting live channels.
8. Connect Instagram webhooks and run one live DM test.

## Why workflow JSON is better than rebuilding from scratch

n8n workflows contain operational decisions that are easy to lose in prose:

- node order
- routing gates
- webhook paths
- field mappings
- Supabase RPC payloads
- OpenAI request payloads
- logging behavior
- escalation-state behavior
- sticky notes and operator instructions

A future AI developer should import the workflow JSON first, then modify only tenant-specific values.

## What should stay private

Do not commit:

- `.env`
- API keys
- access tokens
- company-private memory packs
- customer conversations
- private operator notes

Company memory belongs in Supabase or a private archive, not in the public repo.
