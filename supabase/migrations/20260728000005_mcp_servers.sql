-- MCP (Model Context Protocol) BYO-server connector: lets a user point Cello
-- Copilot at any MCP server they run/trust and have its tools show up in the
-- copilot's tool loop, namespaced as `mcp:<server>:<tool>` so they can never
-- collide with a built-in tool. See apps/web/lib/mcp/{types,client,registry}.ts
-- and apps/web/lib/harness/copilot-tools.ts (dispatchMcpTool).
--
-- WHY THIS IS ADDITIVE AND IDEMPOTENT
--   Same discipline as 20260724000002_phaseB.sql: `create table if not exists`,
--   `create index if not exists`, and RLS policies guarded by a do-block that
--   checks pg_policies first (there is no `create policy if not exists` in
--   Postgres 15). Nothing here touches an existing table. Safe to re-run.
--
-- ONE NEW TABLE: user_mcp_servers — one row per server a user has configured.
--   - transport: 'http' | 'sse' | 'stdio'. No CHECK constraint on purpose —
--     the vocabulary lives in TS (apps/web/lib/mcp/types.ts McpTransportKind),
--     matching kb_sources.kind / application_drafts.status.
--   - url: for http/sse, the server URL; for stdio (self-hosted deployments
--     only — see isStdioAvailable() in lib/mcp/client.ts), the shell command
--     line to spawn. One column reused for both rather than adding
--     command/args columns, since stdio is the less-common path.
--   - headers: AES-256-GCM ciphertext (apps/web/lib/crypto.ts encrypt/decrypt)
--     of a JSON-encoded Record<string,string> of custom headers (bearer
--     tokens, API keys the remote server wants, etc). NEVER stored plaintext,
--     NEVER returned to the client — see lib/mcp/registry.ts toConfig().
--   - name doubles as the tool-namespace token (`mcp:<name>:<tool>`), so it's
--     unique per user (case-insensitively) and constrained to a safe
--     identifier shape in TS (lib/mcp/registry.ts isValidServerName).

create table if not exists public.user_mcp_servers (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid references public.profiles(id) on delete cascade not null,

    -- Tool-namespace token: mcp:<name>:<tool>. [a-z0-9_-]{1,40}, enforced in
    -- TS (lib/mcp/registry.ts isValidServerName), not by a CHECK.
    name text not null,

    -- http | sse | stdio. Vocabulary enforced in TS, not by a CHECK.
    transport text not null,

    -- http/sse: the server URL. stdio: the command line to spawn (self-hosted
    -- deployments only).
    url text,

    -- JSON-encoded custom headers, AES-256-GCM encrypted via lib/crypto.ts.
    -- NULL/empty when the server needs none. NEVER plaintext.
    headers text,

    enabled boolean default true not null,
    last_connected_at timestamptz,
    last_error text,
    created_at timestamptz default now() not null
);

-- Case-insensitive uniqueness per user: the name is the tool-namespace token,
-- so two servers named "Foo" and "foo" would produce colliding `mcp:foo:*`
-- tool names.
create unique index if not exists uniq_user_mcp_servers_user_name
  on public.user_mcp_servers (user_id, lower(name));

create index if not exists idx_user_mcp_servers_user
  on public.user_mcp_servers (user_id, created_at asc);

comment on table  public.user_mcp_servers          is 'Per-user MCP (Model Context Protocol) server connectors the copilot can call tools on. See apps/web/lib/mcp/*.';
comment on column public.user_mcp_servers.transport is 'http | sse | stdio. Vocabulary enforced in TS (lib/mcp/types.ts), not by a CHECK.';
comment on column public.user_mcp_servers.url       is 'http/sse: server URL. stdio: command line to spawn (self-hosted only, see lib/mcp/client.ts isStdioAvailable()).';
comment on column public.user_mcp_servers.headers   is 'JSON-encoded custom headers, AES-256-GCM encrypted via lib/crypto.ts (apps/web). NEVER plaintext, NEVER returned to the client.';
comment on column public.user_mcp_servers.name      is 'Tool-namespace token: tools are exposed to the copilot as mcp:<name>:<tool>. Unique per user (case-insensitive).';

alter table public.user_mcp_servers enable row level security;


-- ============================================================================
-- RLS policies — full per-user CRUD, mirroring the phaseB / application_drafts
-- policy set (20260724000002_phaseB.sql).
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_mcp_servers' and policyname = 'own user_mcp_servers select'
  ) then
    create policy "own user_mcp_servers select" on public.user_mcp_servers
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_mcp_servers' and policyname = 'own user_mcp_servers insert'
  ) then
    create policy "own user_mcp_servers insert" on public.user_mcp_servers
      for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_mcp_servers' and policyname = 'own user_mcp_servers update'
  ) then
    create policy "own user_mcp_servers update" on public.user_mcp_servers
      for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_mcp_servers' and policyname = 'own user_mcp_servers delete'
  ) then
    create policy "own user_mcp_servers delete" on public.user_mcp_servers
      for delete to authenticated using ((select auth.uid()) = user_id);
  end if;
end
$$;

-- Make the new table visible to PostgREST without waiting for its periodic
-- schema-cache refresh.
notify pgrst, 'reload schema';
