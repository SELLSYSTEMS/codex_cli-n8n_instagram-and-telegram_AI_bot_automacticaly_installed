begin;

alter table agent.conversations
  drop constraint if exists conversations_durable_memory_version_check;

alter table agent.conversations
  drop constraint if exists conversations_durable_memory_schema_check;

create or replace function agent.normalize_conversation_memory(p_state jsonb)
returns jsonb
language sql
immutable
parallel safe
as $$
  with source as (
    select case
      when jsonb_typeof(coalesce(p_state, '{}'::jsonb)) = 'object'
        then coalesce(p_state, '{}'::jsonb)
      else '{}'::jsonb
    end as value
  ),
  facts as (
    select case
      when jsonb_typeof(source.value->'settled_customer_facts') = 'array' then
        agent.bound_memory_json(
          source.value->'settled_customer_facts',
          'array',
          8000,
          '[]'::jsonb
        )
      when jsonb_typeof(source.value->'settled_customer_facts') = 'object' then
        agent.bound_memory_json(
          coalesce(
            (
              select jsonb_agg(
                jsonb_build_object('key', item.key, 'value', item.value)
                order by item.key
              )
              from jsonb_each(source.value->'settled_customer_facts') as item(key, value)
            ),
            '[]'::jsonb
          ),
          'array',
          8000,
          '[]'::jsonb
        )
      else '[]'::jsonb
    end as value
    from source
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'schema_version', 3,
    'current_objective', nullif(left(coalesce(source.value->>'current_objective', ''), 1200), ''),
    'active_workstreams', agent.bound_memory_json(source.value->'active_workstreams', 'array', 10000, '[]'::jsonb),
    'settled_customer_facts', facts.value,
    'confirmed_commitments', agent.bound_memory_json(source.value->'confirmed_commitments', 'array', 6000, '[]'::jsonb),
    'unresolved_material_question', nullif(left(coalesce(source.value->>'unresolved_material_question', ''), 1200), ''),
    'last_completed_outcome', nullif(left(coalesce(source.value->>'last_completed_outcome', ''), 1600), ''),
    'active_commercial_lifecycle', agent.bound_memory_json(source.value->'active_commercial_lifecycle', 'object', 5000, '{}'::jsonb),
    'sparse_contact_profile', agent.bound_memory_json(source.value->'sparse_contact_profile', 'object', 5000, '{}'::jsonb),
    'established_response_language', nullif(left(coalesce(source.value->>'established_response_language', ''), 80), ''),
    'authoritative_evidence_references', agent.bound_memory_json(source.value->'authoritative_evidence_references', 'array', 6000, '[]'::jsonb),
    'commercial_readiness', case
      when source.value->>'commercial_readiness' in ('not_ready', 'considering', 'explicitly_ready')
        then source.value->>'commercial_readiness'
      else 'not_ready'
    end,
    'scope_sufficiency', case
      when source.value->>'scope_sufficiency' in ('insufficient', 'proposal_ready', 'transaction_ready')
        then source.value->>'scope_sufficiency'
      else 'insufficient'
    end
  ))
  from source
  cross join facts;
$$;

create or replace function agent.enforce_bounded_conversation_memory()
returns trigger
language plpgsql
as $$
begin
  new.durable_memory := agent.normalize_conversation_memory(new.durable_memory);
  new.durable_memory_version := 3;
  return new;
end;
$$;

alter table agent.conversations
  alter column durable_memory_version set default 3,
  alter column durable_memory set default '{
    "schema_version": 3,
    "current_objective": null,
    "active_workstreams": [],
    "settled_customer_facts": [],
    "confirmed_commitments": [],
    "unresolved_material_question": null,
    "last_completed_outcome": null,
    "active_commercial_lifecycle": {},
    "sparse_contact_profile": {},
    "established_response_language": null,
    "authoritative_evidence_references": [],
    "commercial_readiness": "not_ready",
    "scope_sufficiency": "insufficient"
  }'::jsonb;

update agent.conversations
set durable_memory = agent.normalize_conversation_memory(durable_memory),
    durable_memory_version = 3;

alter table agent.conversations
  add constraint conversations_durable_memory_version_check
  check (durable_memory_version = 3);

alter table agent.conversations
  add constraint conversations_durable_memory_schema_check
  check (
    durable_memory @> '{"schema_version": 3}'::jsonb
    and durable_memory ? 'settled_customer_facts'
    and jsonb_typeof(durable_memory->'settled_customer_facts') = 'array'
    and durable_memory->>'commercial_readiness' in ('not_ready', 'considering', 'explicitly_ready')
    and durable_memory->>'scope_sufficiency' in ('insufficient', 'proposal_ready', 'transaction_ready')
  );

commit;
