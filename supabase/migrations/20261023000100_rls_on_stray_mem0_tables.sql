-- mem0ai recreated two stray tables in public (see 20260825000001). Keep them out of the API.
alter table if exists public.memories_entities enable row level security;
alter table if exists public.memory_migrations enable row level security;
revoke all on table public.memories_entities from anon, authenticated;
revoke all on table public.memory_migrations from anon, authenticated;
