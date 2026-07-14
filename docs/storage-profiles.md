# Storage profiles

## Default: local PostgreSQL

Use schemas/local-postgres-brain.sql with pgvector. This profile offers explicit ownership, local control, low coupling, and a clean migration path away from n8n.

Required properties:

- separate runtime role;
- tenant_id on every tenant-owned row;
- indexed thread history;
- idempotent external message IDs;
- durable escalation state;
- vector index;
- backups and retention policy.

## Optional: Supabase

Select Supabase only when explicitly requested in the initial operator prompt. Use the same logical tables and RPC contracts, apply Row Level Security, and keep service credentials outside workflow exports.

Supabase is not an automatic fallback and is not the default merely because a project or key exists.
