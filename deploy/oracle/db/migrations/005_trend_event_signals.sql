alter table radar.collector_settings
  add column if not exists event_retention_hours integer,
  add column if not exists event_candidate_limit integer;

update radar.collector_settings
set
  event_retention_hours = 168,
  event_candidate_limit = 1000,
  updated_at = now()
where id and (
  event_retention_hours is null
  or event_candidate_limit is null
);

alter table radar.collector_settings
  alter column event_retention_hours set not null,
  alter column event_candidate_limit set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'collector_settings_event_retention_hours_check'
      and conrelid = 'radar.collector_settings'::regclass
  ) then
    alter table radar.collector_settings
      add constraint collector_settings_event_retention_hours_check
      check (event_retention_hours >= 72);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'collector_settings_event_candidate_limit_check'
      and conrelid = 'radar.collector_settings'::regclass
  ) then
    alter table radar.collector_settings
      add constraint collector_settings_event_candidate_limit_check
      check (event_candidate_limit > 0);
  end if;
end;
$$;

create table if not exists radar.repository_event_buckets (
  bucket_at timestamptz not null,
  full_name text not null check (full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
  full_name_key text generated always as (lower(full_name)) stored,
  watches integer not null check (watches >= 0),
  forks integer not null check (forks >= 0),
  pull_requests integer not null check (pull_requests >= 0),
  issues integer not null check (issues >= 0),
  issue_comments integer not null check (issue_comments >= 0),
  pushes integer not null check (pushes >= 0),
  releases integer not null check (releases >= 0),
  actor_ids bigint[] not null check (cardinality(actor_ids) > 0),
  primary key (bucket_at, full_name_key),
  check (watches + forks + pull_requests + issues + issue_comments + pushes + releases > 0)
);

create index if not exists repository_event_buckets_repository_idx
  on radar.repository_event_buckets (full_name_key, bucket_at desc);

alter table radar.repository_event_buckets enable row level security;
alter table radar.repository_event_buckets force row level security;

drop policy if exists repository_event_buckets_collector_access
  on radar.repository_event_buckets;
create policy repository_event_buckets_collector_access
  on radar.repository_event_buckets
  for all to collector using (true) with check (true);

grant select, insert, update, delete on radar.repository_event_buckets to collector;

create or replace function radar.repository_event_window(
  p_full_name_key text,
  p_captured_at timestamptz,
  p_hours integer
)
returns jsonb
language sql
stable
set search_path = pg_catalog, radar
as $$
  with matching as (
    select *
    from radar.repository_event_buckets
    where full_name_key = p_full_name_key
      and bucket_at >= p_captured_at - make_interval(hours => p_hours)
      and bucket_at < p_captured_at
  ), totals as (
    select
      coalesce(sum(watches), 0)::integer as watches,
      coalesce(sum(forks), 0)::integer as forks,
      coalesce(sum(pull_requests), 0)::integer as pull_requests,
      coalesce(sum(issues), 0)::integer as issues,
      coalesce(sum(issue_comments), 0)::integer as issue_comments,
      coalesce(sum(pushes), 0)::integer as pushes,
      coalesce(sum(releases), 0)::integer as releases
    from matching
  ), actors as (
    select count(distinct actor_id)::integer as unique_actors
    from matching
    cross join lateral unnest(actor_ids) as actor_id
  )
  select jsonb_build_object(
    'watches', totals.watches,
    'forks', totals.forks,
    'pull_requests', totals.pull_requests,
    'issues', totals.issues,
    'issue_comments', totals.issue_comments,
    'pushes', totals.pushes,
    'releases', totals.releases,
    'unique_actors', actors.unique_actors
  )
  from totals cross join actors;
$$;

create or replace function api.ingest_event_bucket(
  p_bucket_at timestamptz,
  p_repositories jsonb
)
returns void
language plpgsql
volatile
set search_path = pg_catalog, radar
as $$
declare
  configured_retention_hours integer;
begin
  if date_trunc('hour', p_bucket_at) <> p_bucket_at then
    raise exception 'Event bucket must be aligned to an exact hour';
  end if;
  if jsonb_typeof(p_repositories) <> 'array' or jsonb_array_length(p_repositories) = 0 then
    raise exception 'Event bucket repositories must be a non-empty JSON array';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_repositories) repository
    where repository->>'full_name' !~ '^[^/[:space:]]+/[^/[:space:]]+$'
      or jsonb_typeof(repository->'actor_ids') <> 'array'
      or jsonb_array_length(repository->'actor_ids') = 0
  ) then
    raise exception 'Event bucket contains an invalid repository';
  end if;

  insert into radar.repository_event_buckets (
    bucket_at,
    full_name,
    watches,
    forks,
    pull_requests,
    issues,
    issue_comments,
    pushes,
    releases,
    actor_ids
  )
  select
    p_bucket_at,
    repository->>'full_name',
    (repository->>'watches')::integer,
    (repository->>'forks')::integer,
    (repository->>'pull_requests')::integer,
    (repository->>'issues')::integer,
    (repository->>'issue_comments')::integer,
    (repository->>'pushes')::integer,
    (repository->>'releases')::integer,
    array(
      select distinct actor_id::bigint
      from jsonb_array_elements_text(repository->'actor_ids') actor_id
      order by actor_id::bigint
    )
  from jsonb_array_elements(p_repositories) repository
  on conflict (bucket_at, full_name_key) do update set
    full_name = excluded.full_name,
    watches = excluded.watches,
    forks = excluded.forks,
    pull_requests = excluded.pull_requests,
    issues = excluded.issues,
    issue_comments = excluded.issue_comments,
    pushes = excluded.pushes,
    releases = excluded.releases,
    actor_ids = excluded.actor_ids;

  select event_retention_hours into strict configured_retention_hours
  from radar.collector_settings
  where id;

  delete from radar.repository_event_buckets
  where bucket_at < p_bucket_at - make_interval(hours => configured_retention_hours);
end;
$$;

create or replace function api.event_signal_context()
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  latest_captured_at timestamptz;
  configured_candidate_limit integer;
  window_coverage jsonb;
  response jsonb;
begin
  select max(bucket_at) + interval '1 hour'
  into latest_captured_at
  from radar.repository_event_buckets;
  if latest_captured_at is null then
    return jsonb_build_object(
      'captured_at', null,
      'coverage', jsonb_build_object('h1', false, 'h6', false, 'h24', false, 'h72', false),
      'repositories', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'h1', count(distinct bucket_at) filter (
      where bucket_at >= latest_captured_at - interval '1 hour'
    ) = 1,
    'h6', count(distinct bucket_at) filter (
      where bucket_at >= latest_captured_at - interval '6 hours'
    ) = 6,
    'h24', count(distinct bucket_at) filter (
      where bucket_at >= latest_captured_at - interval '24 hours'
    ) = 24,
    'h72', count(distinct bucket_at) = 72
  ) into window_coverage
  from radar.repository_event_buckets
  where bucket_at >= latest_captured_at - interval '72 hours'
    and bucket_at < latest_captured_at;

  select event_candidate_limit into strict configured_candidate_limit
  from radar.collector_settings
  where id;

  with recent as (
    select *
    from radar.repository_event_buckets
    where bucket_at >= latest_captured_at - interval '72 hours'
      and bucket_at < latest_captured_at
  ), candidate_counts as (
    select
      full_name_key,
      (array_agg(full_name order by bucket_at desc))[1] as full_name,
      sum(watches + forks + pull_requests + issues + issue_comments + pushes + releases) as event_count
    from recent
    where bucket_at >= latest_captured_at - interval '24 hours'
    group by full_name_key
  ), candidate_actors as (
    select full_name_key, count(distinct actor_id) as actor_count
    from recent
    cross join lateral unnest(actor_ids) actor_id
    where bucket_at >= latest_captured_at - interval '24 hours'
    group by full_name_key
  ), candidates as (
    select candidate_counts.full_name_key, candidate_counts.full_name
    from candidate_counts
    join candidate_actors using (full_name_key)
    order by
      candidate_actors.actor_count desc,
      candidate_counts.event_count desc,
      candidate_counts.full_name_key
    limit configured_candidate_limit
  )
  select jsonb_build_object(
    'captured_at', latest_captured_at,
    'coverage', window_coverage,
    'repositories', coalesce(jsonb_agg(
      jsonb_build_object(
        'full_name', candidates.full_name,
        'windows', jsonb_build_object(
          'h1', radar.repository_event_window(candidates.full_name_key, latest_captured_at, 1),
          'h6', radar.repository_event_window(candidates.full_name_key, latest_captured_at, 6),
          'h24', radar.repository_event_window(candidates.full_name_key, latest_captured_at, 24),
          'h72', radar.repository_event_window(candidates.full_name_key, latest_captured_at, 72)
        )
      ) order by candidates.full_name_key
    ), '[]'::jsonb)
  ) into response
  from candidates;

  return response;
end;
$$;

revoke execute on function radar.repository_event_window(text, timestamptz, integer) from public;
grant execute on function radar.repository_event_window(text, timestamptz, integer) to collector;
revoke execute on function api.ingest_event_bucket(timestamptz, jsonb) from public;
revoke execute on function api.event_signal_context() from public;
grant execute on function api.ingest_event_bucket(timestamptz, jsonb) to collector;
grant execute on function api.event_signal_context() to collector;

notify pgrst, 'reload schema';
