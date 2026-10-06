// Which fields Cello never reads back: sensitive answers, EEO questions and consents.
// The server's category wins; the patterns are a second line so a field the server
// did not categorize is still treated as private.

export type Sensitivity = 'eeo' | 'consent' | 'sensitive' | null

const EEO = /gender|ethnic|\brace\b|racial|veteran|disabilit|pronoun|sexual orientation|hispanic|latino|lgbt|demographic/i
const CONSENT = /\bagree|consent|acknowledg|terms|privacy|gdpr|certif|attest|opt[- ]?in|i have read/i
const SENSITIVE = /sponsor|authori[sz]|work auth|visa|right to work|salary|compensation|pay expect|desired pay/i

export interface Describable {
  label: string
  name: string
  type: string
}

export function sensitivityOf(f: Describable, serverCategory?: string): Sensitivity {
  if (serverCategory === 'eeo' || serverCategory === 'consent' || serverCategory === 'sensitive') {
    return serverCategory
  }
  const text = `${f.label} ${f.name}`
  if (EEO.test(text)) return 'eeo'
  if (SENSITIVE.test(text)) return 'sensitive'
  if ((f.type === 'checkbox' || f.type === 'radio') && CONSENT.test(text)) return 'consent'
  return null
}

/** Input names that belong to a challenge widget. Never read, never written. */
export const CHALLENGE_INPUT = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response|cf-chl-widget|fc-token|arkose)/i
