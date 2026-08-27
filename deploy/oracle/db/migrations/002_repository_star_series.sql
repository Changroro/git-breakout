create or replace function api.repository_star_series(
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

revoke execute on function api.repository_star_series(uuid, text[]) from public;
grant execute on function api.repository_star_series(uuid, text[]) to web_anon, collector;

notify pgrst, 'reload schema';
