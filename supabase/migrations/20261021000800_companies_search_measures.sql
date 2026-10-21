-- companies/search-measures (feature 1, PR 7): T37 gains the find bars.
--
-- WHY
--   The find route writes two route_timings rows per search (apps/web/app/api/companies/find/route.ts): `find` for the whole
--   search, bar 30 s, and `find.directory` for its first rung, bar 300 ms. Part 1 section 1.11 asks for the directory rung's
--   p95 under 300 ms and the whole search's p95 under 30 s. T37 scores the share of calls within each bar, 95 percent, the
--   same way it scores add and follow: a share at 95 percent is the 95th percentile inside the bar.
--
-- WHAT
--   measure_t37()   the four bars: add 60 s, follow 8 s, find 30 s, find.directory 300 ms. The worst share decides.
--   The register row's words are updated to name them.

create or replace function public.measure_t37()
returns table (value numeric, passed boolean, sample_n integer, note text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  worst numeric := null;
  total integer := 0;
  parts text := '';
begin
  -- A call that failed is not within its bar. The p95 reads only the calls that answered (ok), and the failures are counted apart.
  for r in
    select b.route, b.bar_ms,
           count(t.ms) as n,
           count(t.ms) filter (where t.ok and t.ms <= b.bar_ms) as within,
           count(t.ms) filter (where not t.ok) as errors,
           percentile_cont(0.95) within group (order by t.ms) filter (where t.ok) as p95
      from (values ('add', 60000), ('follow', 8000), ('find', 30000), ('find.directory', 300)) as b (route, bar_ms)
      left join public.route_timings t on t.route = b.route and t.at > now() - interval '7 days'
     group by b.route, b.bar_ms
     order by b.route
  loop
    total := total + r.n;
    if r.n = 0 then
      parts := parts || format('%s: no calls in the last 7 days. ', r.route);
    else
      worst := least(coalesce(worst, 1), r.within::numeric / r.n);
      parts := parts || format('%s: %s of %s within %s s, p95 %s over the calls that answered, %s failed. ',
        r.route, r.within, r.n, trim_scale(r.bar_ms / 1000.0), coalesce(round(r.p95::numeric)::text || ' ms', 'none answered'), r.errors);
    end if;
  end loop;

  if total = 0 then
    return query select null::numeric, null::boolean, 0, 'No add, follow or find call in the last 7 days.'::text;
    return;
  end if;
  return query select
    round(100 * worst, 1),
    case when worst is null then null else worst >= 0.95 end,
    total,
    trim(parts) || ' The bar is 95 percent within each bar.';
end;
$$;

revoke all on function public.measure_t37() from public, anon, authenticated;
grant execute on function public.measure_t37() to service_role;

update public.measures
   set name = 'Companies route timings: share of add calls answered within 60 s, follow calls within 8 s, find calls within 30 s and the find directory rung within 300 ms, failures counted as misses, per 7 days'
 where id = 'T37';

-- T37 self-check: the real calls are set aside inside the block and come back on rollback; the count is compared after.
do $$
declare
  n_before integer;
  r record;
begin
  select count(*) into n_before from public.route_timings;
  begin
    delete from public.route_timings;
    -- find: one call within 30 s, one over it, so 50; the directory rung: one within 300 ms, one over it, so 50. The worst is 50.
    insert into public.route_timings (route, ms, ok) values ('find', 4000, true), ('find', 40000, true), ('find.directory', 100, true), ('find.directory', 1000, true);
    select * into r from public.measure_t37();
    if r.value <> 50 or r.passed or r.sample_n <> 4 or r.note not like '%find: 1 of 2 within 30 s%' or r.note not like '%find.directory: 1 of 2 within 0.3 s%' then
      raise exception 'measure_t37: the find bars must count, got % % % %', r.value, r.passed, r.sample_n, r.note;
    end if;
    -- both find calls within their bars: 100 for find and for the directory rung, and nothing else called, so it passes
    delete from public.route_timings;
    insert into public.route_timings (route, ms, ok) values ('find', 4000, true), ('find.directory', 100, true);
    select * into r from public.measure_t37();
    if r.value <> 100 or not r.passed or r.sample_n <> 2 then
      raise exception 'measure_t37: find calls within their bars must pass, got % % %', r.value, r.passed, r.sample_n;
    end if;
    raise exception 'measure_t37 find self-check passed' using errcode = 'P0001';
  exception when raise_exception then
    if sqlerrm <> 'measure_t37 find self-check passed' then raise; end if;
  end;
  if (select count(*) from public.route_timings) <> n_before then raise exception 'the self-check changed the route timings'; end if;
end
$$;

notify pgrst, 'reload schema';
