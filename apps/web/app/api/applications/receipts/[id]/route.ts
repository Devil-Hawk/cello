// PATCH /api/applications/receipts/[id] — correct a receipt the user
// already logged (typo'd confirmation number, adjust the date, attach a
// screenshot after the fact). Never touches provenance or
// verification_state — a correction to a self-asserted fact stays a
// self-asserted fact; see lib/applications/types.ts's ReceiptPatch.
//
// DELETE /api/applications/receipts/[id] — remove a wrong entry. Manual
// receipts are meant to be cheap to fix or retract, not a permanent record
// the user is stuck with once mis-typed.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { deleteReceipt, getReceipt, updateReceipt } from '@/lib/applications/store'
import { validateReceiptPatch } from '@/lib/applications/receipts'
import type { ReceiptDocument, ReceiptPatch } from '@/lib/applications/types'

export const dynamic = 'force-dynamic'

function bad(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status })
}

function parseDocuments(raw: unknown): ReceiptDocument[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return []
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => ({
      kind: d.kind === 'cover_letter' || d.kind === 'other' ? d.kind : 'resume',
      label: typeof d.label === 'string' ? d.label : '',
      resumeDocumentId: typeof d.resumeDocumentId === 'string' ? d.resumeDocumentId : null,
    }))
}

function parsePatch(body: unknown): ReceiptPatch {
  const b = (body ?? {}) as Record<string, unknown>
  const patch: ReceiptPatch = {}
  if (typeof b.submittedAt === 'string') patch.submittedAt = b.submittedAt
  if (typeof b.destination === 'string') patch.destination = b.destination
  const documents = parseDocuments(b.documents)
  if (documents !== undefined) patch.documents = documents
  if ('confirmationIdentifier' in b) {
    patch.confirmationIdentifier = typeof b.confirmationIdentifier === 'string' ? b.confirmationIdentifier : null
  }
  if ('confirmationNote' in b) {
    patch.confirmationNote = typeof b.confirmationNote === 'string' ? b.confirmationNote : null
  }
  if ('confirmationAttachmentUrl' in b) {
    patch.confirmationAttachmentUrl =
      typeof b.confirmationAttachmentUrl === 'string' ? b.confirmationAttachmentUrl : null
  }
  return patch
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return bad('Invalid JSON body')
  }

  const patch = parsePatch(body)
  if (Object.keys(patch).length === 0) return bad('Nothing to update')

  const validation = validateReceiptPatch(patch)
  if (!validation.ok) return bad('Invalid receipt', 400, { errors: validation.errors })

  const admin = createAdminClient()
  const existing = await getReceipt(admin, user.id, params.id)
  if (!existing) return bad('Receipt not found', 404)

  const updated = await updateReceipt(admin, user.id, params.id, patch)
  if (!updated) return bad('Receipt not found', 404)

  return NextResponse.json({ receipt: updated })
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  const admin = createAdminClient()
  await deleteReceipt(admin, user.id, params.id)
  return NextResponse.json({ ok: true })
}
