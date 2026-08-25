import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/crypto'

interface ApiKeys {
  openai?: string
  anthropic?: string
  openrouter?: string
  [key: string]: string | undefined
}

// GET - Check which keys are configured (never return actual keys)
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
  const keys = (preferences.api_keys || {}) as ApiKeys

  // Only return whether keys exist, never the actual keys
  return NextResponse.json({
    hasOpenai: !!keys.openai,
    hasAnthropic: !!keys.anthropic,
    hasOpenrouter: !!keys.openrouter,
  })
}

// POST - Save encrypted API keys
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { openai, anthropic, openrouter } = body as ApiKeys

  // Validate key formats
  if (openai && !openai.startsWith('sk-')) {
    return NextResponse.json({ error: 'OpenAI key should start with sk-' }, { status: 400 })
  }
  if (anthropic && !anthropic.startsWith('sk-ant-')) {
    return NextResponse.json({ error: 'Anthropic key should start with sk-ant-' }, { status: 400 })
  }
  if (openrouter && !openrouter.startsWith('sk-or-')) {
    return NextResponse.json({ error: 'OpenRouter key should start with sk-or-' }, { status: 400 })
  }

  // Get existing preferences
  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const existingKeys = (preferences.api_keys || {}) as ApiKeys

  // Encrypt and update keys
  const newKeys: ApiKeys = { ...existingKeys }

  if (openai) {
    newKeys.openai = encrypt(openai)
  }
  if (anthropic) {
    newKeys.anthropic = encrypt(anthropic)
  }
  if (openrouter) {
    newKeys.openrouter = encrypt(openrouter)
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      preferences: { ...preferences, api_keys: newKeys }
    })
    .eq('id', user.id)

  if (error) {
    console.error('Failed to save API keys:', error)
    return NextResponse.json({ error: 'Failed to save API keys' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    hasOpenai: !!newKeys.openai,
    hasAnthropic: !!newKeys.anthropic,
    hasOpenrouter: !!newKeys.openrouter,
  })
}

// DELETE - Remove a specific API key
export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const provider = searchParams.get('provider') as 'openai' | 'anthropic' | 'openrouter'

  if (!provider || !['openai', 'anthropic', 'openrouter'].includes(provider)) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('preferences')
    .eq('id', user.id)
    .single()

  const preferences = (profile?.preferences || {}) as Record<string, unknown>
  const existingKeys = (preferences.api_keys || {}) as ApiKeys

  delete existingKeys[provider]

  const { error } = await supabase
    .from('profiles')
    .update({
      preferences: { ...preferences, api_keys: existingKeys }
    })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: 'Failed to delete API key' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
