// The record after acting: the one button per state, a stage suggestion that waits for Confirm, the person's note
// beside the Gmail sync's JSON, and the groups on fixtures (offer, closed, sent with an attempt).

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))

import { buttonsFor, changedLines, localInput, readNote, stageSuggestion, writeNote, type AppFacts } from './logic'
import { ApplicationPanel, type ApplicationPanelProps } from './application'
import { DocumentsPanel, type DocsBundle } from './documents'
import type { AppBundle } from './data'
import type { ApplicationAttempt } from '@/lib/applications/types'

const html = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/<!-- -->/g, '')

const facts = (over: Partial<AppFacts> = {}): AppFacts => ({ id: 'a1', stage: 'applied', state: null, needs_reason: null, closed_reason: null, jobUrl: 'https://jobs.example.com/1', company: 'Stripe', ...over })

describe('the one button', () => {
  it('ready: open on the site, then Mark as sent', () => {
    expect(buttonsFor(facts({ state: 'ready' })).map((b) => b.label)).toEqual(["Open on Stripe's site", 'Mark as sent'])
  })
  it('needs you, by reason', () => {
    expect(buttonsFor(facts({ state: 'needs_you', needs_reason: 'approve_resume' }))[0]).toMatchObject({ label: 'Review resume' })
    expect(buttonsFor(facts({ state: 'needs_you', needs_reason: 'check_sent' })).map((b) => b.label)).toEqual(['Yes, sent', 'Not yet'])
    expect(buttonsFor(facts({ state: 'needs_you', needs_reason: 'your_turn' }))[0]).toMatchObject({ label: "Open on Stripe's site" })
    expect(buttonsFor(facts({ state: 'needs_you', needs_reason: 'wait_computer' }))).toEqual([])
  })
  it('paused resumes, skipped undoes, and a closed application has none', () => {
    expect(buttonsFor(facts({ state: 'paused' }))[0]).toMatchObject({ label: 'Resume', action: 'resume' })
    expect(buttonsFor(facts({ state: 'skipped' }))[0]).toMatchObject({ label: 'Undo' })
    expect(buttonsFor(facts({ state: 'ready', closed_reason: 'rejected' }))).toEqual([])
  })
  it('never sends: Mark as sent is a post the person presses, not a link', () => {
    expect(buttonsFor(facts({ state: 'ready' })).find((b) => b.label === 'Mark as sent')).toMatchObject({ kind: 'post', action: 'mark-sent' })
  })
})

describe('a stage suggestion', () => {
  const mail = (kind: string) => ({ id: 'm1', kind, sent_at: '2026-10-01T10:00:00Z', from: 'Stripe' })
  it('offers the stage the newest mail points to and waits for Confirm', () => {
    expect(stageSuggestion('applied', mail('interview'))).toMatchObject({ stage: 'interview', messageId: 'm1' })
    expect(stageSuggestion('interview', mail('offer'))).toMatchObject({ stage: 'offer' })
    expect(stageSuggestion('applied', mail('rejection'))).toMatchObject({ stage: 'rejected' })
  })
  it('says nothing when the stage is there or further along, or the mail says nothing', () => {
    expect(stageSuggestion('interview', mail('interview'))).toBeNull()
    expect(stageSuggestion('offer', mail('interview'))).toBeNull()
    expect(stageSuggestion('applied', mail('recruiter'))).toBeNull()
    expect(stageSuggestion('applied', null)).toBeNull()
    expect(stageSuggestion('rejected', mail('interview'))).toBeNull()
  })
})

describe('notes', () => {
  const sync = JSON.stringify({ threadUrl: 'https://mail.google.com/x', subject: 'Hello' })
  it('keeps the Gmail sync\'s keys when the person writes a note, and reads it back', () => {
    const saved = writeNote(sync, 'Spoke to Marcus')!
    expect(JSON.parse(saved)).toEqual({ threadUrl: 'https://mail.google.com/x', subject: 'Hello', note: 'Spoke to Marcus' })
    expect(readNote(saved)).toBe('Spoke to Marcus')
    expect(readNote(sync)).toBe('')
  })
  it('clears the note without losing the sync\'s keys, and plain text is replaced', () => {
    expect(JSON.parse(writeNote(writeNote(sync, 'x'), '')!)).toEqual({ threadUrl: 'https://mail.google.com/x', subject: 'Hello' })
    expect(writeNote('old plain note', 'new')).toBe('new')
    expect(writeNote(null, '  ')).toBeNull()
    expect(readNote('old plain note')).toBe('old plain note')
  })
  it('reads an interview date as a local input value, and nothing as empty', () => {
    expect(localInput(null)).toBe('')
    expect(localInput('not a date')).toBe('')
    expect(localInput('2026-10-08T14:00:00Z')).toMatch(/^2026-10-0[78]T\d\d:\d\d$/)
  })
})

const bundle = (over: Partial<AppBundle['app']> = {}, extra: Partial<AppBundle> = {}): AppBundle => ({
  app: { id: 'a1', stage: 'applied', state: 'sent', step: null, needs_reason: null, needs_detail: null, applied_at: '2026-10-01T10:00:00Z', closed_reason: null, interview_at: null, instruction: null, notes: null, jobs: { title: 'Staff Engineer', url: 'https://jobs.example.com/1', companies: { name: 'Stripe' } }, ...over },
  timeline: [{ id: 'e1', kind: 'submission.sent', actor: 'person', actor_label: null, channel: 'session', step: null, sentence: 'You marked it sent.', from_state: 'ready', to_state: 'sent', trust: 'person', cost_usd: 0.04, model_calls: 3, free_model: false, created_at: '2026-10-01T10:00:00Z' }],
  mail: null,
  ...extra,
})
const props = (b: AppBundle, over: Partial<ApplicationPanelProps> = {}): ApplicationPanelProps => ({ bundle: b, jobId: 'j1', dismissed: [], onButton: () => undefined, onStage: () => undefined, onDismiss: () => undefined, onInterview: () => undefined, onInstruction: () => undefined, onNotes: () => undefined, ...over })

describe('the Application group', () => {
  it('shows the status sentence, the interview date, the instruction, notes and the timeline with who and what Cello did', () => {
    const out = html(<ApplicationPanel {...props(bundle())} />)
    for (const text of ['Sent.', 'Interview date and time', 'Your instruction for this application (optional)', 'Notes. Cello never reads these as instructions.', 'Timeline', 'You marked it sent.', 'Show what Cello did', '$0.04']) expect(out).toContain(text)
  })
  it('offers a suggested stage with Confirm, and hides it once dismissed', () => {
    const b = bundle({}, { mail: { id: 'm1', kind: 'interview', sent_at: '2026-10-02T10:00:00Z', from: 'stripe.com' } })
    const out = html(<ApplicationPanel {...props(b)} />)
    expect(out).toContain('Stripe sent an invitation to talk. Move this to Interview?')
    expect(out).toContain('>Confirm<')
    expect(html(<ApplicationPanel {...props(b, { dismissed: ['m1'] })} />)).not.toContain('Move this to Interview?')
  })
  it('at an offer, Prepare to negotiate opens Chat with this application attached', () => {
    const out = html(<ApplicationPanel {...props(bundle({ stage: 'offer' }))} />)
    expect(out).toContain('Prepare to negotiate')
    expect(out).toContain('about=application%3Aa1')
  })
  it('closed: says why, and what Cello took from it when a learning used it', () => {
    const out = html(<ApplicationPanel {...props(bundle({ closed_reason: 'rejected' }), { took: ['2 of 9 applications from referrals got a reply'] })} />)
    expect(out).toContain('Closed: Not selected.')
    expect(out).toContain('What Cello took from this')
    expect(out).toContain('2 of 9 applications from referrals got a reply')
    expect(html(<ApplicationPanel {...props(bundle({ closed_reason: 'rejected' }))} />)).not.toContain('What Cello took from this')
  })
})

const attempt = (over: Partial<ApplicationAttempt> = {}): ApplicationAttempt =>
  ({ id: 't1', applicationId: 'a1', submittedAt: '2026-10-01T10:00:00Z', destination: 'Stripe Greenhouse', finalUrl: null, resumeArtifactId: 'r1', resumeArtifactVersion: 3, coverLetterArtifactId: null, valuesSent: { first_name: 'Dana', work_auth: { answered_by_you: true } }, confirmationText: 'Thanks for applying to Stripe.', screenshotPath: 'p.png', attemptOutcome: 'sent', sentBy: 'cello', costUsd: 0.02, ...over }) as ApplicationAttempt

const docs: DocsBundle = {
  applicationId: 'a1',
  base: 'Dana Lee\nBackend engineer\nBuilt payments',
  attempts: [attempt()],
  docs: [
    { id: 'r1', type: 'resume', title: 'Resume for Stripe', current_version: 3, created_at: '2026-09-30T10:00:00Z', version: { version: 3, author: 'cello', content_text: 'Dana Lee\nPayments engineer\nBuilt payments', note: 'Led with payments work, because the posting asks for it.', review: { passed: true, issues: [], checked_by: 'Checked by code only' } } },
    { id: 'l1', type: 'cover_letter', title: 'Letter to Stripe', current_version: 1, created_at: '2026-09-30T10:00:00Z', version: { version: 1, author: 'cello', content_text: 'Hello Stripe team.', note: null, review: null } },
  ],
}

describe('the Documents group', () => {
  it('shows the resume version with why it was made, how it was checked and Compare, and the letter', () => {
    const out = html(<DocumentsPanel bundle={docs} onNotSent={() => undefined} />)
    for (const text of ['Resume for Stripe, version 3', 'Why this version: Led with payments work', 'Checked by code only. Nothing flagged.', 'Compare to your base resume', 'Letter to Stripe', 'Read it']) expect(out).toContain(text)
  })
  it('folds each attempt under what was sent: who, where, the version, the site\'s words, the cost, the answers and a way to say it was not sent', () => {
    const out = html(<DocumentsPanel bundle={docs} onNotSent={() => undefined} />)
    for (const text of ['What was sent', 'Cello sent it from your browser', 'The site confirmed it. Stripe Greenhouse', 'Resume version 3', '$0.02', 'Thanks for applying to Stripe.', 'Answers used (2)', 'first name: ', 'Dana', 'Answered by you', 'I did not actually send this']) expect(out).toContain(text)
  })
  it('offers no way to retract an attempt that never went out', () => {
    expect(html(<DocumentsPanel bundle={{ ...docs, attempts: [attempt({ attemptOutcome: 'blocked' })] }} onNotSent={() => undefined} />)).not.toContain('I did not actually send this')
  })
  it('renders nothing when there is nothing', () => {
    expect(html(<DocumentsPanel bundle={{ applicationId: null, docs: [], base: null, attempts: [] }} onNotSent={() => undefined} />)).toBe('')
  })
})

describe('Compare', () => {
  it('lists only the lines that changed, with counts', () => {
    const c = changedLines(docs.base!, docs.docs[0].version!.content_text)
    expect(c.lines.map((l) => `${l.type}:${l.text}`)).toEqual(['remove:Backend engineer', 'add:Payments engineer'])
    expect([c.added, c.removed]).toEqual([1, 1])
  })
})
