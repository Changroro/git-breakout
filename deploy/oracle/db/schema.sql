create schema radar;
create schema api;

revoke create on schema public from public;
revoke all on schema radar, api from public;

create role web_anon nologin;
create role collector nologin;
create role authenticator noinherit login password :'authenticator_password';
grant web_anon, collector to authenticator;

create table radar.collector_settings (
  id boolean primary key default true check (id),
  interval_minutes integer not null check (interval_minutes > 0),
  lease_minutes integer not null check (lease_minutes > 0),
  retention_grace_days integer not null check (retention_grace_days > 0),
  retention_growth_days integer not null check (retention_growth_days > 0),
  retention_push_days integer not null check (retention_push_days > 0),
  retention_repository_limit integer not null check (retention_repository_limit > 0),
  updated_at timestamptz not null
);

insert into radar.collector_settings (
  interval_minutes,
  lease_minutes,
  retention_grace_days,
  retention_growth_days,
  retention_push_days,
  retention_repository_limit,
  updated_at
)
values (120, 30, 14, 7, 30, 1000, now());

create table radar.collector_runs (
  id uuid primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('running', 'completed', 'failed')),
  error_message text,
  check (
    (status = 'running' and finished_at is null and error_message is null) or
    (status = 'completed' and finished_at is not null and error_message is null) or
    (status = 'failed' and finished_at is not null and error_message is not null)
  )
);

create table radar.collector_lease (
  id boolean primary key default true check (id),
  run_id uuid not null unique references radar.collector_runs(id) on delete restrict,
  expires_at timestamptz not null
);

create table radar.snapshots (
  id uuid primary key references radar.collector_runs(id) on delete restrict,
  captured_at timestamptz not null unique,
  source text not null check (source <> ''),
  repository_count integer not null check (repository_count > 0),
  created_at timestamptz not null default now()
);

create table radar.snapshot_repositories (
  snapshot_id uuid not null references radar.snapshots(id) on delete restrict,
  captured_at timestamptz not null,
  full_name text not null check (full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
  full_name_key text generated always as (lower(full_name)) stored,
  rank integer not null check (rank > 0),
  stars integer not null check (stars >= 0),
  payload_json jsonb not null check (jsonb_typeof(payload_json) = 'object'),
  primary key (snapshot_id, full_name_key),
  unique (snapshot_id, rank)
);

create index collector_runs_status_started_idx
  on radar.collector_runs (status, started_at desc);
create index snapshot_repositories_snapshot_idx
  on radar.snapshot_repositories (snapshot_id, rank);
create index snapshot_repositories_history_idx
  on radar.snapshot_repositories (full_name_key, captured_at desc);

alter table radar.collector_settings enable row level security;
alter table radar.collector_settings force row level security;
alter table radar.collector_runs enable row level security;
alter table radar.collector_runs force row level security;
alter table radar.collector_lease enable row level security;
alter table radar.collector_lease force row level security;
alter table radar.snapshots enable row level security;
alter table radar.snapshots force row level security;
alter table radar.snapshot_repositories enable row level security;
alter table radar.snapshot_repositories force row level security;

create policy collector_settings_read on radar.collector_settings
  for select to collector using (true);
create policy collector_runs_access on radar.collector_runs
  for all to collector using (true) with check (true);
create policy collector_lease_access on radar.collector_lease
  for all to collector using (true) with check (true);
create policy snapshots_collector_access on radar.snapshots
  for all to collector using (true) with check (true);
create policy snapshots_public_read on radar.snapshots
  for select to web_anon using (true);
create policy snapshot_repositories_collector_access on radar.snapshot_repositories
  for all to collector using (true) with check (true);
create policy snapshot_repositories_public_read on radar.snapshot_repositories
  for select to web_anon using (true);

grant usage on schema radar, api to collector;
grant usage on schema radar, api to web_anon;
grant select on radar.collector_settings to collector;
grant select, insert, update on radar.collector_runs to collector;
grant select, insert, delete on radar.collector_lease to collector;
grant select, insert on radar.snapshots to collector;
grant select, insert on radar.snapshot_repositories to collector;
grant select on radar.snapshots, radar.snapshot_repositories to web_anon;

create function api.start_collection(p_run_id uuid, p_started_at timestamptz)
returns void
language plpgsql
volatile
set search_path = pg_catalog, radar
as $$
declare
  configured_lease_minutes integer;
  configured_interval_minutes integer;
  latest_captured_at timestamptz;
begin
  select interval_minutes, lease_minutes
  into strict configured_interval_minutes, configured_lease_minutes
  from radar.collector_settings
  where id;

  select max(captured_at) into latest_captured_at from radar.snapshots;
  if latest_captured_at is not null and
     latest_captured_at + make_interval(mins => configured_interval_minutes) > p_started_at then
    raise exception 'Next collection is not due until %',
      latest_captured_at + make_interval(mins => configured_interval_minutes);
  end if;

  delete from radar.collector_lease where expires_at <= p_started_at;

  insert into radar.collector_runs (id, started_at, status)
  values (p_run_id, p_started_at, 'running');

  insert into radar.collector_lease (run_id, expires_at)
  values (p_run_id, p_started_at + make_interval(mins => configured_lease_minutes));
end;
$$;

create function api.fail_collection(
  p_run_id uuid,
  p_finished_at timestamptz,
  p_error_message text
)
returns void
language plpgsql
volatile
set search_path = pg_catalog, radar
as $$
declare
  updated_rows integer;
begin
  if btrim(p_error_message) = '' then
    raise exception 'Collection failure message is required';
  end if;

  update radar.collector_runs
  set finished_at = p_finished_at,
      status = 'failed',
      error_message = p_error_message
  where id = p_run_id and status = 'running';
  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then
    raise exception 'Running collector run % does not exist', p_run_id;
  end if;

  delete from radar.collector_lease where run_id = p_run_id;
end;
$$;

create function api.collection_context()
returns jsonb
language sql
stable
set search_path = pg_catalog, radar
as $$
  with policy as (
    select
      retention_grace_days,
      retention_growth_days,
      retention_push_days,
      retention_repository_limit
    from radar.collector_settings
    where id
  ), latest_snapshot as (
    select max(captured_at) as captured_at
    from radar.snapshots
  ), ranked_observations as (
    select
      full_name_key,
      full_name,
      captured_at,
      stars,
      rank,
      payload_json,
      min(captured_at) over (partition by full_name_key) as first_seen_at,
      row_number() over (
        partition by full_name_key
        order by captured_at desc
      ) as observation_number
    from radar.snapshot_repositories
  ), repository_context as (
    select
      full_name_key,
      (array_agg(full_name order by captured_at desc))[1] as full_name,
      min(first_seen_at) as first_seen_at,
      (array_agg(captured_at order by captured_at desc))[1] as latest_captured_at,
      (array_agg(payload_json ->> 'pushed_at' order by captured_at desc))[1] as latest_pushed_at,
      (array_agg(rank order by captured_at desc))[1] as latest_rank,
      (array_agg(stars order by captured_at desc))[1] as latest_stars,
      jsonb_agg(
        jsonb_build_object('captured_at', captured_at, 'stars', stars)
        order by captured_at desc
      ) as observations
    from ranked_observations
    where observation_number <= 20
    group by full_name_key
  ), repository_summaries as (
    select
      repository_context.*,
      comparison.stars as growth_comparison_stars
    from repository_context
    cross join policy
    cross join latest_snapshot
    left join lateral (
      select repositories.stars
      from radar.snapshot_repositories repositories
      where repositories.full_name_key = repository_context.full_name_key
        and repositories.captured_at <= latest_snapshot.captured_at
          - make_interval(days => policy.retention_growth_days)
      order by repositories.captured_at desc
      limit 1
    ) comparison on true
  )
  select jsonb_build_object(
    'latest_captured_at', (select max(captured_at) from radar.snapshots),
    'interval_minutes', (
      select interval_minutes from radar.collector_settings where id
    ),
    'retention_policy', (
      select jsonb_build_object(
        'grace_days', retention_grace_days,
        'growth_days', retention_growth_days,
        'push_days', retention_push_days,
        'repository_limit', retention_repository_limit
      )
      from policy
    ),
    'repositories', coalesce(
      (select jsonb_agg(
        jsonb_build_object(
          'full_name', full_name,
          'first_seen_at', first_seen_at,
          'latest_captured_at', latest_captured_at,
          'latest_pushed_at', latest_pushed_at,
          'latest_rank', latest_rank,
          'latest_stars', latest_stars,
          'growth_comparison_stars', growth_comparison_stars,
          'observations', observations
        )
        order by full_name_key
      ) from repository_summaries),
      '[]'::jsonb
    )
  );
$$;

create function api.complete_collection(
  p_run_id uuid,
  p_captured_at timestamptz,
  p_source text,
  p_repositories jsonb
)
returns void
language plpgsql
volatile
set search_path = pg_catalog, radar
as $$
declare
  repository_count integer;
  inserted_rows integer;
begin
  if jsonb_typeof(p_repositories) <> 'array' then
    raise exception 'Repositories must be a JSON array';
  end if;
  repository_count := jsonb_array_length(p_repositories);
  if repository_count = 0 then
    raise exception 'Collection must contain repositories';
  end if;
  if btrim(p_source) = '' then
    raise exception 'Collection source is required';
  end if;
  if not exists (
    select 1
    from radar.collector_runs runs
    join radar.collector_lease lease on lease.run_id = runs.id
    where runs.id = p_run_id
      and runs.status = 'running'
      and lease.expires_at > p_captured_at
  ) then
    raise exception 'Active collector run % does not exist', p_run_id;
  end if;

  insert into radar.snapshots (id, captured_at, source, repository_count)
  values (p_run_id, p_captured_at, p_source, repository_count);

  insert into radar.snapshot_repositories (
    snapshot_id,
    captured_at,
    full_name,
    rank,
    stars,
    payload_json
  )
  select
    p_run_id,
    p_captured_at,
    repository->>'full_name',
    (repository->>'rank')::integer,
    (repository #>> '{metrics,stars}')::integer,
    repository
  from jsonb_array_elements(p_repositories) as repository;
  get diagnostics inserted_rows = row_count;
  if inserted_rows <> repository_count then
    raise exception 'Inserted % of % repositories', inserted_rows, repository_count;
  end if;

  update radar.collector_runs
  set finished_at = p_captured_at,
      status = 'completed',
      error_message = null
  where id = p_run_id and status = 'running';

  delete from radar.collector_lease where run_id = p_run_id;
end;
$$;

create function api.snapshot_timeline()
returns table (
  id uuid,
  captured_at timestamptz,
  source text,
  repository_count integer
)
language sql
stable
set search_path = pg_catalog, radar
as $$
  select id, captured_at, source, repository_count
  from radar.snapshots
  order by captured_at;
$$;

create function api.snapshot_repositories(p_snapshot_id uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  repositories jsonb;
begin
  if not exists (select 1 from radar.snapshots where id = p_snapshot_id) then
    raise exception 'Snapshot % does not exist', p_snapshot_id;
  end if;
  select jsonb_agg(payload_json order by rank)
  into repositories
  from radar.snapshot_repositories
  where snapshot_id = p_snapshot_id;
  return repositories;
end;
$$;

create function api.repository_star_series(
  p_snapshot_id uuid,
  p_full_names text[]
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  selected_captured_at timestamptz;
  response jsonb;
begin
  if cardinality(p_full_names) is null or cardinality(p_full_names) not between 1 and 10 then
    raise exception 'Star series requires between 1 and 10 repositories';
  end if;
  if exists (
    select 1
    from unnest(p_full_names) as names(full_name)
    where full_name !~ '^[^/[:space:]]+/[^/[:space:]]+$'
  ) then
    raise exception 'Star series repository names must use owner/name format';
  end if;
  if (
    select count(*)
    from (select distinct lower(full_name) from unnest(p_full_names) as names(full_name)) unique_names
  ) <> cardinality(p_full_names) then
    raise exception 'Star series repository names must be unique';
  end if;

  select captured_at into selected_captured_at
  from radar.snapshots
  where id = p_snapshot_id;
  if selected_captured_at is null then
    raise exception 'Snapshot % does not exist', p_snapshot_id;
  end if;
  if exists (
    select 1
    from unnest(p_full_names) as names(full_name)
    where not exists (
      select 1
      from radar.snapshot_repositories repositories
      where repositories.snapshot_id = p_snapshot_id
        and repositories.full_name_key = lower(names.full_name)
    )
  ) then
    raise exception 'Star series repository is absent from snapshot %', p_snapshot_id;
  end if;

  select jsonb_build_object(
    'schema_version', '1.0',
    'series', jsonb_agg(
      jsonb_build_object(
        'full_name', requested.full_name,
        'points', history.points
      )
      order by requested.position
    )
  ) into response
  from unnest(p_full_names) with ordinality as requested(full_name, position)
  cross join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'captured_at', repositories.captured_at,
        'stars', repositories.stars
      )
      order by repositories.captured_at
    ) as points
    from radar.snapshot_repositories repositories
    where repositories.full_name_key = lower(requested.full_name)
      and repositories.captured_at <= selected_captured_at
  ) history;

  return response;
end;
$$;

create function api.health()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('status', 'ok');
$$;

revoke execute on all functions in schema api from public;
grant execute on function api.start_collection(uuid, timestamptz) to collector;
grant execute on function api.fail_collection(uuid, timestamptz, text) to collector;
grant execute on function api.collection_context() to collector;
grant execute on function api.complete_collection(uuid, timestamptz, text, jsonb) to collector;
grant execute on function api.snapshot_timeline() to web_anon, collector;
grant execute on function api.snapshot_repositories(uuid) to web_anon, collector;
grant execute on function api.repository_star_series(uuid, text[]) to web_anon, collector;
grant execute on function api.health() to web_anon, collector;
