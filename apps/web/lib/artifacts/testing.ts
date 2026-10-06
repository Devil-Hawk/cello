// A fake service client with the made-thing store in it, for tests of the stores that write
// artifacts (resume, outreach, dossier, drafts). artifact_add_version is the SQL function in JS;
// supabase/checks/learning_writer_k17.sql proves the real tables.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeAdmin, type FakeAdmin, type TableConfig } from '@/lib/agents/testing/fake-admin'

type Row = Record<string, unknown>

export function artifactWorld(seed: Record<string, Row[]> = {}, more: Record<string, TableConfig> = {}): { admin: FakeAdmin; client: SupabaseClient } {
  const admin = makeFakeAdmin(seed, {
    ...more,
    artifacts: { unique: [['user_id', 'idempotency_key']], defaults: () => ({ current_version: 1, about: [], is_base: false, updated_at: new Date().toISOString() }) },
  })
  admin.rpcHandlers.artifact_add_version = async (args) => {
    const art = admin.tables.artifacts.find((r) => r.id === args.p_artifact_id && r.user_id === args.p_user_id)
    if (!art) throw new Error('artifact not found for this user')
    const next = (art.current_version as number) + 1
    art.current_version = next
    admin.tables.artifact_versions ??= []
    admin.tables.artifact_versions.push({
      id: randomUUID(),
      created_at: new Date().toISOString(),
      artifact_id: art.id,
      version: next,
      author: args.p_author,
      content: args.p_content,
      content_text: args.p_content_text,
    })
    return next
  }
  return { admin, client: admin as unknown as SupabaseClient }
}
