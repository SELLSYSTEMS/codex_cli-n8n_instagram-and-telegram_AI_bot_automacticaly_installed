-- Seller-owned commercial progression. This is not human escalation.
create table if not exists agent.commercial_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agent.tenants(id) on delete cascade,
  conversation_id uuid not null references agent.conversations(id) on delete cascade,
  action_id text not null,
  status text not null default 'requested'
    check (status in ('requested', 'preparing', 'ready', 'delivered', 'cancelled')),
  customer_commitment text,
  context jsonb not null default '{}'::jsonb,
  test_only boolean not null default false,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, conversation_id, action_id)
);

create index if not exists commercial_requests_tenant_status_idx
  on agent.commercial_requests (tenant_id, status, updated_at desc);

drop trigger if exists commercial_requests_touch_updated_at on agent.commercial_requests;
create trigger commercial_requests_touch_updated_at
before update on agent.commercial_requests
for each row execute function agent.touch_updated_at();

create or replace function agent.project_commercial_request_from_conversation()
returns trigger
language plpgsql
as $$
declare
  resolution jsonb := coalesce(new.semantic_state -> 'commercial_action_resolution', '{}'::jsonb);
  selection jsonb := coalesce(resolution -> 'selection', '{}'::jsonb);
  execution jsonb := coalesce(resolution -> 'execution', '{}'::jsonb);
  selected_action text := nullif(selection ->> 'action_id', '');
  selected_commitment text := nullif(selection ->> 'customer_commitment', '');
  is_test boolean := coalesce(
    lower(new.semantic_state #>> '{metadata,test_only}') in ('true', '1', 'yes'),
    false
  );
begin
  if coalesce((resolution ->> 'valid')::boolean, false)
     and selected_action = 'request_custom_proposal'
     and execution ->> 'kind' = 'persist_custom_proposal_request' then
    insert into agent.commercial_requests (
      tenant_id,
      conversation_id,
      action_id,
      status,
      customer_commitment,
      context,
      test_only
    )
    values (
      new.tenant_id,
      new.id,
      selected_action,
      'requested',
      selected_commitment,
      jsonb_build_object(
        'selection', selection,
        'execution', execution,
        'semantic_state_updated_at', new.updated_at
      ),
      is_test
    )
    on conflict (tenant_id, conversation_id, action_id)
    do update set
      customer_commitment = coalesce(excluded.customer_commitment, agent.commercial_requests.customer_commitment),
      context = excluded.context,
      test_only = excluded.test_only,
      updated_at = now();
  end if;
  return new;
end
$$;

drop trigger if exists conversations_project_commercial_request on agent.conversations;
create trigger conversations_project_commercial_request
after insert or update of semantic_state on agent.conversations
for each row execute function agent.project_commercial_request_from_conversation();
