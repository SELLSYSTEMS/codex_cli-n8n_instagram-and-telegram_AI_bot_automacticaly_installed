alter table agent.commercial_requests
  add column if not exists operator_note text,
  add column if not exists resolved_at timestamptz;

create index if not exists commercial_requests_resolved_lookup_idx
  on agent.commercial_requests (tenant_id, resolved_at desc)
  where resolved_at is not null;

create or replace function agent.transition_commercial_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_status text,
  p_operator_note text default null
)
returns agent.commercial_requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request agent.commercial_requests;
  v_status text := lower(trim(p_status));
  v_current_rank integer;
  v_target_rank integer;
begin
  if v_status not in ('requested', 'preparing', 'ready', 'delivered', 'cancelled') then
    raise exception 'Unsupported commercial request status: %', p_status
      using errcode = '22023';
  end if;

  select *
    into v_request
    from agent.commercial_requests
   where tenant_id = p_tenant_id
     and id = p_request_id
   for update;

  if not found then
    raise exception 'Commercial request % was not found for tenant %', p_request_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  if v_request.status in ('delivered', 'cancelled') and v_request.status <> v_status then
    raise exception 'Terminal commercial request status % cannot transition to %', v_request.status, v_status
      using errcode = '22023';
  end if;

  v_current_rank := case v_request.status
    when 'requested' then 1
    when 'preparing' then 2
    when 'ready' then 3
    when 'delivered' then 4
    when 'cancelled' then 4
  end;
  v_target_rank := case v_status
    when 'requested' then 1
    when 'preparing' then 2
    when 'ready' then 3
    when 'delivered' then 4
    when 'cancelled' then 4
  end;

  if v_status <> 'cancelled' and v_target_rank < v_current_rank then
    raise exception 'Commercial request status cannot move backward from % to %', v_request.status, v_status
      using errcode = '22023';
  end if;

  update agent.commercial_requests
     set status = v_status,
         operator_note = case
           when nullif(trim(p_operator_note), '') is null then operator_note
           else trim(p_operator_note)
         end,
         resolved_at = case
           when v_status in ('delivered', 'cancelled') then coalesce(resolved_at, now())
           else null
         end,
         updated_at = now()
   where tenant_id = p_tenant_id
     and id = p_request_id
  returning * into v_request;

  return v_request;
end;
$$;

comment on function agent.transition_commercial_request(uuid, uuid, text, text) is
  'Tenant-scoped, forward-only operator transition for a commercial request lifecycle.';
