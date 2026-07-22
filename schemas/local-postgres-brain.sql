begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

create schema if not exists agent;

create table if not exists agent.tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_key text not null unique,
  display_name text not null,
  config jsonb not null default '{}'::jsonb,
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

create table if not exists agent.identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  contact_id uuid not null references agent.contacts(id) on delete cascade,
  channel text not null,
  external_user_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel, external_user_id)
);

create table if not exists agent.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  contact_id uuid not null references agent.contacts(id) on delete cascade,
  channel text not null,
  external_thread_id text not null,
  status text not null default 'active',
  summary text not null default '',
  semantic_state jsonb not null default '{}'::jsonb,
  escalated_at timestamptz,
  escalation_reason text,
  last_message_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel, external_thread_id)
);

create table if not exists agent.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  conversation_id uuid not null references agent.conversations(id) on delete cascade,
  contact_id uuid not null references agent.contacts(id) on delete cascade,
  channel text not null,
  external_message_id text,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  role text not null check (role in ('user', 'assistant', 'system', 'operator', 'tool')),
  content text not null default '',
  payload jsonb not null default '{}'::jsonb,
  model_route text,
  created_at timestamptz not null default now()
);

create unique index if not exists messages_external_id_uq
  on agent.messages (tenant_id, channel, external_message_id)
  where external_message_id is not null;

create index if not exists messages_contact_time_idx
  on agent.messages (tenant_id, contact_id, created_at desc);

create index if not exists messages_conversation_time_idx
  on agent.messages (conversation_id, created_at desc);

create table if not exists agent.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  source_key text not null,
  title text not null,
  content_hash text not null,
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
  embedding vector(384) not null,
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists knowledge_chunks_tenant_idx
  on agent.knowledge_chunks (tenant_id);

create index if not exists knowledge_chunks_embedding_hnsw_idx
  on agent.knowledge_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists knowledge_chunks_search_idx
  on agent.knowledge_chunks using gin (search_vector);

create table if not exists agent.model_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  conversation_id uuid references agent.conversations(id) on delete set null,
  inbound_message_id uuid references agent.messages(id) on delete set null,
  route_id text not null,
  model text not null,
  status text not null,
  latency_ms integer,
  error_class text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists model_runs_conversation_time_idx
  on agent.model_runs (conversation_id, created_at desc);

create table if not exists agent.delivery_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references agent.tenants(id) on delete cascade,
  conversation_id uuid references agent.conversations(id) on delete cascade,
  channel text not null,
  external_message_id text,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function agent.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tenants_touch_updated_at on agent.tenants;
create trigger tenants_touch_updated_at
before update on agent.tenants
for each row execute function agent.touch_updated_at();

drop trigger if exists contacts_touch_updated_at on agent.contacts;
create trigger contacts_touch_updated_at
before update on agent.contacts
for each row execute function agent.touch_updated_at();

drop trigger if exists identities_touch_updated_at on agent.identities;
create trigger identities_touch_updated_at
before update on agent.identities
for each row execute function agent.touch_updated_at();

drop trigger if exists conversations_touch_updated_at on agent.conversations;
create trigger conversations_touch_updated_at
before update on agent.conversations
for each row execute function agent.touch_updated_at();

drop trigger if exists knowledge_documents_touch_updated_at on agent.knowledge_documents;
create trigger knowledge_documents_touch_updated_at
before update on agent.knowledge_documents
for each row execute function agent.touch_updated_at();

commit;
