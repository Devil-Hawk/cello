-- Proves migration 20261123000000 (material). It applies the migration again inside
-- the transaction (so a re-run is exercised), then checks that search_material
--   * never returns a fetched page (company_site, dossier), by words or by vector,
--   * hides a source whose "Cello may use this" switch is off,
--   * keeps one company's documents when asked,
--   * returns one person's material to that person only,
-- and that material_kind follows the connector kind.
--
--   psql -X -v ON_ERROR_STOP=1 -f supabase/checks/extension-models_material.sql \
--        "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'mat-a@example.invalid'),
  ('aaaaaaaa-1111-0000-0000-000000000002', 'mat-b@example.invalid');
insert into public.profiles (id, email) values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'mat-a@example.invalid'),
  ('aaaaaaaa-1111-0000-0000-000000000002', 'mat-b@example.invalid')
on conflict (id) do nothing;

\ir ../migrations/20261123000000_material_expand.sql

-- A unit vector: 1 at position n, 0 elsewhere. Distinct n are orthogonal.
create function pg_temp.unit(n integer) returns extensions.vector(384)
language sql immutable as $$
  select array_agg(case when i = n then 1.0::real else 0.0::real end order by i)::extensions.vector(384)
  from generate_series(1, 384) i
$$;

insert into public.companies (id, user_id, name, career_url)
values ('aaaaaaaa-2222-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', 'Material Co', 'https://example.invalid/m');

-- Person A: a note, a hidden note, a note about the company; and two fetched sources.
insert into public.kb_sources (id, user_id, kind, label, may_use) values
  ('aaaaaaaa-3333-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', 'paste', 'note', true),
  ('aaaaaaaa-3333-0000-0000-000000000002', 'aaaaaaaa-1111-0000-0000-000000000001', 'paste', 'hidden note', false),
  ('aaaaaaaa-3333-0000-0000-000000000003', 'aaaaaaaa-1111-0000-0000-000000000001', 'company_site', 'site', true),
  ('aaaaaaaa-3333-0000-0000-000000000004', 'aaaaaaaa-1111-0000-0000-000000000001', 'dossier', 'dossier', true),
  ('aaaaaaaa-3333-0000-0000-000000000005', 'aaaaaaaa-1111-0000-0000-000000000001', 'url', 'link', true),
  ('aaaaaaaa-3333-0000-0000-000000000006', 'aaaaaaaa-1111-0000-0000-000000000002', 'paste', 'b note', true);

do $$
begin
  assert (select material_kind from public.kb_sources where id = 'aaaaaaaa-3333-0000-0000-000000000001') = 'person', 'paste is person material';
  assert (select material_kind from public.kb_sources where id = 'aaaaaaaa-3333-0000-0000-000000000005') = 'person', 'a link the person added is person material';
  assert (select material_kind from public.kb_sources where id = 'aaaaaaaa-3333-0000-0000-000000000003') = 'fetched', 'company_site is fetched';
  assert (select material_kind from public.kb_sources where id = 'aaaaaaaa-3333-0000-0000-000000000004') = 'fetched', 'dossier is fetched';
end $$;

insert into public.kb_documents (id, user_id, source_id, title, content, company_id) values
  ('aaaaaaaa-4444-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000001', 'My note', 'kayak paddling lessons', null),
  ('aaaaaaaa-4444-0000-0000-000000000002', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000002', 'Hidden', 'kayak secrets', null),
  ('aaaaaaaa-4444-0000-0000-000000000003', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000003', 'Site', 'kayak company page', 'aaaaaaaa-2222-0000-0000-000000000001'),
  ('aaaaaaaa-4444-0000-0000-000000000004', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000004', 'Dossier', 'kayak dossier', 'aaaaaaaa-2222-0000-0000-000000000001'),
  ('aaaaaaaa-4444-0000-0000-000000000005', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-3333-0000-0000-000000000005', 'Link', 'kayak article i saved', 'aaaaaaaa-2222-0000-0000-000000000001'),
  ('aaaaaaaa-4444-0000-0000-000000000006', 'aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-3333-0000-0000-000000000006', 'B note', 'kayak from person b', null);

insert into public.kb_chunks (id, user_id, document_id, ord, content, embedding_384) values
  ('aaaaaaaa-5555-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000001', 0, 'kayak paddling lessons', pg_temp.unit(1)),
  ('aaaaaaaa-5555-0000-0000-000000000002', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000002', 0, 'kayak secrets', pg_temp.unit(2)),
  ('aaaaaaaa-5555-0000-0000-000000000003', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000003', 0, 'kayak company page', pg_temp.unit(3)),
  ('aaaaaaaa-5555-0000-0000-000000000004', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000004', 0, 'kayak dossier', pg_temp.unit(4)),
  ('aaaaaaaa-5555-0000-0000-000000000005', 'aaaaaaaa-1111-0000-0000-000000000001', 'aaaaaaaa-4444-0000-0000-000000000005', 0, 'kayak article i saved', pg_temp.unit(5)),
  ('aaaaaaaa-5555-0000-0000-000000000006', 'aaaaaaaa-1111-0000-0000-000000000002', 'aaaaaaaa-4444-0000-0000-000000000006', 0, 'kayak from person b', pg_temp.unit(1));

do $$
declare
  a constant uuid := 'aaaaaaaa-1111-0000-0000-000000000001';
  ids uuid[];
begin
  -- Words only: the person's own note and their saved link; no fetched page, no hidden note, nothing of B's.
  select array_agg(chunk_id order by chunk_id) into ids from public.search_material(a, 'kayak');
  assert ids = array['aaaaaaaa-5555-0000-0000-000000000001', 'aaaaaaaa-5555-0000-0000-000000000005']::uuid[],
    'words-only search must return exactly the note and the saved link, got ' || coalesce(ids::text, 'nothing');

  -- By vector: the query vector sits on a fetched page and on the hidden note; neither may come back.
  select array_agg(chunk_id order by chunk_id) into ids from public.search_material(a, 'zzzzqqq', 12, pg_temp.unit(3));
  assert ids is null, 'a vector match on a fetched page came back: ' || ids::text;
  select array_agg(chunk_id order by chunk_id) into ids from public.search_material(a, 'zzzzqqq', 12, pg_temp.unit(2));
  assert ids is null, 'a vector match on a hidden source came back: ' || ids::text;
  -- ...and a vector that sits on the note finds it with no word in common.
  select array_agg(chunk_id) into ids from public.search_material(a, 'zzzzqqq', 12, pg_temp.unit(1));
  assert ids = array['aaaaaaaa-5555-0000-0000-000000000001']::uuid[], 'the vector did not find the note, got ' || coalesce(ids::text, 'nothing');

  -- One company's documents: the saved link is tagged, the note is not.
  select array_agg(chunk_id) into ids from public.search_material(a, 'kayak', 12, null, 'aaaaaaaa-2222-0000-0000-000000000001');
  assert ids = array['aaaaaaaa-5555-0000-0000-000000000005']::uuid[], 'the company filter kept the wrong rows: ' || coalesce(ids::text, 'nothing');

  -- A hidden source comes back when the switch goes back on.
  update public.kb_sources set may_use = true where id = 'aaaaaaaa-3333-0000-0000-000000000002';
  select array_agg(chunk_id order by chunk_id) into ids from public.search_material(a, 'kayak');
  assert 'aaaaaaaa-5555-0000-0000-000000000002'::uuid = any (ids), 'a source set back to usable stayed hidden';
  update public.kb_sources set may_use = false where id = 'aaaaaaaa-3333-0000-0000-000000000002';

  -- Person B sees only B's material.
  select array_agg(chunk_id) into ids from public.search_material('aaaaaaaa-1111-0000-0000-000000000002', 'kayak', 12, pg_temp.unit(1));
  assert ids = array['aaaaaaaa-5555-0000-0000-000000000006']::uuid[], 'B saw something that is not B''s: ' || coalesce(ids::text, 'nothing');
end $$;

-- A client may call the function; anon may not.
do $$
begin
  assert has_function_privilege('authenticated', 'public.search_material(uuid, text, integer, extensions.vector, uuid)', 'execute'), 'authenticated cannot search';
  assert not has_function_privilege('anon', 'public.search_material(uuid, text, integer, extensions.vector, uuid)', 'execute'), 'anon can search';
end $$;

rollback;
