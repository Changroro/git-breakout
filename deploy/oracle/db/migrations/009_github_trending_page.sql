create or replace function api.snapshot_page(
  p_snapshot_id uuid,
  p_page integer,
  p_page_size integer,
  p_language text,
  p_topic text,
  p_view text,
  p_period text
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  normalized_language text;
  normalized_topic text;
  matching_count integer;
  normalized_page integer;
  expected_page_count integer;
  repositories jsonb;
  base_result jsonb;
begin
  if p_view not in ('momentum', 'breakout', 'current', 'github') then
    raise exception 'Unknown ranking view %', p_view;
  end if;
  if p_view <> 'github' then
    if p_period is not null then
      raise exception 'GitHub Trending period is only valid for the GitHub view';
    end if;
    return api.snapshot_page(
      p_snapshot_id,
      p_page,
      p_page_size,
      p_language,
      p_topic,
      p_view
    );
  end if;
  if p_period is null or p_period not in ('daily', 'weekly', 'monthly') then
    raise exception 'Unknown GitHub Trending period %', p_period;
  end if;
  if p_page < 1 then
    raise exception 'Snapshot page must be positive';
  end if;
  if p_page_size not between 1 and 100 then
    raise exception 'Snapshot page size must be between 1 and 100';
  end if;

  base_result := api.snapshot_page(
    p_snapshot_id,
    1,
    1,
    p_language,
    p_topic,
    'momentum'
  );
  normalized_language := lower(btrim(p_language));
  normalized_topic := lower(btrim(p_topic));

  with candidates as (
    select snapshot_repositories.*
    from radar.snapshot_repositories
    where snapshot_repositories.snapshot_id = p_snapshot_id
      and (
        normalized_language is null
        or lower(btrim(snapshot_repositories.payload_json->>'language')) = normalized_language
      )
      and (
        normalized_topic is null
        or exists (
          select 1
          from jsonb_array_elements_text(snapshot_repositories.payload_json->'topics') topic(value)
          where lower(btrim(topic.value)) = normalized_topic
        )
      )
      and (snapshot_repositories.payload_json #>> array['official_ranks', p_period]) is not null
  )
  select count(*) into matching_count from candidates;

  normalized_page := least(
    p_page,
    greatest(1, ceil(matching_count::numeric / p_page_size)::integer)
  );
  expected_page_count := least(
    p_page_size,
    greatest(0, matching_count - (normalized_page - 1) * p_page_size)
  );

  with candidates as (
    select snapshot_repositories.*
    from radar.snapshot_repositories
    where snapshot_repositories.snapshot_id = p_snapshot_id
      and (
        normalized_language is null
        or lower(btrim(snapshot_repositories.payload_json->>'language')) = normalized_language
      )
      and (
        normalized_topic is null
        or exists (
          select 1
          from jsonb_array_elements_text(snapshot_repositories.payload_json->'topics') topic(value)
          where lower(btrim(topic.value)) = normalized_topic
        )
      )
      and (snapshot_repositories.payload_json #>> array['official_ranks', p_period]) is not null
  ), ranked as (
    select
      payload_json,
      full_name_key,
      row_number() over (order by
        case when p_view = 'github'
          then (payload_json #>> array['official_ranks', p_period])::integer end,
        full_name_key
      ) as position
    from candidates
  ), selected as (
    select ranked.payload_json, ranked.position, milestones.*,
      milestones.first_observation_sources is not null
        and milestones.first_observation_sources && array[
          'github_search_created',
          'github_search_pushed',
          'gh_archive'
        ]::text[]
        and not milestones.first_observation_sources && array[
          'official_daily',
          'official_weekly',
          'official_monthly'
        ]::text[] as eligible
    from ranked
    join radar.repository_discovery_milestones milestones using (full_name_key)
    where ranked.position between
      (normalized_page - 1) * p_page_size + 1
      and normalized_page * p_page_size
  )
  select coalesce(jsonb_agg(
    payload_json || jsonb_build_object(
      'discovery_evidence', jsonb_build_object(
        'outcome', case
          when first_observation_sources is null then 'legacy'
          when first_official_daily_at = first_observed_at then 'already_trending'
          when not eligible then 'legacy'
          when coverage_gap then 'inconclusive'
          when first_official_daily_at > first_observed_at then 'verified'
          when (select max(captured_at) from radar.snapshots)
            < first_observed_at + interval '14 days' then 'pending'
          else 'not_converted'
        end,
        'first_observed_at', first_observed_at,
        'first_trending_daily_at', first_official_daily_at,
        'first_trending_daily_rank', first_official_daily_rank,
        'lead_hours', case
          when first_official_daily_at > first_observed_at
            then extract(epoch from (first_official_daily_at - first_observed_at)) / 3600
          when first_official_daily_at = first_observed_at then 0
          else null
        end,
        'sources', to_jsonb(first_observation_sources),
        'coverage', case
          when first_observation_sources is null then 'unknown'
          when coverage_gap then 'gap'
          else 'complete'
        end
      )
    ) order by position
  ), '[]'::jsonb)
  into repositories
  from selected;

  if jsonb_array_length(repositories) <> expected_page_count then
    raise exception 'Discovery milestones are incomplete for snapshot %', p_snapshot_id;
  end if;

  return base_result || jsonb_build_object(
    'matching_count', matching_count,
    'page', normalized_page,
    'page_size', p_page_size,
    'repositories', repositories
  );
end;
$$;

revoke execute on function api.snapshot_page(uuid, integer, integer, text, text, text, text)
from public;
grant execute on function api.snapshot_page(uuid, integer, integer, text, text, text, text)
to web_anon, collector;
