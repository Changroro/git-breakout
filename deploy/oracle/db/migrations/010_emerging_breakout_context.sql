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
  ), observation_history as (
    select
      full_name_key,
      full_name,
      captured_at,
      stars,
      rank,
      payload_json,
      payload_json #>> '{official_ranks,daily}' is not null
        or payload_json #>> '{official_ranks,weekly}' is not null
        or payload_json #>> '{official_ranks,monthly}' is not null
        as is_official_trending
    from radar.snapshot_repositories
  ), ranked_observations as (
    select
      observation_history.*,
      min(captured_at) over (partition by full_name_key) as first_seen_at,
      row_number() over (
        partition by full_name_key
        order by captured_at desc
      ) as observation_number
    from observation_history
  ), first_observations as (
    select distinct on (full_name_key)
      full_name_key,
      stars as first_observed_stars,
      is_official_trending as first_observation_was_trending
    from observation_history
    order by full_name_key, captured_at, full_name
  ), trending_transitions as (
    select
      full_name_key,
      is_official_trending,
      lag(is_official_trending, 1, false) over (
        partition by full_name_key
        order by captured_at
      ) as was_official_trending
    from observation_history
  ), trending_episodes as (
    select
      full_name_key,
      count(*) filter (
        where is_official_trending and not was_official_trending
      )::integer as official_trending_episode_count
    from trending_transitions
    group by full_name_key
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
      first_observations.first_observed_stars,
      first_observations.first_observation_was_trending,
      trending_episodes.official_trending_episode_count,
      comparison.captured_at as growth_comparison_captured_at,
      comparison.stars as growth_comparison_stars
    from repository_context
    join first_observations using (full_name_key)
    join trending_episodes using (full_name_key)
    cross join policy
    cross join latest_snapshot
    left join lateral (
      select repositories.captured_at, repositories.stars
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
          'first_observed_stars', first_observed_stars,
          'first_observation_was_trending', first_observation_was_trending,
          'official_trending_episode_count', official_trending_episode_count,
          'latest_captured_at', latest_captured_at,
          'latest_pushed_at', latest_pushed_at,
          'latest_rank', latest_rank,
          'latest_stars', latest_stars,
          'growth_comparison_captured_at', growth_comparison_captured_at,
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
