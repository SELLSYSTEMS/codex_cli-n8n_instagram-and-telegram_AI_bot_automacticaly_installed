begin;

create or replace function agent.bound_memory_json(
  p_value jsonb,
  p_expected_type text,
  p_max_bytes integer,
  p_fallback jsonb
)
returns jsonb
language sql
immutable
parallel safe
as $$
  select case
    when p_value is null then p_fallback
    when jsonb_typeof(p_value) <> p_expected_type then p_fallback
    when octet_length(p_value::text) > p_max_bytes then p_fallback
    else p_value
  end;
$$;

create or replace function agent.normalize_conversation_memory(p_state jsonb)
returns jsonb
language sql
immutable
parallel safe
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 2,
    'current_objective', nullif(left(coalesce(p_state->>'current_objective', ''), 1200), ''),
    'active_workstreams', agent.bound_memory_json(p_state->'active_workstreams', 'array', 10000, '[]'::jsonb),
    'settled_customer_facts', agent.bound_memory_json(p_state->'settled_customer_facts', 'object', 8000, '{}'::jsonb),
    'confirmed_commitments', agent.bound_memory_json(p_state->'confirmed_commitments', 'array', 6000, '[]'::jsonb),
    'unresolved_material_question', nullif(left(coalesce(p_state->>'unresolved_material_question', ''), 1200), ''),
    'last_completed_outcome', nullif(left(coalesce(p_state->>'last_completed_outcome', ''), 1600), ''),
    'active_commercial_lifecycle', agent.bound_memory_json(p_state->'active_commercial_lifecycle', 'object', 5000, '{}'::jsonb),
    'sparse_contact_profile', agent.bound_memory_json(p_state->'sparse_contact_profile', 'object', 5000, '{}'::jsonb),
    'established_response_language', nullif(left(coalesce(p_state->>'established_response_language', ''), 80), ''),
    'authoritative_evidence_references', agent.bound_memory_json(p_state->'authoritative_evidence_references', 'array', 6000, '[]'::jsonb)
  ));
$$;

alter table agent.conversations
  add column if not exists durable_memory_version smallint not null default 2,
  add column if not exists durable_memory jsonb not null default '{"schema_version":2,"active_workstreams":[],"settled_customer_facts":{},"confirmed_commitments":[],"active_commercial_lifecycle":{},"sparse_contact_profile":{},"authoritative_evidence_references":[]}'::jsonb;

update agent.conversations
set durable_memory = agent.normalize_conversation_memory(semantic_state),
    durable_memory_version = 2
where durable_memory = '{"schema_version":2,"active_workstreams":[],"settled_customer_facts":{},"confirmed_commitments":[],"active_commercial_lifecycle":{},"sparse_contact_profile":{},"authoritative_evidence_references":[]}'::jsonb;

alter table agent.conversations
  drop constraint if exists conversations_durable_memory_version_check,
  add constraint conversations_durable_memory_version_check check (durable_memory_version = 2),
  drop constraint if exists conversations_durable_memory_size_check,
  add constraint conversations_durable_memory_size_check check (octet_length(durable_memory::text) <= 32768);

create or replace function agent.enforce_bounded_conversation_memory()
returns trigger
language plpgsql
as $$
begin
  new.durable_memory := agent.normalize_conversation_memory(new.durable_memory);
  new.durable_memory_version := 2;
  return new;
end;
$$;

drop trigger if exists conversations_bound_durable_memory on agent.conversations;
create trigger conversations_bound_durable_memory
before insert or update of durable_memory on agent.conversations
for each row execute function agent.enforce_bounded_conversation_memory();

comment on column agent.conversations.semantic_state is
  'Legacy compatibility state. New live prompts use bounded durable_memory.';
comment on column agent.conversations.durable_memory is
  'Versioned bounded canonical conversational memory; never store prompts, retrieved dumps, credentials, or unbounded history.';

commit;
