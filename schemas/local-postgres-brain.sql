begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

create schema if not exists agent;

create table if not exists agent.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  display_name text,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent.contact_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  contact_id uuid not null references agent.contacts(id) on delete cascade,
  channel text not null,
  external_user_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, external_user_id)
);

create index if not exists contact_identities_contact_idx
  on agent.contact_identities (tenant_id, contact_id);

create table if not exists agent.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  contact_id uuid not null references agent.contacts(id) on delete cascade,
  channel text not null,
  external_thread_id text not null,
  status text not null default 'active'
    check (status in ('active', 'escalated', 'closed')),
  bot_paused boolean not null default false,
  escalation_reason text,
  escalated_at timestamptz,
  escalation_acknowledged_at timestamptz,
  context_summary text not null default '',
  state jsonb not null default '{}'::jsonb,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel, external_thread_id)
);

create index if not exists conversations_contact_recency_idx
  on agent.conversations (tenant_id, contact_id, last_message_at desc);

create table if not exists agent.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  conversation_id uuid not null references agent.conversations(id) on delete cascade,
  channel text not null,
  external_event_id text,
  role text not null check (role in ('user', 'assistant', 'human', 'system', 'tool')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists messages_external_event_unique_idx
  on agent.messages (tenant_id, channel, external_event_id)
  where external_event_id is not null;

create index if not exists messages_conversation_recency_idx
  on agent.messages (conversation_id, created_at desc);

create table if not exists agent.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  source_key text not null,
  title text not null,
  source_uri text,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_key)
);

create table if not exists agent.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  document_id uuid not null references agent.knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists knowledge_chunks_tenant_idx
  on agent.knowledge_chunks (tenant_id, document_id);
create index if not exists knowledge_chunks_search_idx
  on agent.knowledge_chunks using gin (search_vector);
create index if not exists knowledge_chunks_embedding_idx
  on agent.knowledge_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create table if not exists agent.model_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  conversation_id uuid not null references agent.conversations(id) on delete cascade,
  provider text not null,
  model text not null,
  action text not null,
  confidence double precision,
  latency_ms integer,
  route_attempts jsonb not null default '[]'::jsonb,
  usage jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists model_runs_conversation_idx
  on agent.model_runs (conversation_id, created_at desc);

create table if not exists agent.delivery_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  conversation_id uuid not null references agent.conversations(id) on delete cascade,
  channel text not null,
  status text not null,
  external_delivery_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into agent.tenants (slug, name)
values ('default', 'Default tenant')
on conflict (slug) do nothing;

commit;
