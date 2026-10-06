// What kind of question a field asks, by the words on its label. Patterns first; the rest (category
// "other") may go to a free model that returns a category and never an answer
// (answers.categorize, K11). The order matters: the sensitive categories are tested first, so a
// question that is both (consent to a salary check) lands in the stricter one.

export const CATEGORIES = [
  'contact', 'links', 'work_auth', 'sponsorship', 'relocation', 'location', 'start_date', 'notice',
  'salary', 'education', 'experience', 'eeo', 'consent', 'motivation', 'other',
] as const
export type Category = (typeof CATEGORIES)[number]

/** Categories whose answers are never matched by similarity and never guessed. */
export const SENSITIVE: readonly Category[] = ['work_auth', 'sponsorship', 'salary', 'eeo', 'consent']

const PATTERNS: [Category, RegExp][] = [
  ['eeo', /\b(gender|race|racial|ethnic\w*|hispanic|latino|veteran|disabilit\w*|sexual orientation|transgender|pronouns?|self[- ]identif\w*|protected class)\b/i],
  ['consent', /\b(i agree|i consent|consent to|i acknowledge|acknowledge that|i certify|certify that|i understand that|privacy (policy|notice)|terms (of|and)|data processing|gdpr|attest|opt[- ]in)\b/i],
  ['sponsorship', /\bsponsor\w*|\bvisa\b/i],
  ['work_auth', /\b(authori[sz]ed|authori[sz]ation|legally (entitled|allowed|eligible)|right to work|eligible to work|work permit|work eligibility)\b/i],
  ['salary', /\b(salary|compensation|pay (expectation|range)|expected pay|desired pay|hourly rate|rate expectation|ote)\b/i],
  ['relocation', /\brelocat\w*/i],
  ['notice', /\bnotice period\b/i],
  ['start_date', /\b(start date|available to start|earliest (start|date)|when can you start|date available|availability date)\b/i],
  ['links', /\b(linkedin|github|gitlab|portfolio|personal (website|site)|website|blog|twitter|url|link to)\b/i],
  ['contact', /\b(first name|last name|full name|legal name|preferred name|your name|email|e-mail|phone|mobile|telephone)\b/i],
  ['education', /\b(degree|university|college|school|graduat\w*|gpa|major|field of study|education)\b/i],
  ['experience', /\b(years? of|experience (with|in)|how many years|proficien\w*)\b/i],
  ['location', /\b(where are you (located|based)|current (city|location)|city|country|time zone|timezone|on[- ]?site|in[- ]office|hybrid|remote)\b/i],
  ['motivation', /\b(why (do|are|would)|what (excites|interests|draws|motivates)|tell us (about|why)|cover letter|in your own words|describe (a|your|how)|what makes you)\b/i],
]

export function categorize(question: string): Category {
  for (const [category, re] of PATTERNS) if (re.test(question)) return category
  return 'other'
}

export const isSensitive = (c: Category): boolean => SENSITIVE.includes(c)

const MONTH = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)'
const NUMBER_OR_DATE = new RegExp(
  [
    '\\d', // any digit: 3 days, 5 days, $120k, June 1
    `\\b${MONTH}\\b`,
    '\\b(usd|gbp|eur|cad|aud|inr)\\b',
    '[$£€]',
    '\\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\\s+(days?|weeks?|months?|years?)\\b',
    '\\b(monday|tuesday|wednesday|thursday|friday)\\b',
  ].join('|'),
  'i',
)
// "to Austin", "in London", "at Stripe", "for Acme": a capitalised name after a preposition, past the first word.
const NAMED = /\b(?:to|in|at|for|with|from|near|around)\s+(?:the\s+)?(?:[A-Z][\w&.-]*)/

/** The question names a place, a company, a number of days, a date or an amount. Never matched by similarity. */
export function isSpecific(question: string): boolean {
  if (NUMBER_OR_DATE.test(question)) return true
  // look for a capital only after the first word, so "Are you ..." is not a name
  const rest = question.replace(/^\s*\S+\s+/, '')
  return NAMED.test(rest)
}

/** A field's kind by its label and the options it shows. */
export type FieldKind = 'text' | 'long_text' | 'yes_no' | 'select' | 'multi_select' | 'number' | 'date' | 'file'

// --- work authorization ----------------------------------------------------
// The person gives two facts once (authorized to work, needs sponsorship). Code maps the wordings it
// knows to a fact and a polarity; anything else is an open question, never a model's guess.

export interface WorkFacts {
  authorized: boolean | null
  needsSponsorship: boolean | null
}

/** yes or no for a wording code knows, or null when it does not (the field is then an open question). */
export function workAuthAnswer(question: string, facts: WorkFacts): boolean | null {
  const q = question.toLowerCase()
  const sponsor = /\bsponsor\w*|\bvisa\b/.test(q)
  const without = /\b(without|not (need|require)|no) (any )?(visa )?(sponsorship|sponsor)/.test(q)
  const authorized = /\b(authori[sz]ed|legally (entitled|allowed|eligible)|right to work|eligible to work|work permit)\b/.test(q)
  const requires = /\b(require|need)\b/.test(q)
  if (authorized && without) {
    if (facts.authorized === null || facts.needsSponsorship === null) return null
    return facts.authorized && !facts.needsSponsorship
  }
  if (sponsor && requires && !authorized) return facts.needsSponsorship
  if (authorized && !sponsor) return facts.authorized
  return null
}
