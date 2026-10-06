import { ROUTES } from '../lib/fill-contract'
import type { AutoHost, Claim, ReportResponse, SessionResponse, StopCause } from '../lib/fill-contract'
import type { Hello, Outcome, Pending } from '../lib/messages'
import { send } from '../lib/messages'
import { isPaused } from '../lib/storage'
import { mountBar } from '../ui/bar'
import { errorCount, findSubmit, holdsAnAnswer, holdsValue } from './checks'
import { sensitivityOf } from './classify'
import { matchConfirmation, toPatterns } from './confirm-text'
import { detectBlockers, visibleChallenge } from './detect'
import { isVisible } from './dom'
import { holdSubmits } from './guard'
import { samePosting } from './hosts'
import { fieldsSignature, readFields, toInfo } from './read-fields'
import { readBack } from './readback'
import { api, applySession, report, sha256Text, snapshot } from './state'
import { watchPage } from './watch'

// Send for me, the page half. The server claimed this application and the worker
// opened this tab. Every stop hands the application back with its cause; the one
// click happens only after the server says go, and only once ever.

type Job = NonNullable<Hello['job']>

// The window to see the host's confirmation after the click: 30 s. A test build shortens it.
const CONFIRM_MS = Number((import.meta.env as Record<string, string | undefined>).WXT_CELLO_CONFIRM_MS) || 30_000

type Seen = { kind: 'confirmed'; text: string } | { kind: 'check' } | { kind: 'error' }

export async function runAuto(job: Job): Promise<void> {
  const { claim } = job
  const app = claim.application
  const bar = mountBar()
  const finish = (outcome: Outcome, keepOpen = false): Promise<unknown> =>
    send({ type: 'outcome', application: app, outcome, keepOpen })
  const stop = async (cause: StopCause, detail?: string, keepOpen = false): Promise<void> => {
    await report({ phase: 'blocked', application: app, url: location.href, cause, detail })
    if (keepOpen) bar.show({ text: 'Cello stopped here. Finish this application yourself.', tone: 'warn' })
    await finish('blocked', keepOpen)
  }
  bar.show({
    text: `Cello is sending your application to ${claim.company}.`,
    actions: [{ label: 'Pause Cello', onClick: () => void send({ type: 'pause' }) }],
  })

  let release: (() => void) | null = null
  try {
    const interrupted = (): Promise<void> => stop('interrupted')
    if (await isPaused()) return interrupted()

    const host = claim.hosts.find((h) => h.host === location.hostname)
    if (!host || !samePosting(location.href, claim.url, claim.hosts)) return stop('wrong_page')
    const first = detectBlockers(document, true)
    if (first) return stop(first.cause, undefined, first.cause === 'site_check')

    const fields = readFields()
    const form = fields.find((f) => f.form)?.form ?? null
    if (!form) return stop('form_changed')
    const info = toInfo(fields)
    const fieldsHash = await sha256Text(fieldsSignature(info))
    if (await isPaused()) return interrupted()

    const r = await api<SessionResponse>(ROUTES.session, { url: location.href, fields: info, auto: true, application: app })
    if (await isPaused()) return interrupted()
    // The server ended the claim itself (or could not be reached): nothing more to report.
    if (!r.ok || r.data.status !== 'ok') return void (await finish('abandoned'))
    const res = r.data
    if (res.fields_hash && res.fields_hash !== fieldsHash) return stop('form_changed')

    release = holdSubmits()
    const state = await applySession(res, fields)
    if (await isPaused()) return interrupted()

    if (state.fileMissing) return stop('upload')
    const consent = fields.find(
      (f) => f.required && sensitivityOf(f, state.categories[f.key]) === 'consent' && !state.filled.includes(f.key),
    )
    if (consent) return stop('unknown_field', 'consent')
    const missing = fields.find((f) => f.required && f.kind !== 'password' && !state.filled.includes(f.key))
    if (missing) return stop('unknown_field', missing.key)

    const pre = fields.find((f) => f.kind !== 'password' && f.kind !== 'file' && !(f.key in state.given) && holdsAnAnswer(f))
    if (pre) return stop('prefilled', pre.key)

    for (const [key, given] of Object.entries(state.given)) {
      const f = fields.find((x) => x.key === key)
      if (f && !holdsValue(f, given)) return stop('form_changed', key)
    }

    // Look again before the send: new required fields, a check, another page.
    const again = detectBlockers(document, true)
    if (again) return stop(again.cause, undefined, again.cause === 'site_check')
    if (!samePosting(location.href, claim.url, claim.hosts)) return stop('wrong_page')
    if ((await sha256Text(fieldsSignature(toInfo(readFields())))) !== fieldsHash) return stop('form_changed')

    const found = findSubmit(form, host.submit_labels)
    if (!found.ok) return stop('no_submit', found.reason)
    if (res.file && state.fileHashes[0] !== res.file.sha256) return stop('upload')

    const valuesHash = await sha256Text(JSON.stringify(Object.entries(state.given).sort(([a], [b]) => (a < b ? -1 : 1))))
    if (await isPaused()) return interrupted()
    const ready = await report({
      phase: 'ready_to_send',
      application: app,
      fields_hash: fieldsHash,
      values_hash: valuesHash,
      submit_label: found.label,
      file_hashes: state.fileHashes,
      final_url: location.href,
    })
    const go = ready.ok ? (ready.data as ReportResponse & { ok: true }) : null
    if (!go || !go.go || go.already_sent) return void (await finish('abandoned'))
    if (await isPaused()) return interrupted()

    // Never twice: the worker writes the mark before this click and refuses a second.
    if (!(await send<boolean>({ type: 'clicked', application: app }))) return void (await finish('abandoned'))
    const values = readBack(snapshot(state, form))
    const baseline = errorCount()
    release()
    release = null
    found.control.click()
    await report({ phase: 'submitted', application: app, auto: true, values, url: location.href })

    await conclude(claim, host, await watchAfter(host, found.control, baseline, CONFIRM_MS), finish, bar)
  } catch {
    await stop('interrupted').catch(() => undefined)
  } finally {
    release?.()
  }
}

function watchAfter(host: AutoHost, control: HTMLElement | null, baseline: number, ms: number): Promise<Seen | null> {
  const patterns = toPatterns(host.confirmation_patterns)
  const urls = toPatterns(host.confirmation_urls)
  return watchPage<Seen>(() => {
    const gone = !control || !control.isConnected || !isVisible(control)
    const t = matchConfirmation(document.body?.innerText ?? '', patterns)
    if ((t || urls.some((u) => u.test(location.href))) && gone) return { kind: 'confirmed', text: t ?? location.href }
    if (visibleChallenge()) return { kind: 'check' }
    if (errorCount() > baseline) return { kind: 'error' }
    return null
  }, ms)
}

async function conclude(
  claim: Claim,
  _host: AutoHost,
  seen: Seen | null,
  finish: (o: Outcome, keepOpen?: boolean) => Promise<unknown>,
  bar: ReturnType<typeof mountBar>,
): Promise<void> {
  const app = claim.application
  if (seen?.kind === 'confirmed') {
    // No screenshot on an automatic send.
    await report({ phase: 'confirmation', application: app, text: seen.text, url: location.href })
    await finish('sent')
    return
  }
  if (seen) {
    const cause: StopCause = seen.kind === 'check' ? 'site_check' : 'form_error'
    await report({ phase: 'blocked', application: app, url: location.href, cause })
    bar.show({ text: 'Cello stopped here. Check your application on this page.', tone: 'warn' })
    await finish('blocked', true)
    return
  }
  await report({ phase: 'unconfirmed', application: app, cause: 'no_confirmation' })
  bar.show({ text: 'Cello could not confirm this was sent. Check your application on this page.', tone: 'warn' })
  await finish('unconfirmed', true)
}

/** The page after the click: the same send, now waiting for the host's confirmation. */
export async function resumeAuto(job: Job, pending: Pending): Promise<void> {
  const claim = job.claim
  const host = claim.hosts.find((h) => h.host === location.hostname)
  const bar = mountBar()
  const finish = (outcome: Outcome, keepOpen = false): Promise<unknown> =>
    send({ type: 'outcome', application: claim.application, outcome, keepOpen })
  if (!host) {
    await report({ phase: 'unconfirmed', application: claim.application, cause: 'no_confirmation' })
    await finish('unconfirmed', true)
    return
  }
  bar.show({
    text: `Cello is sending your application to ${claim.company}.`,
    actions: [{ label: 'Pause Cello', onClick: () => void send({ type: 'pause' }) }],
  })
  const left = Math.max(1, CONFIRM_MS - (Date.now() - pending.since))
  await conclude(claim, host, await watchAfter(host, null, 0, left), finish, bar)
}
