// GET    /api/settings/skills        Cello's skills with their state per kind of model, and the person's own (no bodies).
// POST   /api/settings/skills        add a skill: { markdown, references?, folder? }, re-read on the server.
// PATCH  /api/settings/skills        switch one on or off: { id, enabled }.
// DELETE /api/settings/skills?id=    remove one.
//
// Signed-in session only. Writes use the service-role client (person_skills has no write policy), so every query is
// scoped by user_id here. A demo cannot write. A skill grants nothing: the file is parsed again on the server and only
// its name and description are kept (lib/skills/parse.ts), whatever the page sent.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { celloSkillStates } from '@/lib/agents/backends'
import { SKILL_MAX_CHARS, parseSkillMd, skillBody } from '@/lib/skills/parse'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const VIEW = 'id, name, description, source, enabled, created_at'
/** The page's view of a row: never the body. */
const view = (r: Record<string, unknown>) => ({ id: r.id, name: r.name, description: r.description, source: r.source, enabled: r.enabled, created_at: r.created_at })
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const bad = (message: string, fix: string) => json({ error: 'bad_request', message, fix }, 400)
const notFound = () => json({ error: 'not_found', message: 'That skill was not found.' }, 404)

/** The signed-in person, and for writes a refusal when they are a demo or cannot be checked. */
async function caller(write: boolean): Promise<{ userId: string } | { refused: NextResponse }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { refused: json({ error: 'Unauthorized' }, 401) }
  if (write) {
    const { data: profile } = await (supabase as unknown as SupabaseClient).from('profiles').select('is_demo, demo_expires_at').eq('id', user.id).maybeSingle()
    // Fails closed: a profile that cannot be read is not proof of "not a demo".
    if (!profile) return { refused: json({ error: 'unverified', message: "We couldn't check your account.", fix: 'Try again in a moment.' }, 403) }
    if (isDemoProfile(profile as DemoProfileFacts)) return { refused: json({ error: 'demo', message: 'A demo account cannot add skills.', fix: 'Sign up to add your own.' }, 403) }
  }
  return { userId: user.id }
}

const TOO_BIG = () => bad('That is more than 200 KB.', 'Remove some files and try again.')
const FAILED = () => json({ error: 'failed', message: "Couldn't save that. Nothing changed.", fix: 'Try again in a moment.' }, 500)

export async function GET() {
  const who = await caller(false)
  if ('refused' in who) return who.refused
  const { data, error } = await createAdminClient().from('person_skills').select(VIEW).eq('user_id', who.userId).order('created_at', { ascending: false })
  if (error) return json({ error: 'failed', message: "Couldn't load your skills.", fix: 'Reload the page.' }, 500)
  return json({ cello: celloSkillStates(), mine: (data ?? []).map(view) })
}

export async function POST(request: NextRequest) {
  const who = await caller(true)
  if ('refused' in who) return who.refused
  const raw = (await request.json().catch(() => null)) as { markdown?: unknown; references?: unknown; folder?: unknown } | null
  if (!raw || typeof raw.markdown !== 'string') return bad('There was no skill file to add.', 'Paste the SKILL.md text or pick a folder.')
  const refs = Array.isArray(raw.references)
    ? raw.references.filter((r): r is { path: string; text: string } => !!r && typeof r.path === 'string' && typeof r.text === 'string')
    : []
  if (raw.markdown.length + refs.reduce((n, r) => n + r.text.length, 0) > SKILL_MAX_CHARS) return TOO_BIG()
  const parsed = parseSkillMd(raw.markdown)
  if (!parsed.ok) return bad(parsed.error, parsed.fix)
  const body = skillBody(parsed.body, refs)
  if (body.length > SKILL_MAX_CHARS) return TOO_BIG()
  const folder = typeof raw.folder === 'string' ? raw.folder.trim().slice(0, 100) : ''
  const { data, error } = await createAdminClient()
    .from('person_skills')
    .insert({ user_id: who.userId, name: parsed.name, description: parsed.description, body, source: folder ? `Folder: ${folder}` : 'Pasted' })
    .select(VIEW)
    .single()
  if (error?.code === '23505') {
    return json({ error: 'exists', message: `You already have a skill named ${parsed.name}.`, fix: 'Delete it first, or change the name in the file.' }, 409)
  }
  if (error || !data) {
    console.error('[settings/skills] insert failed', error)
    return FAILED()
  }
  return json({ skill: view(data as Record<string, unknown>) })
}

export async function PATCH(request: NextRequest) {
  const who = await caller(true)
  if ('refused' in who) return who.refused
  const raw = (await request.json().catch(() => null)) as { id?: unknown; enabled?: unknown } | null
  if (!raw || typeof raw.id !== 'string' || typeof raw.enabled !== 'boolean') return bad('Say which skill and whether it is on.', 'Send the skill id and true or false.')
  const { data, error } = await createAdminClient()
    .from('person_skills')
    .update({ enabled: raw.enabled, updated_at: new Date().toISOString() })
    .eq('id', raw.id)
    .eq('user_id', who.userId)
    .select(VIEW)
    .maybeSingle()
  // 22P02: the id was not a uuid, so no skill has it.
  if (error?.code === '22P02' || (!error && !data)) return notFound()
  if (error) {
    console.error('[settings/skills] update failed', error)
    return FAILED()
  }
  return json({ skill: view(data as Record<string, unknown>) })
}

export async function DELETE(request: NextRequest) {
  const who = await caller(true)
  if ('refused' in who) return who.refused
  const id = request.nextUrl.searchParams.get('id')
  if (!id) return bad('Say which skill to remove.', 'Send the skill id.')
  const { data, error } = await createAdminClient().from('person_skills').delete().eq('id', id).eq('user_id', who.userId).select('id')
  if (error?.code === '22P02' || (!error && !data?.length)) return notFound()
  if (error) {
    console.error('[settings/skills] delete failed', error)
    return FAILED()
  }
  return json({ ok: true })
}
