begin;

-- Commercial actions are explicit durable operations. Conversation-state updates
-- must never create them implicitly.
drop trigger if exists conversations_project_commercial_request on agent.conversations;
drop function if exists agent.project_commercial_request_from_conversation();

alter table agent.commercial_requests
  add column if not exists lifecycle_key text,
  add column if not exists idempotency_key text,
  add column if not exists source_inbound_message_id uuid references agent.messages(id) on delete set null,
  add column if not exists evidence_ids uuid[] not null default '{}'::uuid[],
  add column if not exists confirmed_scope_summary text;

update agent.commercial_requests
set lifecycle_key = coalesce(nullif(lifecycle_key, ''), 'proposal:' || action_id),
    idempotency_key = coalesce(nullif(idempotency_key, ''), id::text),
    confirmed_scope_summary = left(coalesce(confirmed_scope_summary, context->>'confirmed_scope_summary', ''), 2000)
where lifecycle_key is null
   or idempotency_key is null
   or confirmed_scope_summary is null;

alter table agent.commercial_requests
  alter column lifecycle_key set not null,
  alter column idempotency_key set not null;

drop index if exists agent.commercial_requests_one_active_action_idx;
create unique index if not exists commercial_requests_one_active_lifecycle_idx
  on agent.commercial_requests (tenant_id, conversation_id, lifecycle_key)
  where status in ('requested', 'preparing', 'ready');

create unique index if not exists commercial_requests_idempotency_idx
  on agent.commercial_requests (tenant_id, conversation_id, idempotency_key);

create or replace function agent.claim_commercial_request(
  p_tenant_id uuid,
  p_conversation_id uuid,
  p_action_id text,
  p_lifecycle_key text,
  p_idempotency_key text,
  p_customer_commitment text,
  p_source_inbound_message_id uuid,
  p_evidence_ids uuid[],
  p_confirmed_scope_summary text,
  p_context jsonb,
  p_test_only boolean default false
)
returns table(request_id uuid, request_status text, created boolean)
language plpgsql
security invoker
set search_path = agent, public
as $$
declare
  existing agent.commercial_requests%rowtype;
begin
  if p_tenant_id is null or p_conversation_id is null then
    raise exception 'tenant_id and conversation_id are required';
  end if;
  if nullif(btrim(p_action_id), '') is null
     or nullif(btrim(p_lifecycle_key), '') is null
     or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'action_id, lifecycle_key, and idempotency_key are required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_conversation_id::text || ':' || p_lifecycle_key, 0)
  );

  select * into existing
  from agent.commercial_requests
  where tenant_id = p_tenant_id
    and conversation_id = p_conversation_id
    and lifecycle_key = p_lifecycle_key
    and status in ('requested', 'preparing', 'ready')
  order by requested_at desc
  limit 1
  for update;

  if found then
    return query select existing.id, existing.status, false;
    return;
  end if;

  insert into agent.commercial_requests (
    tenant_id,
    conversation_id,
    action_id,
    lifecycle_key,
    idempotency_key,
    status,
    customer_commitment,
    source_inbound_message_id,
    evidence_ids,
    confirmed_scope_summary,
    context,
    test_only
  ) values (
    p_tenant_id,
    p_conversation_id,
    p_action_id,
    p_lifecycle_key,
    p_idempotency_key,
    'requested',
    left(coalesce(p_customer_commitment, ''), 1000),
    p_source_inbound_message_id,
    coalesce(p_evidence_ids, '{}'::uuid[]),
    left(coalesce(p_confirmed_scope_summary, ''), 2000),
    jsonb_strip_nulls(jsonb_build_object(
      'customer_commitment', left(coalesce(p_customer_commitment, ''), 1000),
      'confirmed_scope_summary', left(coalesce(p_confirmed_scope_summary, ''), 2000),
      'evidence_ids', to_jsonb(coalesce(p_evidence_ids, '{}'::uuid[]))
    ) || coalesce(p_context, '{}'::jsonb)),
    coalesce(p_test_only, false)
  )
  returning id, status into request_id, request_status;

  created := true;
  return next;
end;
$$;

alter table agent.delivery_events
  add column if not exists idempotency_key text,
  add column if not exists provider_message_id text,
  add column if not exists provider_status text,
  add column if not exists outcome_certainty text not null default 'not_attempted',
  add column if not exists attempt_started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update agent.delivery_events
set idempotency_key = coalesce(nullif(idempotency_key, ''), id::text),
    updated_at = coalesce(updated_at, created_at)
where idempotency_key is null;

alter table agent.delivery_events alter column idempotency_key set not null;

create unique index if not exists delivery_events_idempotency_idx
  on agent.delivery_events (tenant_id, channel, idempotency_key);

create or replace function agent.claim_delivery_event(
  p_tenant_id uuid,
  p_conversation_id uuid,
  p_channel text,
  p_idempotency_key text,
  p_payload jsonb default '{}'::jsonb
)
returns table(delivery_id uuid, delivery_status text, should_send boolean)
language plpgsql
security invoker
set search_path = agent, public
as $$
declare
  existing agent.delivery_events%rowtype;
begin
  if p_tenant_id is null or nullif(btrim(p_channel), '') is null
     or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'tenant_id, channel, and idempotency_key are required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_channel || ':' || p_idempotency_key, 0)
  );

  select * into existing
  from agent.delivery_events
  where tenant_id = p_tenant_id
    and channel = p_channel
    and idempotency_key = p_idempotency_key
  limit 1
  for update;

  if found then
    return query select existing.id, existing.status, false;
    return;
  end if;

  insert into agent.delivery_events (
    tenant_id,
    conversation_id,
    channel,
    idempotency_key,
    status,
    outcome_certainty,
    attempt_started_at,
    payload
  ) values (
    p_tenant_id,
    p_conversation_id,
    btrim(p_channel),
    btrim(p_idempotency_key),
    'claimed',
    'not_attempted',
    now(),
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id, status into delivery_id, delivery_status;

  should_send := true;
  return next;
end;
$$;

create or replace function agent.complete_delivery_event(
  p_delivery_id uuid,
  p_status text,
  p_outcome_certainty text,
  p_provider_message_id text default null,
  p_provider_status text default null,
  p_result jsonb default '{}'::jsonb
)
returns agent.delivery_events
language plpgsql
security invoker
set search_path = agent, public
as $$
declare
  completed agent.delivery_events%rowtype;
begin
  if p_status not in ('sent', 'failed_safe', 'unknown') then
    raise exception 'invalid terminal delivery status';
  end if;
  if p_outcome_certainty not in ('confirmed_sent', 'confirmed_not_sent', 'uncertain') then
    raise exception 'invalid outcome certainty';
  end if;

  update agent.delivery_events
  set status = p_status,
      outcome_certainty = p_outcome_certainty,
      provider_message_id = nullif(p_provider_message_id, ''),
      provider_status = nullif(p_provider_status, ''),
      completed_at = now(),
      updated_at = now(),
      payload = payload || jsonb_build_object('provider_result', coalesce(p_result, '{}'::jsonb))
  where id = p_delivery_id
    and status = 'claimed'
  returning * into completed;

  if not found then
    select * into completed from agent.delivery_events where id = p_delivery_id;
  end if;
  return completed;
end;
$$;

commit;
