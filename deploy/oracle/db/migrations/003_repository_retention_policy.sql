alter table radar.collector_settings
  add column if not exists retention_grace_days integer,
  add column if not exists retention_growth_days integer,
  add column if not exists retention_push_days integer,
  add column if not exists retention_repository_limit integer;

update radar.collector_settings
set
  retention_grace_days = 14,
  retention_growth_days = 7,
  retention_push_days = 30,
  retention_repository_limit = 1000,
  updated_at = now()
where id and (
  retention_grace_days is null
  or retention_growth_days is null
  or retention_push_days is null
  or retention_repository_limit is null
);

alter table radar.collector_settings
  alter column retention_grace_days set not null,
  alter column retention_growth_days set not null,
  alter column retention_push_days set not null,
  alter column retention_repository_limit set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'collector_settings_retention_grace_days_check'
      and conrelid = 'radar.collector_settings'::regclass
  ) then
    alter table radar.collector_settings
      add constraint collector_settings_retention_grace_days_check
      check (retention_grace_days > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'collector_settings_retention_growth_days_check'
      and conrelid = 'radar.collector_settings'::regclass
  ) then
    alter table radar.collector_settings
      add constraint collector_settings_retention_growth_days_check
      check (retention_growth_days > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'collector_settings_retention_push_days_check'
      and conrelid = 'radar.collector_settings'::regclass
  ) then
    alter table radar.collector_settings
      add constraint collector_settings_retention_push_days_check
      check (retention_push_days > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'collector_settings_retention_repository_limit_check'
      and conrelid = 'radar.collector_settings'::regclass
  ) then
    alter table radar.collector_settings
      add constraint collector_settings_retention_repository_limit_check
      check (retention_repository_limit > 0);
  end if;
end;
$$;

create or replace function api.collection_context()
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

revoke execute on function api.collection_context() from public;
grant execute on function api.collection_context() to collector;

notify pgrst, 'reload schema';
