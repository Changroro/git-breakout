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

  with recent as materialized (
    select *
    from radar.repository_event_buckets
    where bucket_at >= latest_captured_at - interval '72 hours'
      and bucket_at < latest_captured_at
  ), candidate_counts as materialized (
    select
      full_name_key,
      (array_agg(full_name order by bucket_at desc))[1] as full_name,
      sum(watches + forks + pull_requests + issues + issue_comments + pushes + releases) as event_count
    from recent
    where bucket_at >= latest_captured_at - interval '24 hours'
    group by full_name_key
  ), candidate_actors as materialized (
    select full_name_key, count(distinct actor_id) as actor_count
    from recent
    cross join lateral unnest(actor_ids) actor_id
    where bucket_at >= latest_captured_at - interval '24 hours'
    group by full_name_key
  ), candidates as materialized (
    select candidate_counts.full_name_key, candidate_counts.full_name
    from candidate_counts
    join candidate_actors using (full_name_key)
    order by
      candidate_actors.actor_count desc,
      candidate_counts.event_count desc,
      candidate_counts.full_name_key
    limit configured_candidate_limit
  ), window_totals as materialized (
    select
      full_name_key,
      coalesce(sum(watches) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_watches,
      coalesce(sum(forks) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_forks,
      coalesce(sum(pull_requests) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_pull_requests,
      coalesce(sum(issues) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_issues,
      coalesce(sum(issue_comments) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_issue_comments,
      coalesce(sum(pushes) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_pushes,
      coalesce(sum(releases) filter (where bucket_at >= latest_captured_at - interval '1 hour'), 0)::integer as h1_releases,
      coalesce(sum(watches) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_watches,
      coalesce(sum(forks) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_forks,
      coalesce(sum(pull_requests) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_pull_requests,
      coalesce(sum(issues) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_issues,
      coalesce(sum(issue_comments) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_issue_comments,
      coalesce(sum(pushes) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_pushes,
      coalesce(sum(releases) filter (where bucket_at >= latest_captured_at - interval '6 hours'), 0)::integer as h6_releases,
      coalesce(sum(watches) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_watches,
      coalesce(sum(forks) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_forks,
      coalesce(sum(pull_requests) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_pull_requests,
      coalesce(sum(issues) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_issues,
      coalesce(sum(issue_comments) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_issue_comments,
      coalesce(sum(pushes) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_pushes,
      coalesce(sum(releases) filter (where bucket_at >= latest_captured_at - interval '24 hours'), 0)::integer as h24_releases,
      coalesce(sum(watches), 0)::integer as h72_watches,
      coalesce(sum(forks), 0)::integer as h72_forks,
      coalesce(sum(pull_requests), 0)::integer as h72_pull_requests,
      coalesce(sum(issues), 0)::integer as h72_issues,
      coalesce(sum(issue_comments), 0)::integer as h72_issue_comments,
      coalesce(sum(pushes), 0)::integer as h72_pushes,
      coalesce(sum(releases), 0)::integer as h72_releases
    from recent
    group by full_name_key
  ), window_actors as materialized (
    select
      full_name_key,
      count(distinct actor_id) filter (where bucket_at >= latest_captured_at - interval '1 hour')::integer as h1_unique_actors,
      count(distinct actor_id) filter (where bucket_at >= latest_captured_at - interval '6 hours')::integer as h6_unique_actors,
      count(distinct actor_id) filter (where bucket_at >= latest_captured_at - interval '24 hours')::integer as h24_unique_actors,
      count(distinct actor_id)::integer as h72_unique_actors
    from recent
    cross join lateral unnest(actor_ids) actor_id
    group by full_name_key
  ), repository_windows as (
    select
      candidates.full_name_key,
      candidates.full_name,
      jsonb_build_object(
        'h1', jsonb_build_object(
          'watches', window_totals.h1_watches,
          'forks', window_totals.h1_forks,
          'pull_requests', window_totals.h1_pull_requests,
          'issues', window_totals.h1_issues,
          'issue_comments', window_totals.h1_issue_comments,
          'pushes', window_totals.h1_pushes,
          'releases', window_totals.h1_releases,
          'unique_actors', window_actors.h1_unique_actors
        ),
        'h6', jsonb_build_object(
          'watches', window_totals.h6_watches,
          'forks', window_totals.h6_forks,
          'pull_requests', window_totals.h6_pull_requests,
          'issues', window_totals.h6_issues,
          'issue_comments', window_totals.h6_issue_comments,
          'pushes', window_totals.h6_pushes,
          'releases', window_totals.h6_releases,
          'unique_actors', window_actors.h6_unique_actors
        ),
        'h24', jsonb_build_object(
          'watches', window_totals.h24_watches,
          'forks', window_totals.h24_forks,
          'pull_requests', window_totals.h24_pull_requests,
          'issues', window_totals.h24_issues,
          'issue_comments', window_totals.h24_issue_comments,
          'pushes', window_totals.h24_pushes,
          'releases', window_totals.h24_releases,
          'unique_actors', window_actors.h24_unique_actors
        ),
        'h72', jsonb_build_object(
          'watches', window_totals.h72_watches,
          'forks', window_totals.h72_forks,
          'pull_requests', window_totals.h72_pull_requests,
          'issues', window_totals.h72_issues,
          'issue_comments', window_totals.h72_issue_comments,
          'pushes', window_totals.h72_pushes,
          'releases', window_totals.h72_releases,
          'unique_actors', window_actors.h72_unique_actors
        )
      ) as windows
    from candidates
    join window_totals using (full_name_key)
    join window_actors using (full_name_key)
  )
  select jsonb_build_object(
    'captured_at', latest_captured_at,
    'coverage', window_coverage,
    'repositories', coalesce(jsonb_agg(
      jsonb_build_object(
        'full_name', repository_windows.full_name,
        'windows', repository_windows.windows
      ) order by repository_windows.full_name_key
    ), '[]'::jsonb)
  ) into response
  from repository_windows;

  return response;
end;
$$;

revoke execute on function api.event_signal_context() from public;
grant execute on function api.event_signal_context() to collector;

notify pgrst, 'reload schema';
