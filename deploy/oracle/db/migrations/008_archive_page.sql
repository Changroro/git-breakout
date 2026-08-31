begin;

create or replace function api.archive_page(
  p_page integer,
  p_page_size integer,
  p_query text
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, radar
as $$
declare
  latest_snapshot radar.snapshots%rowtype;
  normalized_query text;
  archive_count integer;
  matching_count integer;
  normalized_page integer;
  expected_page_count integer;
  repositories jsonb;
begin
  if p_page < 1 then
    raise exception 'Archive page must be positive';
  end if;
  if p_page_size not between 1 and 100 then
    raise exception 'Archive page size must be between 1 and 100';
  end if;
  if p_query is not null and length(p_query) > 200 then
    raise exception 'Archive query must contain at most 200 characters';
  end if;

  select * into latest_snapshot
  from radar.snapshots
  order by captured_at desc
  limit 1;
  if not found then
    raise exception 'No completed ranking snapshots are available';
  end if;

  normalized_query := nullif(lower(btrim(p_query)), '');

  with last_rows as (
    select distinct on (repositories.full_name_key)
      repositories.*
    from radar.snapshot_repositories repositories
    order by repositories.full_name_key, repositories.captured_at desc
  ), archived as (
    select last_rows.*
    from last_rows
    where not exists (
      select 1
      from radar.snapshot_repositories current_rows
      where current_rows.snapshot_id = latest_snapshot.id
        and current_rows.full_name_key = last_rows.full_name_key
    )
  )
  select count(*) into archive_count from archived;

  with last_rows as (
    select distinct on (repositories.full_name_key)
      repositories.*
    from radar.snapshot_repositories repositories
    order by repositories.full_name_key, repositories.captured_at desc
  ), archived as (
    select
      last_rows.*,
      lower(concat_ws(
        ' ',
        last_rows.full_name,
        last_rows.payload_json->>'description',
        last_rows.payload_json->>'language',
        (
          select string_agg(topic.value, ' ')
          from jsonb_array_elements_text(last_rows.payload_json->'topics') topic(value)
        )
      )) as searchable_text
    from last_rows
    where not exists (
      select 1
      from radar.snapshot_repositories current_rows
      where current_rows.snapshot_id = latest_snapshot.id
        and current_rows.full_name_key = last_rows.full_name_key
    )
  ), matching as (
    select archived.*
    from archived
    where normalized_query is null or not exists (
      select 1
      from regexp_split_to_table(normalized_query, '\s+') term(value)
      where archived.searchable_text not like '%' || term.value || '%'
    )
  )
  select count(*) into matching_count from matching;

  normalized_page := least(
    p_page,
    greatest(1, ceil(matching_count::numeric / p_page_size)::integer)
  );
  expected_page_count := least(
    p_page_size,
    greatest(0, matching_count - (normalized_page - 1) * p_page_size)
  );

  with last_rows as (
    select distinct on (repositories.full_name_key)
      repositories.*
    from radar.snapshot_repositories repositories
    order by repositories.full_name_key, repositories.captured_at desc
  ), archived as (
    select
      last_rows.*,
      lower(concat_ws(
        ' ',
        last_rows.full_name,
        last_rows.payload_json->>'description',
        last_rows.payload_json->>'language',
        (
          select string_agg(topic.value, ' ')
          from jsonb_array_elements_text(last_rows.payload_json->'topics') topic(value)
        )
      )) as searchable_text
    from last_rows
    where not exists (
      select 1
      from radar.snapshot_repositories current_rows
      where current_rows.snapshot_id = latest_snapshot.id
        and current_rows.full_name_key = last_rows.full_name_key
    )
  ), matching as (
    select archived.*
    from archived
    where normalized_query is null or not exists (
      select 1
      from regexp_split_to_table(normalized_query, '\s+') term(value)
      where archived.searchable_text not like '%' || term.value || '%'
    )
  ), ranked as (
    select
      matching.*,
      row_number() over (
        order by matching.captured_at desc, matching.full_name_key
      ) as position
    from matching
  ), selected as (
    select *
    from ranked
    where position between
      (normalized_page - 1) * p_page_size + 1
      and normalized_page * p_page_size
  )
  select coalesce(jsonb_agg(
    selected.payload_json || jsonb_build_object(
      'rank', selected.rank,
      'last_snapshot_id', selected.snapshot_id,
      'last_observed_at', selected.captured_at
    ) order by selected.position
  ), '[]'::jsonb)
  into repositories
  from selected;

  if jsonb_array_length(repositories) <> expected_page_count then
    raise exception 'Archive page contains an unexpected repository count';
  end if;

  return jsonb_build_object(
    'schema_version', '1.0',
    'latest_snapshot_id', latest_snapshot.id,
    'latest_captured_at', latest_snapshot.captured_at,
    'archive_count', archive_count,
    'matching_count', matching_count,
    'page', normalized_page,
    'page_size', p_page_size,
    'repositories', repositories
  );
end;
$$;

revoke execute on function api.archive_page(integer, integer, text) from public;
grant execute on function api.archive_page(integer, integer, text) to web_anon, collector;

notify pgrst, 'reload schema';

commit;
