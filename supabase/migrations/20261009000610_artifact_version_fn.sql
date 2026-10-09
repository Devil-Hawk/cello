-- Agent engine, part 8: adding an artifact version is one atomic call.
--
-- WHY
--   A new version needs the next number and a row in artifact_versions, and two
--   edits at once must not both take the same number. Doing the increment and
--   the insert in one function means the row lock on `artifacts` orders them.
--   An idempotency key makes a retried tool call add nothing the second time.
--
-- Only the server (service role) may call it; the function runs as the caller.

alter table public.artifact_versions add column if not exists idempotency_key text
  check (idempotency_key is null or char_length(idempotency_key) <= 160);

create unique index if not exists uq_artifact_versions_idempotency
  on public.artifact_versions (artifact_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.artifact_add_version(
  p_user_id uuid,
  p_artifact_id uuid,
  p_author text,
  p_content jsonb,
  p_content_text text,
  p_note text default null,
  p_review jsonb default null,
  p_trace_id text default null,
  p_idempotency_key text default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v integer;
begin
  -- A retry of the same call returns the version it already made.
  if p_idempotency_key is not null then
    select av.version into v
      from public.artifact_versions av
      join public.artifacts a on a.id = av.artifact_id
     where av.artifact_id = p_artifact_id
       and a.user_id = p_user_id
       and av.idempotency_key = p_idempotency_key;
    if v is not null then
      return v;
    end if;
  end if;

  update public.artifacts
     set current_version = current_version + 1, updated_at = now()
   where id = p_artifact_id and user_id = p_user_id
   returning current_version into v;
  if v is null then
    raise exception 'artifact % not found for this user', p_artifact_id using errcode = 'no_data_found';
  end if;

  insert into public.artifact_versions
    (artifact_id, version, author, content, content_text, note, review, trace_id, idempotency_key)
  values
    (p_artifact_id, v, p_author, p_content, p_content_text, p_note, p_review, p_trace_id, p_idempotency_key);
  return v;
end;
$$;

revoke all on function public.artifact_add_version(uuid, uuid, text, jsonb, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.artifact_add_version(uuid, uuid, text, jsonb, text, text, jsonb, text, text)
  to service_role;

notify pgrst, 'reload schema';

do $$
begin
  if has_function_privilege('anon', 'public.artifact_add_version(uuid, uuid, text, jsonb, text, text, jsonb, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.artifact_add_version(uuid, uuid, text, jsonb, text, text, jsonb, text, text)', 'execute') then
    raise exception 'artifact_add_version must not be executable by client roles';
  end if;
end
$$;
