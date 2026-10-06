import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dueAt, nextCheckAt, partialReadNote, rolesStatus, rolesStatusLine } from './roles-status'

const at = (iso: string) => Date.parse(iso)

describe('rolesStatus', () => {
  const now = at('2026-10-05T10:00:00Z')

  it('shows a count when there are open roles', () => {
    expect(rolesStatusLine(rolesStatus({}, 1, { now }))).toEqual({ text: '1 open role' })
    expect(rolesStatusLine(rolesStatus({}, 12, { now }))).toEqual({ text: '12 open roles' })
  })

  it('says it is checking now, never a bare zero', () => {
    expect(rolesStatusLine(rolesStatus({}, 0, { checking: true, now })).text).toBe('Checking now')
  })

  it('says when the next check is for a company never checked', () => {
    const line = rolesStatusLine(rolesStatus({ last_scraped_at: null }, 0, { now }))
    expect(line.text).toBe('Not checked yet, next check in about 3 h')
  })

  it('says a readable company has no open roles, and when it is checked next', () => {
    const company = { last_scraped_at: '2026-10-05T01:41:00Z' }
    const line = rolesStatusLine(rolesStatus(company, 0, { now }))
    expect(line.text).toMatch(/^No open roles right now, next check in about/)
  })

  it('says Cello cannot read the site, with the reason and a link to the careers page', () => {
    const company = {
      metadata: { source_check: { checked_at: '2026-10-05T01:41:00Z', readable: false, reason: 'no_supported_board' } },
      career_url: 'https://www.metacareers.com/jobs/',
    }
    const line = rolesStatusLine(rolesStatus(company, 0, { now }))
    expect(line.text).toBe("Cello can't read this careers site: its careers page is not on a job board Cello can read yet")
    expect(line.href).toBe('https://www.metacareers.com/jobs/')
  })

  it('has a generic reason for a code it does not know, and no link without a careers URL', () => {
    const company = { metadata: { source_check: { checked_at: '2026-10-05T01:41:00Z', readable: false, reason: 'future_code' } }, career_url: '' }
    const line = rolesStatusLine(rolesStatus(company, 0, { now }))
    expect(line.text).toBe("Cello can't read this careers site: it could not be read")
    expect(line.href).toBeUndefined()
  })

  it('says Cello is reading the site, and when the next check is, while only a browser can read it', () => {
    const company = { metadata: { source_check: { checked_at: '2026-10-05T10:00:00Z', readable: false, reason: 'reading' } }, career_url: 'https://jobs.example/' }
    expect(rolesStatusLine(rolesStatus(company, 0, { now }))).toEqual({ text: 'Cello is reading this site. Next check around 12:41 UTC' })
  })

  it('a page that was reached but not read because no free model was available says it is waiting, never "no open roles"', () => {
    for (const reason of ['model_unavailable', 'model_limit']) {
      const company = { metadata: { source_check: { checked_at: '2026-10-05T10:00:00Z', readable: false, reason } }, career_url: 'https://jobs.example/' }
      const line = rolesStatusLine(rolesStatus(company, 0, { now }))
      expect(line.text).toBe('Waiting for a free reading slot. Next check around 12:41 UTC')
      expect(line.text).not.toContain('no open roles')
    }
  })

  it('names why a site was not read: a bot check, a login, robots.txt, no roles, no answer', () => {
    const line = (reason: string) =>
      rolesStatusLine(rolesStatus({ metadata: { source_check: { checked_at: '2026-10-05T10:00:00Z', readable: false, reason } }, career_url: 'https://x.test/' }, 0, { now })).text
    expect(line('bot_check')).toContain('bot check')
    expect(line('login_required')).toContain('needs a login')
    expect(line('robots')).toContain('robots.txt')
    expect(line('no_roles')).toContain('no open roles were found')
    expect(line('unreachable')).toContain('did not answer')
  })

  it('ignores a malformed source_check', () => {
    expect(rolesStatus({ metadata: { source_check: 'x' } }, 0, { now }).kind).toBe('not_checked')
  })
})

describe('next check', () => {
  it('is the first scheduler tick (xx:41 of 00, 06, 12, 18 UTC) at or after the due time', () => {
    expect(new Date(nextCheckAt({ last_scraped_at: null }, at('2026-10-05T10:00:00Z'))).toISOString()).toBe('2026-10-05T12:41:00.000Z')
    expect(new Date(nextCheckAt({ last_scraped_at: null }, at('2026-10-05T12:30:00Z'))).toISOString()).toBe('2026-10-05T12:41:00.000Z')
    expect(new Date(nextCheckAt({ last_scraped_at: null }, at('2026-10-05T12:42:00Z'))).toISOString()).toBe('2026-10-05T18:41:00.000Z')
    expect(new Date(nextCheckAt({ last_scraped_at: null }, at('2026-10-05T23:00:00Z'))).toISOString()).toBe('2026-10-06T00:41:00.000Z')
  })

  it('waits for the tier interval: a dream company checked an hour ago goes at the next tick', () => {
    const dream = { is_dream_company: true, last_scraped_at: '2026-10-05T11:00:00Z' }
    expect(new Date(nextCheckAt(dream, at('2026-10-05T11:30:00Z'))).toISOString()).toBe('2026-10-05T12:41:00.000Z')
  })

  it('waits a day for an ordinary company', () => {
    const daily = { last_scraped_at: '2026-10-05T09:00:00Z' }
    expect(new Date(nextCheckAt(daily, at('2026-10-05T10:00:00Z'))).toISOString()).toBe('2026-10-06T12:41:00.000Z')
  })

  it('uses the later of the last scrape and the recorded check', () => {
    const c = { last_scraped_at: '2026-10-01T00:00:00Z', metadata: { source_check: { checked_at: '2026-10-05T09:00:00Z', readable: false } } }
    expect(dueAt(c)).toBe(at('2026-10-05T09:00:00Z') + (1440 - 5) * 60_000)
  })

  it('a user-set frequency can stretch it but never go below the tier', () => {
    expect(dueAt({ last_scraped_at: '2026-10-05T00:00:00Z', scrape_frequency: 1 })).toBe(at('2026-10-05T00:00:00Z') + 1435 * 60_000)
    expect(dueAt({ last_scraped_at: '2026-10-05T00:00:00Z', scrape_frequency: 3000 })).toBe(at('2026-10-05T00:00:00Z') + 2995 * 60_000)
  })

  it('is due at once when never checked', () => {
    expect(dueAt({})).toBe(0)
  })

  it('matches the cron in the workflow, so the promised time is real', () => {
    const yml = readFileSync(path.resolve(__dirname, '../../../../.github/workflows/scrape.yml'), 'utf8')
    expect(yml).toContain("- cron: '41 */6 * * *'")
  })
})

describe('partialReadNote: a part of a big site never looks like the whole', () => {
  const reader = (r: Record<string, unknown>) => ({ reader: r })

  it('says how much was read of how much the site lists', () => {
    expect(partialReadNote(reader({ listed: 1075, read: 19 }), 19)).toBe('Read 19 of about 1,075 roles so far. More each check.')
  })

  it('says so when the list names no titles', () => {
    expect(partialReadNote(reader({ listed: 15989, read: 60, untitled: true }), 3)).toBe(
      'Read 60 of about 15,989 roles so far. Its list names no titles, so Cello reads the roles in turn, more each check.'
    )
  })

  it('says nothing once the whole list is read, and nothing for a company with no roles shown', () => {
    expect(partialReadNote(reader({ listed: 40, read: 40 }), 12)).toBeNull()
    expect(partialReadNote(reader({ listed: 1075, read: 19 }), 0)).toBeNull()
  })

  it('a window onto a site (its search or a few pages) says it is a window', () => {
    expect(partialReadNote(reader({ window: true }), 10)).toBe('Showing the newest roles Cello matched on this site, not every role it lists.')
  })

  it('says nothing about a whole board, or when nothing is recorded', () => {
    expect(partialReadNote(reader({ tier: 'board' }), 10)).toBeNull()
    expect(partialReadNote({}, 10)).toBeNull()
    expect(partialReadNote(null, 10)).toBeNull()
  })
})
