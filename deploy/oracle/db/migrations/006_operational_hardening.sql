create or replace function api.collection_schedule()
returns jsonb
language sql
stable
set search_path = pg_catalog, radar
as $$
  select jsonb_build_object(
    'next_due_at', coalesce(
      max(runs.started_at) + make_interval(mins => settings.interval_minutes),
      now()
    )
  )
  from radar.collector_settings settings
  left join radar.collector_runs runs on runs.status = 'completed'
  where settings.id
  group by settings.interval_minutes;
$$;

revoke execute on function api.collection_schedule() from public;
grant execute on function api.collection_schedule() to collector;

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
    select payload_json, position
    from ranked
    where position between
      (normalized_page - 1) * p_page_size + 1
      and normalized_page * p_page_size
  )
  select coalesce(jsonb_agg(payload_json order by position), '[]'::jsonb)
  into repositories
  from selected;

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
    'languages', languages,
    'topics', topics,
    'repositories', repositories
  );
end;
$$;

create or replace function api.search_snapshot_repositories(
  p_snapshot_id uuid,
  p_query text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  result jsonb;
begin
  if not exists (select 1 from radar.snapshots where id = p_snapshot_id) then
    raise exception 'Snapshot % does not exist', p_snapshot_id;
  end if;
  if btrim(p_query) = '' or length(p_query) > 200 then
    raise exception 'Repository search query must contain 1 to 200 characters';
  end if;
  if p_limit not between 1 and 20 then
    raise exception 'Repository search limit must be between 1 and 20';
  end if;

  with searchable as (
    select
      repositories.rank,
      repositories.payload_json,
      lower(concat_ws(
        ' ',
        repositories.full_name,
        repositories.payload_json->>'description',
        repositories.payload_json->>'language',
        (
          select string_agg(topic.value, ' ')
          from jsonb_array_elements_text(repositories.payload_json->'topics') topic(value)
        )
      )) as searchable_text
    from radar.snapshot_repositories repositories
    where repositories.snapshot_id = p_snapshot_id
  ), matching as (
    select *
    from searchable
    where not exists (
      select 1
      from regexp_split_to_table(lower(btrim(p_query)), '\s+') term(value)
      where searchable.searchable_text not like '%' || term.value || '%'
    )
  ), selected as (
    select rank, payload_json
    from matching
    order by rank
    limit p_limit
  )
  select jsonb_build_object(
    'schema_version', '1.0',
    'total_count', (select count(*) from matching),
    'repositories', coalesce((select jsonb_agg(payload_json order by rank) from selected), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke execute on function api.snapshot_page(uuid, integer, integer, text, text, text) from public;
revoke execute on function api.search_snapshot_repositories(uuid, text, integer) from public;
grant execute on function api.snapshot_page(uuid, integer, integer, text, text, text) to web_anon, collector;
grant execute on function api.search_snapshot_repositories(uuid, text, integer) to web_anon, collector;

notify pgrst, 'reload schema';
