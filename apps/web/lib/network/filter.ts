// Who counts as a person, decided by code from mail headers (blueprint 8, "People"). Five rules; an
// address that fails one is left out and counted under that rule, so "Cello left out 214 senders: 160
// automated, 38 bulk, 16 with no name" is true and Show them can list them.
//
//   1 automated   no Auto-Submitted other than "no"; a local part outside the robot and role list
//   2 bulk        no List-Id, List-Unsubscribe, or a Precedence of bulk, list or junk
//   3 relay       the host is not an applicant system, a job board or a mail relay; "Jane Doe via
//                 Greenhouse" is a relay's display name and makes nobody until a direct address appears
//   4 no name     a display name that is not the address, its local part, or role words only
//   5 human mail  a job thread, or a two-way thread whose other address is at a verified employer
//                 domain; a personal address is kept only from a job thread
//
// No model, no network: this file is pure so the same headers always give the same verdict.

import { isPersonalEmailDomain } from '@/lib/gmail/skip-lists'
import { isRelay } from '@/lib/gmail/trust'

/** D38-2 reads directive 38 as "kept apart"; 'drop' is the other reading, one word away. */
export const PERSONAL: 'apart' | 'drop' = 'apart'

export type LeftOutRule = 'automated' | 'bulk' | 'relay' | 'no_name' | 'not_human_mail'
export const RULE_LABEL: Record<LeftOutRule, string> = {
  automated: 'automated',
  bulk: 'bulk',
  relay: 'from a relay',
  no_name: 'with no name',
  not_human_mail: 'not about a job',
}

export interface MessageHeaders {
  /** The raw From value, "Name <a@b.c>". */
  from: string
  listId?: string
  listUnsubscribe?: string
  precedence?: string
  autoSubmitted?: string
}

export interface Candidate {
  email: string
  name: string | null
}

export type Verdict =
  | { keep: true; email: string; name: string; addressKind: 'employer' | 'personal'; domain: string }
  | { keep: false; email: string; rule: LeftOutRule }

const ROBOT_LOCALS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications', 'notification', 'notify', 'alerts', 'alert', 'mailer-daemon',
  'postmaster', 'bounce', 'bounces', 'jobs', 'careers', 'talent', 'recruiting', 'recruitment', 'hello', 'info', 'support', 'team',
  'hr', 'admin', 'help', 'contact', 'news', 'newsletter', 'updates', 'billing', 'accounts', 'apply', 'applications', 'hiring', 'people',
])
const ROBOT_LOCAL_RE = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|bounce[-_+.=]?.*|notifications?[-_+.=].*)$/

const ROLE_WORDS = new Set([
  'talent', 'team', 'recruiting', 'recruitment', 'careers', 'career', 'jobs', 'hr', 'hiring', 'people', 'support', 'noreply', 'reply',
  'notifications', 'recruiter', 'recruiters', 'staffing', 'acquisition', 'ops', 'operations', 'hello', 'info', 'inc', 'the', 'no',
  'do', 'not', 'at', 'via',
])

const words = (s: string) => s.toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean)

/** Parse one address from a header value ("Jane <j@x.com>" or "j@x.com"). Lowercases the address only. */
export function parseAddress(value: string): Candidate | null {
  const angle = value.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>\s]+@[^>\s]+)>\s*$/)
  const bare = value.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  const email = (angle ? angle[2] : bare?.[0])?.trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  const name = angle ? angle[1].replace(/\\"/g, '"').trim() : ''
  return { email, name: name || null }
}

/** Every address in a To or Cc value. A comma inside quotes ("Reed, Marcus" <m@x.com>) does not split. */
export function parseAddressList(value: string): Candidate[] {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if (ch === ',' && !quoted && !angle) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts.map(parseAddress).filter((c): c is Candidate => !!c)
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

/** "Jane Doe via Greenhouse" is the relay's name for a human; the name part before "via" is not an address of theirs. */
const isViaName = (name: string) => /\svia\s+\S+/i.test(name)

/** A name is a name when it is not the address, its local part, or role words only. */
export function hasName(name: string | null, email: string): boolean {
  if (!name) return false
  const n = name.trim()
  const local = email.split('@')[0]
  if (!n || n.toLowerCase() === email || n.toLowerCase() === local.toLowerCase() || n.includes('@')) return false
  const w = words(n)
  return w.length > 0 && !w.every((x) => ROLE_WORDS.has(x))
}

/** Rules 1 to 4 on one sender. `headers` are the message's own; for mail the person sent, pass none. */
export function judgeAddress(c: Candidate, headers?: Omit<MessageHeaders, 'from'>): { rule: LeftOutRule } | null {
  const local = c.email.split('@')[0]
  const auto = headers?.autoSubmitted?.trim().toLowerCase()
  if ((auto && auto !== 'no') || ROBOT_LOCALS.has(local) || ROBOT_LOCAL_RE.test(local)) return { rule: 'automated' }
  const prec = headers?.precedence?.trim().toLowerCase()
  if (headers?.listId || headers?.listUnsubscribe || (prec && ['bulk', 'list', 'junk'].includes(prec))) return { rule: 'bulk' }
  if (isRelay(domainOf(c.email)) || (c.name && isViaName(c.name))) return { rule: 'relay' }
  if (!hasName(c.name, c.email)) return { rule: 'no_name' }
  return null
}

export interface ThreadContext {
  /** K19 linked the thread to an application or a recruiter. */
  job: boolean
  /** The person wrote and this address wrote back. */
  twoWay: boolean
  /** The address's domain is a verified company_directory domain. */
  verifiedDomain: boolean
}

/** All five rules. A kept person carries whether the address is an employer's or a personal one. */
export function judge(c: Candidate, headers: Omit<MessageHeaders, 'from'> | undefined, ctx: ThreadContext): Verdict {
  const left = judgeAddress(c, headers)
  if (left) return { keep: false, email: c.email, rule: left.rule }
  const domain = domainOf(c.email)
  const personal = isPersonalEmailDomain(domain)
  const human = personal ? ctx.job && PERSONAL === 'apart' : ctx.job || (ctx.twoWay && ctx.verifiedDomain)
  if (!human) return { keep: false, email: c.email, rule: 'not_human_mail' }
  return { keep: true, email: c.email, name: c.name!.replace(/\s+/g, ' ').trim(), addressKind: personal ? 'personal' : 'employer', domain }
}

export type LeftOutCounts = Partial<Record<LeftOutRule, number>>

/** The sentence under Everyone: "Cello left out 214 senders: 160 automated, 38 bulk, 16 with no name." */
export function leftOutSentence(counts: LeftOutCounts): string | null {
  const parts = (Object.keys(RULE_LABEL) as LeftOutRule[]).filter((r) => (counts[r] ?? 0) > 0)
  const total = parts.reduce((s, r) => s + (counts[r] ?? 0), 0)
  if (total === 0) return null
  return `Cello left out ${total} sender${total === 1 ? '' : 's'}: ${parts.map((r) => `${counts[r]} ${RULE_LABEL[r]}`).join(', ')}.`
}
