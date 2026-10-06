// lane-stub: K10 send command
//
// Sending from an approval waits for the command registry. Until it lands, these two
// have the signatures of the real send and approve paths and say so when called, so an
// approved row ends failed with a sentence and nothing leaves the workspace. Nothing
// creates approval rows before Chat ships, and the registry replaces this file with
// lib/commands/send.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AdminClient } from '@/lib/harness/types'

const NOT_BUILT = 'Not built yet: sending from an approval comes with the command registry'

export interface SendOutreachInput {
  supabase: SupabaseClient
  admin: () => AdminClient
  user: { id: string; email?: string | null; identities?: { provider: string }[] | null }
  session: { provider_token?: string | null } | null
  readBody: () => Promise<unknown>
}

export interface SendOutreachResult {
  status: number
  body: Record<string, unknown>
}

export interface ApproveDraftResult {
  status: number
  body: Record<string, unknown>
}

export async function sendOutreach(_input: SendOutreachInput): Promise<SendOutreachResult> {
  throw new Error(NOT_BUILT)
}

export async function approveDraft(_input: { admin: AdminClient; userId: string; draftId: string }): Promise<ApproveDraftResult> {
  throw new Error(NOT_BUILT)
}
