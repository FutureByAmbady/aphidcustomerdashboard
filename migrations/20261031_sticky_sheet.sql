-- STAGED ONLY. Review and apply separately; no existing tables are altered.
begin;
create table public.sticky_sheet_state (
  device_id text primary key ,
  registered_at timestamptz not null,
  completed_advances integer not null default 0 check (completed_advances >= 0)
);
create table public.sticky_sheet_replacement_requests (
  request_id uuid primary key,
  device_id text not null ,
  action text not null default 'register_new_sticky_sheet' check (action = 'register_new_sticky_sheet'),
  requested_at timestamptz not null,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  acknowledged_at timestamptz,
  error_code text,
  check ((status = 'completed') = (acknowledged_at is not null))
);
-- A failed request remains unresolved: retries reuse its ID rather than create another.
create unique index sticky_sheet_one_unresolved_per_device
  on public.sticky_sheet_replacement_requests(device_id) where status in ('pending','failed');
alter table public.sticky_sheet_state enable row level security;
alter table public.sticky_sheet_replacement_requests enable row level security;
revoke all on public.sticky_sheet_state, public.sticky_sheet_replacement_requests from public, anon, authenticated;
grant select on public.sticky_sheet_state, public.sticky_sheet_replacement_requests to service_role;
-- Optional trusted device telemetry may publish the current sheet advance count.
grant update(completed_advances) on public.sticky_sheet_state to service_role;

create function public.register_sticky_sheet_replacement(p_device_id text, p_request_id uuid, p_requested_at timestamptz, p_retry boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.sticky_sheet_replacement_requests;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_device_id, 0));
  if not exists(select 1 from public.devices where device_id = p_device_id) then raise exception 'Unknown device'; end if;
  if p_requested_at is null or p_requested_at > now() + interval '5 minutes' then raise exception 'Invalid timestamp'; end if;
  select * into r from public.sticky_sheet_replacement_requests where request_id = p_request_id for update;
  if found then
    if r.device_id <> p_device_id then raise exception 'Request target mismatch'; end if;
    if r.status = 'failed' and p_retry then
      update public.sticky_sheet_replacement_requests set status = 'pending', error_code = null where request_id = p_request_id returning * into r;
    end if;
    return to_jsonb(r);
  end if;
  select * into r from public.sticky_sheet_replacement_requests where device_id = p_device_id and status in ('pending','failed') for update;
  if found then return to_jsonb(r); end if;
  insert into public.sticky_sheet_replacement_requests(request_id,device_id,requested_at)
    values(p_request_id,p_device_id,p_requested_at) returning * into r;
  return to_jsonb(r);
end $$;

-- Trusted device backend only. Call AFTER a durable, idempotent Pi-side reset.
-- Not exposed by either dashboard API. Never resets any hardware or project state.
create function public.acknowledge_sticky_sheet_replacement(p_device_id text, p_request_id uuid, p_success boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.sticky_sheet_replacement_requests;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_device_id, 0));
  select * into r from public.sticky_sheet_replacement_requests where request_id = p_request_id and device_id = p_device_id for update;
  if not found then raise exception 'Unknown request'; end if;
  if r.status = 'completed' then return to_jsonb(r); end if;
  if r.status <> 'pending' then raise exception 'Request is not pending'; end if;
  if p_success is null then raise exception 'Missing outcome'; end if;
  if p_success then
    update public.sticky_sheet_replacement_requests set status = 'completed', acknowledged_at = clock_timestamp(), error_code = null
      where request_id = p_request_id returning * into r;
    insert into public.sticky_sheet_state(device_id,registered_at,completed_advances) values(p_device_id,r.acknowledged_at,0)
      on conflict(device_id) do update set registered_at = excluded.registered_at, completed_advances = 0;
  else
    update public.sticky_sheet_replacement_requests set status = 'failed', error_code = 'device_processing_failed'
      where request_id = p_request_id returning * into r;
  end if;
  return to_jsonb(r);
end $$;
revoke all on function public.register_sticky_sheet_replacement(text,uuid,timestamptz,boolean) from public, anon, authenticated;
revoke all on function public.acknowledge_sticky_sheet_replacement(text,uuid,boolean) from public, anon, authenticated;
grant execute on function public.register_sticky_sheet_replacement(text,uuid,timestamptz,boolean) to service_role;
grant execute on function public.acknowledge_sticky_sheet_replacement(text,uuid,boolean) to service_role;
commit;
