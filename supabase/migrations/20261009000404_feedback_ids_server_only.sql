-- The trace a row was written under, and what the model first wrote, are the
-- server's to set, never the browser's. The feedback triggers copy these columns
-- into feedback_events, and the exporter later scores that trace with the service
-- role: a person who could pick the trace id could put their own approvals and
-- edits onto someone else's generation. Same rule as person_roles in 000200:
-- table-wide insert and update go, the other columns are granted one by one.
-- Select and delete stay as they were.

do $$
declare
  t text;
  c text;
  writable text;
begin
  foreach t in array array['outreach_messages', 'application_drafts'] loop
    execute format('revoke insert, update on public.%I from authenticated', t);
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into writable
    from information_schema.columns
    where table_schema = 'public' and table_name = t
      and column_name not in ('trace_id', 'observation_id', 'generated_subject', 'generated_body',
                              'generated_cover_letter', 'generated_resume_summary');
    execute format('grant insert (%1$s), update (%1$s) on public.%2$I to authenticated', writable, t);

    foreach c in array array['trace_id', 'observation_id', 'generated_subject', 'generated_body',
                             'generated_cover_letter', 'generated_resume_summary'] loop
      if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c) then
        assert not has_column_privilege('authenticated', format('public.%I', t), c, 'UPDATE'), t || '.' || c || ': authenticated must not update';
        assert not has_column_privilege('authenticated', format('public.%I', t), c, 'INSERT'), t || '.' || c || ': authenticated must not insert';
      end if;
    end loop;
    assert has_column_privilege('authenticated', format('public.%I', t), 'user_id', 'INSERT'), t || ': authenticated still inserts its own rows';
  end loop;
end
$$;

notify pgrst, 'reload schema';
