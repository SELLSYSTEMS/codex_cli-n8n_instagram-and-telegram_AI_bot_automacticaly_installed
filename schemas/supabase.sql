-- Enable vector extension
create extension if not exists vector;
create extension if not exists pgcrypto;

-- Match function kept for compatibility with older flows/templates.

-- Documents/knowledge chunks
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  source_type text not null default 'document',
  source_key text not null,
  chunk_index integer not null default 0,
  chunk_text text not null,
  embedding vector(1536) not null,
  metadata jsonb not null default '{}'::jsonb,
  language text,
  created_at timestamptz not null default now()
);

create index if not exists documents_tenant_idx on public.documents (tenant_id);
create index if not exists documents_embedding_cosine_idx
  on public.documents
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Conversation and debug events
create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  channel text not null default 'instagram',
  instagram_thread_id text,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  intent text,
  confidence numeric,
  matched_document_ids jsonb,
  model_name text,
  latency_ms integer,
  escalated boolean not null default false,
  raw_event jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversation_events_tenant_created_at_idx
  on public.conversation_events (tenant_id, created_at desc);
create index if not exists conversation_events_tenant_thread_created_at_idx
  on public.conversation_events (tenant_id, instagram_thread_id, created_at desc);

-- Optional tenant config
create table if not exists public.tenant_settings (
  tenant_id text primary key,
  brand_name text not null,
  language text default 'en',
  response_style text,
  escalation_target text,
  confidence_threshold numeric not null default 0.40,
  updated_at timestamptz not null default now()
);

comment on table public.documents is 'Chunked knowledge base indexed with pgvector';
comment on table public.conversation_events is 'Message-level trace logs for RAG + fallback decisions';

-- Matching helper (pgvector cosine)
drop function if exists public.match_documents(vector, integer, double precision);

create or replace function public.match_documents(
  query_embedding vector(1536),
  match_count int default 5,
  min_similarity float default 0.35,
  p_tenant_id text default null
)
returns table(
  id uuid,
  tenant_id text,
  source_type text,
  source_key text,
  chunk_text text,
  metadata jsonb,
  similarity float
) language sql stable as $$
  select
    d.id,
    d.tenant_id,
    d.source_type,
    d.source_key,
    d.chunk_text,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where 1 - (d.embedding <=> query_embedding) >= min_similarity
    and (p_tenant_id is null or d.tenant_id = p_tenant_id)
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_documents_with_context(
  query_embedding vector(1536),
  p_tenant_id text,
  p_message_id text default null,
  p_thread_id text default null,
  p_channel text default 'instagram',
  p_message_text text default null,
  match_count int default 5,
  min_similarity float default 0.35
)
returns table(
  id uuid,
  tenant_id text,
  source_type text,
  source_key text,
  chunk_text text,
  metadata jsonb,
  similarity float,
  request_tenant_id text,
  request_message_id text,
  request_thread_id text,
  request_channel text,
  request_message_text text
) language sql stable as $$
with ranked as (
  select
    d.id,
    d.tenant_id,
    d.source_type,
    d.source_key,
    d.chunk_text,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where 1 - (d.embedding <=> query_embedding) >= min_similarity
    and (p_tenant_id is null or d.tenant_id = p_tenant_id)
  order by d.embedding <=> query_embedding
  limit match_count
),
  fallback as (
    select
      null::uuid as id,
      null::text as tenant_id,
      null::text as source_type,
      null::text as source_key,
      null::text as chunk_text,
      null::jsonb as metadata,
      0::float as similarity
    where not exists (select 1 from ranked)
  )
select
  r.id,
  r.tenant_id,
  r.source_type,
  r.source_key,
  r.chunk_text,
  r.metadata,
  r.similarity,
  p_tenant_id as request_tenant_id,
  p_message_id as request_message_id,
  p_thread_id as request_thread_id,
  p_channel as request_channel,
  p_message_text as request_message_text
from ranked r
union all
select
  f.id,
  f.tenant_id,
  f.source_type,
  f.source_key,
  f.chunk_text,
  f.metadata,
  f.similarity,
  p_tenant_id as request_tenant_id,
  p_message_id as request_message_id,
  p_thread_id as request_thread_id,
  p_channel as request_channel,
  p_message_text as request_message_text
from fallback f;
$$;

create or replace function public.get_tenant_settings(
  p_tenant_id text
)
returns table(
  tenant_id text,
  brand_name text,
  language text,
  response_style text,
  escalation_target text,
  confidence_threshold numeric
) language sql stable as $$
select
  coalesce(ts.tenant_id, p_tenant_id) as tenant_id,
  coalesce(ts.brand_name, 'Sell.Systems') as brand_name,
  coalesce(ts.language, 'en') as language,
  coalesce(ts.response_style, 'concise, practical, and polite') as response_style,
  coalesce(ts.escalation_target, 'human operator') as escalation_target,
  coalesce(ts.confidence_threshold, 0.40) as confidence_threshold
from public.tenant_settings ts
where ts.tenant_id = p_tenant_id
union all
select
  p_tenant_id,
  'Sell.Systems',
  'en',
  'concise, practical, and polite',
  'human operator',
  0.40::numeric
where not exists (
  select 1 from public.tenant_settings ts where ts.tenant_id = p_tenant_id
)
limit 1;
$$;

drop function if exists public.get_thread_context(text, text, int);

create or replace function public.get_thread_context(
  p_tenant_id text,
  p_thread_id text,
  p_limit int default 8
)
returns table(
  rows jsonb
) language sql stable as $$
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'role', ce.role,
      'intent', ce.intent,
      'content', ce.content,
      'confidence', ce.confidence,
      'escalated', ce.escalated,
      'matched_document_ids', ce.matched_document_ids,
      'model_name', ce.model_name,
      'created_at', ce.created_at,
      'raw_event', ce.raw_event
    )
    order by ce.created_at desc
  ),
  '[]'::jsonb
) as rows
from (
  select
    ce.role,
    ce.intent,
    ce.content,
    ce.confidence,
    ce.escalated,
    ce.matched_document_ids,
    ce.model_name,
    ce.created_at,
    ce.raw_event
  from public.conversation_events ce
  where ce.tenant_id = p_tenant_id
    and ce.instagram_thread_id = p_thread_id
    and ce.created_at is not null
  order by ce.created_at desc
  limit greatest(1, coalesce(p_limit, 8))
) ce;
$$;

-- Performance indexes for ingestion idempotency, tenant-scoped retrieval, metadata filters, and escalation dashboards.
create unique index if not exists documents_tenant_source_chunk_uidx
  on public.documents (tenant_id, source_type, source_key, chunk_index);

create index if not exists documents_tenant_source_created_idx
  on public.documents (tenant_id, source_type, source_key, created_at desc);

create index if not exists documents_metadata_gin_idx
  on public.documents using gin (metadata);

create index if not exists conversation_events_tenant_channel_thread_created_idx
  on public.conversation_events (tenant_id, channel, instagram_thread_id, created_at desc);

create index if not exists conversation_events_escalation_idx
  on public.conversation_events (tenant_id, created_at desc)
  where escalated is true;

comment on table public.documents is 'Tenant-scoped company knowledge chunks with OpenAI text-embedding-3-small vectors stored in native pgvector.';
comment on table public.conversation_events is 'Tenant-scoped Instagram conversation memory, analytics, confidence, and escalation log.';
comment on table public.tenant_settings is 'Per-tenant runtime settings for prompts, model routing, retrieval thresholds, and escalation.';

-- -----------------------------------------------------------------------------
-- Thread state gate
-- -----------------------------------------------------------------------------
-- conversation_events is the immutable audit log.
-- thread_states is the current routing state used by n8n to decide if the bot
-- may answer a thread or must stay silent after escalation until a human reset.

create table if not exists public.thread_states (
  tenant_id text not null,
  channel text not null default 'instagram',
  thread_id text not null,
  status text not null default 'bot_active' check (status in ('bot_active', 'escalated', 'muted')),
  silence_after_escalation boolean not null default true,
  escalation_reason text,
  escalation_count integer not null default 0,
  escalated_at timestamptz,
  reset_at timestamptz,
  reset_by text,
  last_user_message_at timestamptz,
  last_bot_message_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel, thread_id)
);

create index if not exists thread_states_status_idx
  on public.thread_states (tenant_id, channel, status, updated_at desc);

create index if not exists thread_states_escalated_idx
  on public.thread_states (tenant_id, channel, updated_at desc)
  where status = 'escalated';

create or replace function public.get_thread_state(
  p_tenant_id text,
  p_channel text,
  p_thread_id text
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_state public.thread_states%rowtype;
begin
  select *
    into v_state
    from public.thread_states
   where tenant_id = p_tenant_id
     and channel = p_channel
     and thread_id = p_thread_id;

  if not found then
    return jsonb_build_object(
      'tenant_id', p_tenant_id,
      'channel', p_channel,
      'thread_id', p_thread_id,
      'status', 'bot_active',
      'silence_after_escalation', true,
      'is_escalated', false,
      'escalation_count', 0,
      'metadata', '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'tenant_id', v_state.tenant_id,
    'channel', v_state.channel,
    'thread_id', v_state.thread_id,
    'status', v_state.status,
    'silence_after_escalation', v_state.silence_after_escalation,
    'is_escalated', v_state.status = 'escalated' and v_state.silence_after_escalation,
    'escalation_reason', v_state.escalation_reason,
    'escalation_count', v_state.escalation_count,
    'escalated_at', v_state.escalated_at,
    'reset_at', v_state.reset_at,
    'reset_by', v_state.reset_by,
    'metadata', v_state.metadata,
    'updated_at', v_state.updated_at
  );
end;
$$;

create or replace function public.mark_thread_escalated(
  p_tenant_id text,
  p_channel text,
  p_thread_id text,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_state public.thread_states%rowtype;
begin
  insert into public.thread_states (
    tenant_id,
    channel,
    thread_id,
    status,
    silence_after_escalation,
    escalation_reason,
    escalation_count,
    escalated_at,
    last_bot_message_at,
    metadata,
    updated_at
  ) values (
    p_tenant_id,
    p_channel,
    p_thread_id,
    'escalated',
    true,
    p_reason,
    1,
    now(),
    now(),
    coalesce(p_metadata, '{}'::jsonb),
    now()
  )
  on conflict (tenant_id, channel, thread_id) do update set
    status = 'escalated',
    silence_after_escalation = true,
    escalation_reason = coalesce(excluded.escalation_reason, public.thread_states.escalation_reason),
    escalation_count = public.thread_states.escalation_count + 1,
    escalated_at = now(),
    last_bot_message_at = now(),
    metadata = coalesce(public.thread_states.metadata, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb),
    updated_at = now()
  returning * into v_state;

  return jsonb_build_object(
    'tenant_id', v_state.tenant_id,
    'channel', v_state.channel,
    'thread_id', v_state.thread_id,
    'status', v_state.status,
    'silence_after_escalation', v_state.silence_after_escalation,
    'escalation_reason', v_state.escalation_reason,
    'escalation_count', v_state.escalation_count,
    'escalated_at', v_state.escalated_at,
    'updated_at', v_state.updated_at
  );
end;
$$;

create or replace function public.reset_thread_escalation(
  p_tenant_id text,
  p_channel text,
  p_thread_id text,
  p_reset_by text default 'operator',
  p_note text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_state public.thread_states%rowtype;
begin
  insert into public.thread_states (
    tenant_id,
    channel,
    thread_id,
    status,
    silence_after_escalation,
    reset_at,
    reset_by,
    metadata,
    updated_at
  ) values (
    p_tenant_id,
    p_channel,
    p_thread_id,
    'bot_active',
    true,
    now(),
    p_reset_by,
    jsonb_strip_nulls(jsonb_build_object('last_reset_note', p_note)),
    now()
  )
  on conflict (tenant_id, channel, thread_id) do update set
    status = 'bot_active',
    silence_after_escalation = true,
    reset_at = now(),
    reset_by = p_reset_by,
    escalation_reason = null,
    metadata = coalesce(public.thread_states.metadata, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object('last_reset_note', p_note)),
    updated_at = now()
  returning * into v_state;

  return jsonb_build_object(
    'tenant_id', v_state.tenant_id,
    'channel', v_state.channel,
    'thread_id', v_state.thread_id,
    'status', v_state.status,
    'reset_at', v_state.reset_at,
    'reset_by', v_state.reset_by,
    'updated_at', v_state.updated_at
  );
end;
$$;
