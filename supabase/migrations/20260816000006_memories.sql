-- A dedicated Postgres schema for mem0's pgvector-backed memory store, owned
-- by the service role and touched by nothing else — same doctrine as
-- 20260817000001_langgraph_schema.sql's `langgraph` schema, restated here
-- because mem0's tables are exactly the same shape of risk: an
-- implementation detail of a third-party package (mem0ai), not a Cello
-- domain table.
--
-- WHY A SEPARATE SCHEMA, NOT public
--   mem0's PGVector provider auto-creates its own tables (a `memories`
--   collection table plus its own `memory_migrations` bookkeeping row) the
--   first time lib/memory/mem0-store.ts constructs a Memory instance. Same
--   three reasons as the checkpoint tables: PostgREST never serves a schema
--   it isn't configured with (`mem0` is deliberately not one of them), a
--   `\dt public.*` audit never has to reason about whether they carry PII
--   policy, and backfill tooling that iterates `public` never touches them.
--
-- WHY THE TABLES THEMSELVES ARE NOT VENDORED HERE
--   Same reasoning as the checkpoint schema: mem0ai's PGVector provider (not
--   this migration) is the only thing that creates or alters those tables —
--   see lib/memory/mem0-store.ts's own header for exactly when that runs.
--   Hand-writing that DDL here would pin us to whatever shape mem0ai@3.1.6
--   happens to produce today and drift the moment the pinned version bumps.
--
-- WHY REVOKE FROM anon/authenticated EXPLICITLY
--   Same as the checkpoint schema's own comment: USAGE on a schema is what
--   makes even name resolution possible for a role, so revoking it is
--   defense against a future PostgREST config change or helper function
--   that runs as one of those roles, not just reliance on today's
--   exposed-schemas list.
--
-- SECURITY POSTURE MIRRORS THE CHECKPOINT TABLES' DOCTRINE (see docs/
-- superpowers/specs/2026-08-16-langgraph-port-design.md's memory decision):
-- every access goes through lib/memory/types.ts's MemoryStore chokepoint,
-- which REQUIRES a userId on every call — mem0's auto-created table has no
-- user_id column of its own, so that scoping lives entirely in the payload
-- mem0 stores and in the userId filter passed on every read/write.
create schema if not exists mem0;

revoke all on schema mem0 from anon, authenticated;

grant usage on schema mem0 to service_role;

comment on schema mem0 is
  'mem0ai''s pgvector memory store. Tables inside are created ONLY by mem0''s PGVector provider (lib/memory/mem0-store.ts, constructed lazily via getMemoryStore()) — never by a Supabase migration file. See this file''s header for why vendoring that DDL here would drift from the pinned mem0ai version.';

-- Rolling conversation summary (Step 7's turn-assembly composition item (a))
-- — additive, nullable, no default, so every existing copilot_conversations
-- row and read/write path is untouched until lib/graph/copilot.ts starts
-- populating it post-turn.
alter table public.copilot_conversations
  add column if not exists summary text;

comment on column public.copilot_conversations.summary is
  'Rolling summary of this conversation''s older messages, refreshed post-turn by a cheap metered callLlm once summary_through_message_id falls 12 or more messages behind the latest. NULL until the first refresh.';

alter table public.copilot_conversations
  add column if not exists summary_through_message_id uuid;

comment on column public.copilot_conversations.summary_through_message_id is
  'copilot_messages.id of the newest message folded into `summary`. Messages after this id are still owed a summary pass; messages up to and including it must never be re-summarized.';

notify pgrst, 'reload schema';
