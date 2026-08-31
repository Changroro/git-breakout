begin;

create table if not exists radar.repository_discovery_milestones (
  full_name_key text primary key,
  full_name text not null check (full_name ~ '^[^/[:space:]]+/[^/[:space:]]+$'),
  first_observed_at timestamptz not null,
  first_observation_sources text[],
  first_official_daily_at timestamptz,
  first_official_daily_rank integer,
  first_official_weekly_at timestamptz,
  first_official_weekly_rank integer,
  first_official_monthly_at timestamptz,
  first_official_monthly_rank integer,
  coverage_gap boolean not null default false,
  check (
    first_observation_sources is null
    or cardinality(first_observation_sources) > 0
      and first_observation_sources <@ array[
        'official_daily',
        'official_weekly',
        'official_monthly',
        'github_search_created',
        'github_search_pushed',
        'gh_archive',
        'retained'
      ]::text[]
  ),
  constraint repository_discovery_daily_pair check (
    (first_official_daily_at is null and first_official_daily_rank is null)
    or first_official_daily_at is not null
      and first_official_daily_rank is not null
      and first_official_daily_at >= first_observed_at
      and first_official_daily_rank > 0
  ),
  constraint repository_discovery_weekly_pair check (
    (first_official_weekly_at is null and first_official_weekly_rank is null)
    or first_official_weekly_at is not null
      and first_official_weekly_rank is not null
      and first_official_weekly_at >= first_observed_at
      and first_official_weekly_rank > 0
  ),
  constraint repository_discovery_monthly_pair check (
    (first_official_monthly_at is null and first_official_monthly_rank is null)
    or first_official_monthly_at is not null
      and first_official_monthly_rank is not null
      and first_official_monthly_at >= first_observed_at
      and first_official_monthly_rank > 0
  )
);

create index if not exists repository_discovery_daily_idx
  on radar.repository_discovery_milestones (first_official_daily_at desc)
  where first_official_daily_at is not null;
create index if not exists repository_discovery_first_observed_idx
  on radar.repository_discovery_milestones (first_observed_at);

alter table radar.repository_discovery_milestones enable row level security;
alter table radar.repository_discovery_milestones force row level security;

drop policy if exists repository_discovery_collector_access
  on radar.repository_discovery_milestones;
create policy repository_discovery_collector_access
  on radar.repository_discovery_milestones
  for all to collector using (true) with check (true);
drop policy if exists repository_discovery_public_read
  on radar.repository_discovery_milestones;
create policy repository_discovery_public_read
  on radar.repository_discovery_milestones
  for select to web_anon using (true);

grant select, insert, update on radar.repository_discovery_milestones to collector;
grant select on radar.repository_discovery_milestones to web_anon;

update radar.snapshot_repositories
set payload_json = jsonb_set(payload_json, '{observation_sources}', 'null'::jsonb, true)
where not payload_json ? 'observation_sources';

do $$
begin
  if exists (
    select 1
    from radar.snapshot_repositories repositories
    where jsonb_typeof(repositories.payload_json->'observation_sources') not in ('array', 'null')
      or case
        when jsonb_typeof(repositories.payload_json->'observation_sources') = 'array' then (
          jsonb_array_length(repositories.payload_json->'observation_sources') = 0
          or exists (
            select 1
            from jsonb_array_elements(repositories.payload_json->'observation_sources') source(value)
            where jsonb_typeof(source.value) <> 'string'
              or source.value #>> '{}' not in (
                'official_daily',
                'official_weekly',
                'official_monthly',
                'github_search_created',
                'github_search_pushed',
                'gh_archive',
                'retained'
              )
          )
          or jsonb_array_length(repositories.payload_json->'observation_sources') <> (
            select count(distinct source.value)
            from jsonb_array_elements_text(
              repositories.payload_json->'observation_sources'
            ) source(value)
          )
        )
        else false
      end
  ) then
    raise exception 'Stored repository observation_sources are invalid';
  end if;
end;
$$;

with first_rows as (
  select distinct on (repositories.full_name_key)
    repositories.full_name_key,
    repositories.full_name,
    repositories.captured_at,
    repositories.payload_json
  from radar.snapshot_repositories repositories
  order by repositories.full_name_key, repositories.captured_at
), first_daily as (
  select distinct on (repositories.full_name_key)
    repositories.full_name_key,
    repositories.captured_at,
    (repositories.payload_json #>> '{official_ranks,daily}')::integer as rank
  from radar.snapshot_repositories repositories
  where repositories.payload_json #>> '{official_ranks,daily}' is not null
  order by repositories.full_name_key, repositories.captured_at
), first_weekly as (
  select distinct on (repositories.full_name_key)
    repositories.full_name_key,
    repositories.captured_at,
    (repositories.payload_json #>> '{official_ranks,weekly}')::integer as rank
  from radar.snapshot_repositories repositories
  where repositories.payload_json #>> '{official_ranks,weekly}' is not null
  order by repositories.full_name_key, repositories.captured_at
), first_monthly as (
  select distinct on (repositories.full_name_key)
    repositories.full_name_key,
    repositories.captured_at,
    (repositories.payload_json #>> '{official_ranks,monthly}')::integer as rank
  from radar.snapshot_repositories repositories
  where repositories.payload_json #>> '{official_ranks,monthly}' is not null
  order by repositories.full_name_key, repositories.captured_at
)
insert into radar.repository_discovery_milestones (
  full_name_key,
  full_name,
  first_observed_at,
  first_observation_sources,
  first_official_daily_at,
  first_official_daily_rank,
  first_official_weekly_at,
  first_official_weekly_rank,
  first_official_monthly_at,
  first_official_monthly_rank
)
select
  first_rows.full_name_key,
  first_rows.full_name,
  first_rows.captured_at,
  case
    when jsonb_typeof(first_rows.payload_json->'observation_sources') = 'array' then array(
      select jsonb_array_elements_text(first_rows.payload_json->'observation_sources')
    )
    else null
  end,
  first_daily.captured_at,
  first_daily.rank,
  first_weekly.captured_at,
  first_weekly.rank,
  first_monthly.captured_at,
  first_monthly.rank
from first_rows
left join first_daily using (full_name_key)
left join first_weekly using (full_name_key)
left join first_monthly using (full_name_key)
on conflict (full_name_key) do nothing;

with settings as (
  select interval_minutes
  from radar.collector_settings
  where id
), latest_snapshot as (
  select max(captured_at) as captured_at
  from radar.snapshots
), snapshot_intervals as (
  select
    snapshots.captured_at,
    lag(snapshots.captured_at) over (order by snapshots.captured_at) as previous_captured_at
  from radar.snapshots snapshots
)
update radar.repository_discovery_milestones milestones
set coverage_gap = exists (
  select 1
  from snapshot_intervals intervals
  where intervals.previous_captured_at >= milestones.first_observed_at
    and intervals.previous_captured_at < case
      when milestones.first_official_daily_at is not null
        then milestones.first_official_daily_at
      else least(
        latest_snapshot.captured_at,
        milestones.first_observed_at + interval '14 days'
      )
    end
    and intervals.captured_at - intervals.previous_captured_at
      > make_interval(mins => settings.interval_minutes * 3 / 2)
)
from settings, latest_snapshot
where milestones.first_observation_sources is not null;

create or replace function api.complete_collection(
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
  previous_captured_at timestamptz;
  configured_interval_minutes integer;
begin
  if jsonb_typeof(p_repositories) is distinct from 'array' then
    raise exception 'Repositories must be a JSON array';
  end if;
  repository_count := jsonb_array_length(p_repositories);
  if repository_count = 0 then
    raise exception 'Collection must contain repositories';
  end if;
  if p_source is null or btrim(p_source) = '' then
    raise exception 'Collection source is required';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_repositories) repository(value)
    where jsonb_typeof(repository.value->'observation_sources') is distinct from 'array'
      or case
        when jsonb_typeof(repository.value->'observation_sources') = 'array' then (
          jsonb_array_length(repository.value->'observation_sources') = 0
          or exists (
            select 1
            from jsonb_array_elements(repository.value->'observation_sources') source(value)
            where jsonb_typeof(source.value) <> 'string'
              or source.value #>> '{}' not in (
                'official_daily',
                'official_weekly',
                'official_monthly',
                'github_search_created',
                'github_search_pushed',
                'gh_archive',
                'retained'
              )
          )
          or jsonb_array_length(repository.value->'observation_sources') <> (
            select count(distinct source.value)
            from jsonb_array_elements_text(
              repository.value->'observation_sources'
            ) source(value)
          )
          or ((repository.value #>> '{official_ranks,daily}') is null)
            = (repository.value->'observation_sources' ? 'official_daily')
          or ((repository.value #>> '{official_ranks,weekly}') is null)
            = (repository.value->'observation_sources' ? 'official_weekly')
          or ((repository.value #>> '{official_ranks,monthly}') is null)
            = (repository.value->'observation_sources' ? 'official_monthly')
        )
        else false
      end
  ) then
    raise exception 'Repositories contain invalid observation_sources';
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

  select max(captured_at) into previous_captured_at from radar.snapshots;
  select interval_minutes into strict configured_interval_minutes
  from radar.collector_settings
  where id;

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

  insert into radar.repository_discovery_milestones (
    full_name_key,
    full_name,
    first_observed_at,
    first_observation_sources,
    first_official_daily_at,
    first_official_daily_rank,
    first_official_weekly_at,
    first_official_weekly_rank,
    first_official_monthly_at,
    first_official_monthly_rank
  )
  select
    lower(repository->>'full_name'),
    repository->>'full_name',
    p_captured_at,
    array(select jsonb_array_elements_text(repository->'observation_sources')),
    case when repository #>> '{official_ranks,daily}' is null then null else p_captured_at end,
    (repository #>> '{official_ranks,daily}')::integer,
    case when repository #>> '{official_ranks,weekly}' is null then null else p_captured_at end,
    (repository #>> '{official_ranks,weekly}')::integer,
    case when repository #>> '{official_ranks,monthly}' is null then null else p_captured_at end,
    (repository #>> '{official_ranks,monthly}')::integer
  from jsonb_array_elements(p_repositories) repository
  on conflict (full_name_key) do update
  set
    full_name = excluded.full_name,
    first_observation_sources = case
      when excluded.first_observed_at < repository_discovery_milestones.first_observed_at
        then excluded.first_observation_sources
      else repository_discovery_milestones.first_observation_sources
    end,
    first_observed_at = least(
      repository_discovery_milestones.first_observed_at,
      excluded.first_observed_at
    ),
    first_official_daily_rank = case
      when repository_discovery_milestones.first_official_daily_at is null
        or excluded.first_official_daily_at < repository_discovery_milestones.first_official_daily_at
        then excluded.first_official_daily_rank
      else repository_discovery_milestones.first_official_daily_rank
    end,
    first_official_daily_at = case
      when repository_discovery_milestones.first_official_daily_at is null
        or excluded.first_official_daily_at < repository_discovery_milestones.first_official_daily_at
        then excluded.first_official_daily_at
      else repository_discovery_milestones.first_official_daily_at
    end,
    first_official_weekly_rank = case
      when repository_discovery_milestones.first_official_weekly_at is null
        or excluded.first_official_weekly_at < repository_discovery_milestones.first_official_weekly_at
        then excluded.first_official_weekly_rank
      else repository_discovery_milestones.first_official_weekly_rank
    end,
    first_official_weekly_at = case
      when repository_discovery_milestones.first_official_weekly_at is null
        or excluded.first_official_weekly_at < repository_discovery_milestones.first_official_weekly_at
        then excluded.first_official_weekly_at
      else repository_discovery_milestones.first_official_weekly_at
    end,
    first_official_monthly_rank = case
      when repository_discovery_milestones.first_official_monthly_at is null
        or excluded.first_official_monthly_at < repository_discovery_milestones.first_official_monthly_at
        then excluded.first_official_monthly_rank
      else repository_discovery_milestones.first_official_monthly_rank
    end,
    first_official_monthly_at = case
      when repository_discovery_milestones.first_official_monthly_at is null
        or excluded.first_official_monthly_at < repository_discovery_milestones.first_official_monthly_at
        then excluded.first_official_monthly_at
      else repository_discovery_milestones.first_official_monthly_at
    end;

  if previous_captured_at is not null
    and p_captured_at - previous_captured_at
      > make_interval(mins => configured_interval_minutes * 3 / 2)
  then
    update radar.repository_discovery_milestones
    set coverage_gap = true
    where first_observation_sources is not null
      and first_observed_at <= previous_captured_at
      and (
        first_official_daily_at >= p_captured_at
        or first_official_daily_at is null
          and first_observed_at + interval '14 days' > previous_captured_at
      );
  end if;

  update radar.collector_runs
  set finished_at = p_captured_at,
      status = 'completed',
      error_message = null
  where id = p_run_id and status = 'running';

  delete from radar.collector_lease where run_id = p_run_id;
end;
$$;

create or replace function api.discovery_track_record()
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  latest_captured_at timestamptz;
  result jsonb;
begin
  select max(captured_at) into latest_captured_at from radar.snapshots;
  if latest_captured_at is null then
    raise exception 'Discovery track record requires at least one snapshot';
  end if;

  with classified as (
    select
      milestones.*,
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
    from radar.repository_discovery_milestones milestones
  ), conversions as (
    select
      count(*) filter (
        where eligible and not coverage_gap
          and latest_captured_at >= first_observed_at + interval '7 days'
      )::integer as eligible_7d,
      count(*) filter (
        where eligible and not coverage_gap
          and latest_captured_at >= first_observed_at + interval '7 days'
          and first_official_daily_at <= first_observed_at + interval '7 days'
      )::integer as converted_7d,
      count(*) filter (
        where eligible and not coverage_gap
          and latest_captured_at >= first_observed_at + interval '14 days'
      )::integer as eligible_14d,
      count(*) filter (
        where eligible and not coverage_gap
          and latest_captured_at >= first_observed_at + interval '14 days'
          and first_official_daily_at <= first_observed_at + interval '14 days'
      )::integer as converted_14d
    from classified
  ), recent_hits as (
    select *
    from classified
    where eligible and not coverage_gap and first_official_daily_at > first_observed_at
    order by first_official_daily_at desc, full_name_key
    limit 5
  ), summary as (
    select
      min(first_observed_at) filter (where eligible) as evidence_started_at,
      count(*) filter (
        where eligible and not coverage_gap and first_official_daily_at > first_observed_at
      )::integer as verified_count,
      percentile_cont(0.5) within group (
        order by extract(epoch from (first_official_daily_at - first_observed_at)) / 3600
      ) filter (
        where eligible and not coverage_gap and first_official_daily_at > first_observed_at
      ) as median_lead_hours,
      count(*) filter (
        where eligible and not coverage_gap and first_official_daily_at > first_observed_at
      )::integer as daily_hits,
      count(*) filter (
        where eligible and not coverage_gap and first_official_weekly_at > first_observed_at
      )::integer as weekly_hits,
      count(*) filter (
        where eligible and not coverage_gap and first_official_monthly_at > first_observed_at
      )::integer as monthly_hits
    from classified
  )
  select jsonb_build_object(
    'schema_version', '1.0',
    'evidence_started_at', summary.evidence_started_at,
    'generated_at', latest_captured_at,
    'verified_count', summary.verified_count,
    'median_lead_hours', summary.median_lead_hours,
    'conversion_7d', jsonb_build_object(
      'converted', conversions.converted_7d,
      'eligible', conversions.eligible_7d,
      'rate', case when conversions.eligible_7d = 0 then null
        else conversions.converted_7d::numeric / conversions.eligible_7d end
    ),
    'conversion_14d', jsonb_build_object(
      'converted', conversions.converted_14d,
      'eligible', conversions.eligible_14d,
      'rate', case when conversions.eligible_14d = 0 then null
        else conversions.converted_14d::numeric / conversions.eligible_14d end
    ),
    'period_hits', jsonb_build_object(
      'daily', summary.daily_hits,
      'weekly', summary.weekly_hits,
      'monthly', summary.monthly_hits
    ),
    'recent_hits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'full_name', recent_hits.full_name,
        'first_observed_at', recent_hits.first_observed_at,
        'first_trending_at', recent_hits.first_official_daily_at,
        'first_trending_rank', recent_hits.first_official_daily_rank,
        'lead_hours', extract(epoch from (
          recent_hits.first_official_daily_at - recent_hits.first_observed_at
        )) / 3600,
        'sources', to_jsonb(recent_hits.first_observation_sources),
        'coverage', 'complete'
      ) order by recent_hits.first_official_daily_at desc, recent_hits.full_name_key)
      from recent_hits
    ), '[]'::jsonb)
  ) into result
  from summary
  cross join conversions;

  return result;
end;
$$;

create or replace function api.snapshot_page(
  p_snapshot_id uuid,
  p_page integer,
  p_page_size integer,
  p_language text,
  p_topic text,
  p_view text
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  snapshot_record radar.snapshots%rowtype;
  normalized_language text;
  normalized_topic text;
  matching_count integer;
  normalized_page integer;
  expected_page_count integer;
  repositories jsonb;
  languages jsonb;
  topics jsonb;
  intelligence_available boolean;
begin
  if p_page < 1 then
    raise exception 'Snapshot page must be positive';
  end if;
  if p_page_size not between 1 and 100 then
    raise exception 'Snapshot page size must be between 1 and 100';
  end if;
  if p_view not in ('momentum', 'breakout', 'current') then
    raise exception 'Unknown ranking view %', p_view;
  end if;
  if p_language is not null and btrim(p_language) = '' then
    raise exception 'Snapshot language filter cannot be empty';
  end if;
  if p_topic is not null and btrim(p_topic) = '' then
    raise exception 'Snapshot topic filter cannot be empty';
  end if;

  select * into snapshot_record
  from radar.snapshots
  where id = p_snapshot_id;
  if not found then
    raise exception 'Snapshot % does not exist', p_snapshot_id;
  end if;

  normalized_language := lower(btrim(p_language));
  normalized_topic := lower(btrim(p_topic));

  with candidates as (
    select repositories.*
    from radar.snapshot_repositories repositories
    where repositories.snapshot_id = p_snapshot_id
      and (
        normalized_language is null
        or lower(btrim(repositories.payload_json->>'language')) = normalized_language
      )
      and (
        normalized_topic is null
        or exists (
          select 1
          from jsonb_array_elements_text(repositories.payload_json->'topics') topic(value)
          where lower(btrim(topic.value)) = normalized_topic
        )
      )
      and (
        p_view = 'momentum'
        or p_view = 'breakout'
          and repositories.payload_json #> '{trend_intelligence,breakout,score}' <> 'null'::jsonb
        or p_view = 'current'
          and repositories.payload_json #> '{trend_intelligence,current_heat,score}' <> 'null'::jsonb
      )
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
    select repositories.*
    from radar.snapshot_repositories repositories
    where repositories.snapshot_id = p_snapshot_id
      and (
        normalized_language is null
        or lower(btrim(repositories.payload_json->>'language')) = normalized_language
      )
      and (
        normalized_topic is null
        or exists (
          select 1
          from jsonb_array_elements_text(repositories.payload_json->'topics') topic(value)
          where lower(btrim(topic.value)) = normalized_topic
        )
      )
      and (
        p_view = 'momentum'
        or p_view = 'breakout'
          and repositories.payload_json #> '{trend_intelligence,breakout,score}' <> 'null'::jsonb
        or p_view = 'current'
          and repositories.payload_json #> '{trend_intelligence,current_heat,score}' <> 'null'::jsonb
      )
  ), ranked as (
    select
      payload_json,
      full_name_key,
      row_number() over (order by
        case when p_view = 'momentum' then rank end,
        case when p_view = 'breakout'
          then (payload_json #>> '{trend_intelligence,breakout,score}')::numeric end desc,
        case when p_view = 'current'
          then (payload_json #>> '{trend_intelligence,current_heat,score}')::numeric end desc,
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'value', facet.value,
    'label', facet.label,
    'count', facet.repository_count
  ) order by facet.repository_count desc, facet.label), '[]'::jsonb)
  into languages
  from (
    select
      lower(btrim(payload_json->>'language')) as value,
      min(btrim(payload_json->>'language')) as label,
      count(*)::integer as repository_count
    from radar.snapshot_repositories
    where snapshot_id = p_snapshot_id
      and nullif(btrim(payload_json->>'language'), '') is not null
    group by lower(btrim(payload_json->>'language'))
  ) facet;

  with topic_facets as (
    select
      lower(btrim(topic.value)) as value,
      min(btrim(topic.value)) as label,
      count(distinct repositories.full_name_key)::integer as repository_count
    from radar.snapshot_repositories repositories
    cross join lateral jsonb_array_elements_text(repositories.payload_json->'topics') topic(value)
    where repositories.snapshot_id = p_snapshot_id
      and btrim(topic.value) <> ''
    group by lower(btrim(topic.value))
  ), ranked_topic_facets as (
    select
      topic_facets.*,
      row_number() over (order by repository_count desc, label) as position
    from topic_facets
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'value', facet.value,
    'label', facet.label,
    'count', facet.repository_count
  ) order by facet.repository_count desc, facet.label), '[]'::jsonb)
  into topics
  from ranked_topic_facets facet
  where facet.position <= 500 or facet.value = normalized_topic;

  select exists (
    select 1
    from radar.snapshot_repositories
    where snapshot_id = p_snapshot_id
      and payload_json ? 'trend_intelligence'
  ) into intelligence_available;

  return jsonb_build_object(
    'schema_version', '1.0',
    'id', snapshot_record.id,
    'captured_at', snapshot_record.captured_at,
    'source', snapshot_record.source,
    'repository_count', snapshot_record.repository_count,
    'matching_count', matching_count,
    'page', normalized_page,
    'page_size', p_page_size,
    'intelligence_available', intelligence_available,
    'track_record', api.discovery_track_record(),
    'languages', languages,
    'topics', topics,
    'repositories', repositories
  );
end;
$$;

revoke execute on function api.discovery_track_record() from public;
grant execute on function api.discovery_track_record() to web_anon, collector;
revoke execute on function api.complete_collection(uuid, timestamptz, text, jsonb) from public;
grant execute on function api.complete_collection(uuid, timestamptz, text, jsonb) to collector;
revoke execute on function api.snapshot_page(uuid, integer, integer, text, text, text) from public;
grant execute on function api.snapshot_page(uuid, integer, integer, text, text, text)
  to web_anon, collector;

notify pgrst, 'reload schema';

commit;
