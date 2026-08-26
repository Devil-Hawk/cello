-- A dedicated Postgres schema for LangGraph's checkpointer, owned by the
-- service role and touched by nothing else.
--
-- WHY A SEPARATE SCHEMA, NOT public
--   The checkpointer's tables (checkpoints, checkpoint_blobs,
--   checkpoint_writes, checkpoint_migrations, ...) are an implementation
--   detail of @langchain/langgraph-checkpoint-postgres, not a Cello domain
--   table. Keeping them out of `public` means PostgREST never exposes them
--   (PostgREST only serves the schemas it is configured with, and `langgraph`
--   is deliberately not one of them), a `\dt public.*` audit never has to
--   reason about whether they carry PII policy, and pg_dump/backfill tooling
--   that iterates `public` never touches them by accident.
--
-- WHY THE TABLES THEMSELVES ARE NOT VENDORED HERE
--   PostgresSaver.setup() (from @langchain/langgraph-checkpoint-postgres) is
--   the ONLY thing that is allowed to create or alter those tables. Hand-
--   writing their DDL in a migration would pin us to whatever shape the
--   checkpointer happened to have on the day this file was written, and the
--   package's own migration runner (it carries its OWN internal versioned
--   migrations, tracked in checkpoint_migrations) would then find tables that
--   look almost-but-not-quite like what it expects on the next dependency
--   bump — silent drift between "what the code believes the schema is" and
--   "what a human copied into a .sql file months ago". Running setup() keeps
--   exactly one source of truth for that shape: the pinned package version in
--   apps/web/package.json (see the exact pins on @langchain/langgraph,
--   @langchain/langgraph-checkpoint-postgres and @langchain/core — no caret
--   ranges, so setup() cannot silently run against a schema shape the pinned
--   code doesn't expect).
--
--   setup() is invoked by apps/web/scripts/setup-checkpointer.ts
--   (`pnpm setup:checkpointer`), run once per environment against
--   SUPABASE_DB_URL_DIRECT — an operational step, not a migration, because it
--   is idempotent, owned by a third-party package's release cadence rather
--   than ours, and needs a direct (non-pooled) connection that this
--   migration-apply path does not have.
--
-- WHY REVOKE FROM anon/authenticated EXPLICITLY, when PostgREST already can't
-- see this schema: USAGE on a schema is what makes even NAME RESOLUTION
-- possible for a role (`select * from langgraph.checkpoints` first needs
-- USAGE before Postgres will even tell you the table doesn't exist to you).
-- Revoking it is what stops a future misconfiguration — a service that adds
-- `langgraph` to PostgREST's exposed-schemas list, or a helper function that
-- runs as one of those roles — from being able to see into the checkpointer
-- state at all. Defense that does not depend on PostgREST's config staying
-- the way it is today.
create schema if not exists langgraph;

revoke all on schema langgraph from anon, authenticated;

grant usage on schema langgraph to service_role;

comment on schema langgraph is
  'LangGraph checkpointer state. Tables inside are created and migrated ONLY by PostgresSaver.setup() (apps/web/scripts/setup-checkpointer.ts, pnpm setup:checkpointer) — never by a Supabase migration file. See this file''s header for why vendoring that DDL here would drift from the pinned package version.';
