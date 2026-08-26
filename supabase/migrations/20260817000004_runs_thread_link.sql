-- Additive back-pointers from the existing run/copilot tables to the
-- LangGraph thread that now backs them.
--
-- WHY ADDITIVE-ONLY
--   Both columns are `add column if not exists`, nullable, with no default.
--   Adding a nullable column with no default is a metadata-only change in
--   Postgres (no table rewrite, no lock beyond the brief one for the DDL
--   itself), so every existing read/write path on agent_runs and
--   copilot_conversations keeps working untouched until lib/graph/* starts
--   populating the new column.
--
-- WHY NO FOREIGN KEY TO graph_threads.thread_id
--   invokeGraphForUser() starts the graph — and therefore knows the
--   thread_id — before the corresponding agent_runs / copilot_conversations
--   row is necessarily committed (the run row is what the graph is IN THE
--   MIDDLE OF producing). An FK would force an ordering between "the thread
--   exists" and "the run row exists" that the call site does not naturally
--   have. graph_threads.run_id / .conversation_id (see
--   20260817000002_graph_threads.sql) already carry the ownership
--   relationship in the other direction; these columns are a convenience
--   lookup for the UI, not the source of truth for who owns what.
alter table public.agent_runs
  add column if not exists thread_id uuid;

comment on column public.agent_runs.thread_id is 'The LangGraph thread (graph_threads.thread_id) that produced this run, when the run went through the graph. NULL for runs from the pre-port harness path.';

alter table public.copilot_conversations
  add column if not exists thread_id uuid;

comment on column public.copilot_conversations.thread_id is 'The LangGraph thread (graph_threads.thread_id) backing this copilot conversation, when the conversation went through the graph. NULL for conversations from the pre-port harness path.';
