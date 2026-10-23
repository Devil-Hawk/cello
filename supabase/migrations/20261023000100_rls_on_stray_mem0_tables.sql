-- mem0ai recreated two stray tables in public (see 20260825000001). Keep them out of the API.
-- Guarded, because a database where mem0 never ran does not have them.
do $$
begin
  if to_regclass('public.memories_entities') is not null then
    alter table public.memories_entities enable row level security;
    revoke all on table public.memories_entities from anon, authenticated;
  end if;
  if to_regclass('public.memory_migrations') is not null then
    alter table public.memory_migrations enable row level security;
    revoke all on table public.memory_migrations from anon, authenticated;
  end if;
end $$;
