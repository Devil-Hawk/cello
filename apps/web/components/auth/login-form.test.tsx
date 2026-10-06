import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: {} }) }))

import { LoginForm, signInMessage } from './login-form'

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

describe('signInMessage', () => {
  it('says the email and password do not match for a bad login', () => {
    expect(signInMessage({ message: 'Invalid login credentials', status: 400 })).toBe(
      'That email and password do not match.',
    )
  })
  it('says to try again for anything else', () => {
    expect(signInMessage({ message: 'fetch failed' })).toBe('Could not sign in. Check your connection and try again.')
  })
})

describe('LoginForm', () => {
  it('holds the line from 4.2 and never says welcome back or AI-scored', () => {
    const t = text(renderToStaticMarkup(<LoginForm notice={null} openDemo={false} />))
    expect(t).toContain('Nothing is sent without your click.')
    expect(t).toContain('Continue with Google')
    expect(t).toContain('Have a demo code?')
    expect(t).not.toMatch(/welcome back|AI-scored|AI-drafted|—|!/i)
  })

  it('shows the cancelled and expired-demo notices', () => {
    expect(text(renderToStaticMarkup(<LoginForm notice="cancelled" openDemo={false} />))).toContain(
      'Sign-in was cancelled. Try again.',
    )
    expect(text(renderToStaticMarkup(<LoginForm notice="demo-expired" openDemo={false} />))).toContain(
      'That code is not valid or has expired. Ask whoever gave it to you for a new one, or sign in to use Cello with your own account.',
    )
  })

  it('opens the demo code field when asked', () => {
    const html = renderToStaticMarkup(<LoginForm notice={null} openDemo />)
    expect(html).toContain('id="demo-code"')
  })
})
