import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAllowedModel } from '@/lib/models'

// This module must export ONLY GET/POST. A route file may not export anything
// else (Next.js validates route exports at build time, and `tsc --noEmit` does
// NOT catch it) — the model list therefore lives in @/lib/models.

// GET - Return the user's saved model preference (null when unset).
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const model = typeof preferences.model === 'string' ? preferences.model : null

  return NextResponse.json({ model })
}

// POST - Save the user's model preference (merges into preferences without
// clobbering preferences.api_keys — read-modify-write, same as the keys route).
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { model } = body as { model?: string }

  if (!isAllowedModel(model)) {
    return NextResponse.json({ error: 'Invalid model id' }, { status: 400 })
  }

  // Read-modify-write so api_keys (and any other prefs) survive.
  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>

  const { error } = await supabase
    .from('profiles')
    .update({ preferences: { ...preferences, model } })
    .eq('id', user.id)

  if (error) {
    console.error('Failed to save model preference:', error)
    return NextResponse.json({ error: 'Failed to save model' }, { status: 500 })
  }

  return NextResponse.json({ success: true, model })
}
