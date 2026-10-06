// A read client scoped to one person, for reads written against a client whose
// session is the person's (row level security does the scoping there). At the
// session door the person's own client is used as is. At every other door the
// service-role client is wrapped so each select is pinned to the person's rows.
// Select only: a write through this wrapper does not exist.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommandContext } from './define'

export function readClient(ctx: CommandContext): SupabaseClient {
  if (ctx.supabase) return ctx.supabase
  const admin = ctx.admin()
  const scoped = {
    from: (table: string) => ({
      select: (...args: unknown[]) => (admin.from(table) as any).select(...args).eq('user_id', ctx.userId),
    }),
  }
  return scoped as unknown as SupabaseClient
}
