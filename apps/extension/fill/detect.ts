import type { StopCause } from '../lib/fill-contract'
import { CHALLENGE_INPUT } from './classify'
import { fieldVisible, isVisible, text } from './dom'

// What Cello never gets past for the person: a sign-in, an account form, a human
// check. Detection reads the page; it never touches a challenge input or frame.

export interface Blocker {
  cause: Extract<StopCause, 'sign_in' | 'account' | 'site_check'>
}

export const BLOCKED_LINE = "Sign in or finish the site's check yourself, then click Fill again."

const CHALLENGE_SRC =
  /(google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs\.com|funcaptcha\.com)/i
const WIDGET = '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]'

function big(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width >= 100 && r.height >= 50
}

/** A challenge a person can see and must solve. A badge or a 1px frame does not count. */
export function visibleChallenge(doc: Document = document): boolean {
  for (const f of Array.from(doc.querySelectorAll('iframe'))) {
    if (CHALLENGE_SRC.test(f.src) && !f.closest('.grecaptcha-badge') && isVisible(f) && big(f)) return true
  }
  for (const w of Array.from(doc.querySelectorAll(WIDGET))) {
    if (w.closest('.grecaptcha-badge')) continue
    if (w.getAttribute('data-size') === 'invisible') continue
    if (isVisible(w) && big(w)) return true
  }
  return false
}

/** A request for a code sent to the person: not something Cello can answer. */
function codeRequest(doc: Document): boolean {
  for (const i of Array.from(doc.querySelectorAll<HTMLInputElement>('input'))) {
    if (!fieldVisible(i) || i.type === 'hidden') continue
    if (CHALLENGE_INPUT.test(i.name)) continue
    const label = `${i.autocomplete} ${i.name} ${i.getAttribute('aria-label') ?? ''} ${text(i.labels?.[0])}`
    if (/one-time-code|verification code|security code|enter the code/i.test(label)) return true
  }
  return false
}

const NEW_ACCOUNT = /confirm password|verify password|re-?enter password|create (a |your )?password/i

/**
 * `strict` is the automatic send: any visible password input anywhere is a stop.
 * The person's own fill stops only for a short sign-in or account wall, so a long
 * application that happens to carry a password field is still filled.
 */
export function detectBlockers(doc: Document = document, strict = false): Blocker | null {
  if (visibleChallenge(doc) || codeRequest(doc)) return { cause: 'site_check' }

  const passwords = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(fieldVisible)
  if (passwords.length) {
    const others = Array.from(doc.querySelectorAll<HTMLInputElement>('input, select, textarea')).filter((i) => {
      const t = (i.getAttribute('type') || 'text').toLowerCase()
      return !['hidden', 'password', 'submit', 'button', 'checkbox'].includes(t) && fieldVisible(i)
    })
    if (strict || others.length <= 4) {
      const account =
        passwords.length > 1 ||
        passwords.some((p) => p.autocomplete === 'new-password') ||
        NEW_ACCOUNT.test(text(doc.body).slice(0, 4000))
      return { cause: account ? 'account' : 'sign_in' }
    }
  }
  return null
}
