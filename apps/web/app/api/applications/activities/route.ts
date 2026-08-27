// GET /api/applications/activities?applicationId=<uuid> — the real
// conversation history behind an application: every public.activities row
// (Gmail-detected stage signal, recruiter calls, replies — see
// lib/access/fixtures/pipeline.ts's DemoActivity for the vocabulary),
// newest first, capped at 50. This is the SAME data the notifications page
// already reads off `activities`, just scoped to one application instead
// of surfaced ambiently.
//
// Auth + ownership mirror app/api/applications/receipts/route.ts exactly:
// session auth for "is anyone signed in", then the service-role admin
// client with an explicit getOwnedApplication(admin, user.id, applicationId)
// check — never trust an applicationId in the query string without it.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { getOwnedApplication, listActivities } from '@/lib/applications/store'

export const dynamic = 'force-dynamic'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  const applicationId = request.nextUrl.searchParams.get('applicationId')
  if (!applicationId) return bad('applicationId is required')

  const admin = createAdminClient()

  const application = await getOwnedApplication(admin, user.id, applicationId)
  if (!application) return bad('Application not found', 404)

  const activities = await listActivities(admin, applicationId)

  return NextResponse.json({ activities })
}
