// DELETE /api/apply-credentials/:id — take a password back out of the vault.
//
// The only exit a stored secret has. It is deliberately unconditional: it does
// not require the deployment's encryption to be working (see deleteCredential's
// note — a missing key is exactly when someone most wants to empty the vault),
// and it never confirms whether an id it refuses actually exists.
//
// Scoped by the caller's own session, so RLS refuses another account's row even
// if the id is guessed.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { deleteCredential } from '@/lib/apply/vault'
import { NO_STORE, vaultErrorResponse } from '../http'

export const dynamic = 'force-dynamic'

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const db = supabase as unknown as SupabaseClient

  try {
    const removed = await deleteCredential(db, user.id, params.id)
    if (!removed) {
      // Same answer for "never existed", "already deleted" and "belongs to
      // someone else". This route is not an oracle for which employers another
      // account has sign-ins with.
      return NextResponse.json(
        { error: 'That sign-in is no longer saved.' },
        { status: 404, headers: NO_STORE }
      )
    }
    return NextResponse.json({ deleted: true }, { headers: NO_STORE })
  } catch (error) {
    return vaultErrorResponse(error, 'delete')
  }
}
