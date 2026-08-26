import Link from 'next/link'
import { ChevronLeft, ShieldOff } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { createClient } from '@/lib/supabase/server'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { AccessCodesCard } from '@/components/settings/access-codes-card'

export const metadata = {
  title: 'Demo access codes',
}

/**
 * Settings › Demo access codes.
 *
 * Its own route rather than another tab on /settings because this is the one
 * settings surface that hands out a credential: it deserves a link that can be
 * sent to someone ("go to /settings/access"), a page title that names what is
 * happening, and a URL an owner can bookmark while they are running a demo.
 *
 * Reached from the tab rail on /settings and from the Settings sub-item in the
 * sidebar (components/layout/nav-items.ts). Before those existed nothing in the
 * app linked here at all.
 *
 * A server component wrapping one client card — the card owns all the state,
 * and nothing here needs to render before the owner's session is checked, which
 * app/(app)/layout.tsx already does for every page underneath it.
 */
export default async function AccessCodesPage() {
  const isDemo = await callerIsDemo()

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 rounded-control text-caption text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Settings
        </Link>
        <h1 className="mt-1 font-display text-title text-foreground">Demo access</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Give someone a working look at the product without giving them anything of yours.
        </p>
      </div>

      {isDemo ? (
        // The nav entry is static and has no session, so a demo visitor can
        // land here. Showing them a create form that will 403 is a worse answer
        // than saying why — and it is the honest one: this workspace exists
        // because someone else issued a code.
        <EmptyState
          icon={ShieldOff}
          title="This is a demo workspace"
          body="Demo workspaces can't issue or revoke access codes — only the account that created this one can. Everything else in the product works normally here."
        />
      ) : (
        <Card className="p-6">
          <AccessCodesCard />
        </Card>
      )}
    </div>
  )
}

/**
 * Is the signed-in caller a demo profile?
 *
 * DELIBERATELY FAILS OPEN, and that is safe because this is a VIEW decision,
 * not the boundary. Three real locks stand behind it: POST /api/access-codes
 * refuses a demo caller and refuses again when it cannot read the profile at
 * all; RLS scopes every access_codes row to `owner_user_id = auth.uid()`; and
 * the trigger in 20260803000003_demo_profile_lockdown.sql refuses the insert at
 * the database. So an unreadable profile here costs nothing.
 *
 * Failing CLOSED here would cost something: it would replace the owner's list —
 * the only place a code can be revoked — with a refusal, over a transient
 * database error. Taking the kill switch away during an outage is the worse way
 * to be wrong, so an unknown answer renders the card and lets the guarded
 * actions refuse for themselves.
 */
async function callerIsDemo(): Promise<boolean> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return false

    // profiles.is_demo postdates @cello/shared's generated Database type, so
    // the read goes through an untyped view of the SAME cookie-scoped client —
    // the pattern app/api/access-codes/route.ts uses. RLS is unaffected by the
    // cast: "Users can view own profile" is what returns this row.
    const db = supabase as unknown as SupabaseClient
    const { data, error } = await db
      .from('profiles')
      .select('is_demo, demo_expires_at')
      .eq('id', user.id)
      .maybeSingle()

    if (error || !data) return false
    return isDemoProfile(data as DemoProfileFacts)
  } catch {
    return false
  }
}
