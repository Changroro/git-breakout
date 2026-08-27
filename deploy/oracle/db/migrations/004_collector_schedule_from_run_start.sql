create or replace function api.start_collection(p_run_id uuid, p_started_at timestamptz)
returns void
language plpgsql
volatile
set search_path = pg_catalog, radar
as $$
declare
  configured_lease_minutes integer;
  configured_interval_minutes integer;
  latest_completed_started_at timestamptz;
begin
  select interval_minutes, lease_minutes
  into strict configured_interval_minutes, configured_lease_minutes
  from radar.collector_settings
  where id;

  select max(started_at) into latest_completed_started_at
  from radar.collector_runs
  where status = 'completed';
  if latest_completed_started_at is not null and
     latest_completed_started_at + make_interval(mins => configured_interval_minutes) > p_started_at then
    raise exception 'Next collection is not due until %',
      latest_completed_started_at + make_interval(mins => configured_interval_minutes);
  end if;

  delete from radar.collector_lease where expires_at <= p_started_at;

  insert into radar.collector_runs (id, started_at, status)
  values (p_run_id, p_started_at, 'running');

  insert into radar.collector_lease (run_id, expires_at)
  values (p_run_id, p_started_at + make_interval(mins => configured_lease_minutes));
end;
$$;

revoke execute on function api.start_collection(uuid, timestamptz) from public;
grant execute on function api.start_collection(uuid, timestamptz) to collector;

notify pgrst, 'reload schema';
