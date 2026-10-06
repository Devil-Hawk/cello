// Profile in each state, rendered to a string (no jsdom, see components/resume/resume-workspace.test.tsx).

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CANONICAL_RESUME } from '@/lib/resume/test-fixtures'
import { resumeToMarkdown } from '@/lib/resume/render'
import { buildFacts } from './facts'
import { ProfileView, type ProfileViewProps } from './profile-view'
import { readIsShowable, TailorRead } from './tailor-read'
import type { VersionRow } from './versions'

const row = (n: number, over: Partial<VersionRow> = {}): VersionRow => ({
  id: `v${n}`,
  user_id: 'u',
  job_id: null,
  draft_id: null,
  version: n,
  title: null,
  content: 'Jordan Rivera',
  content_json: { resume: CANONICAL_RESUME, markdown: resumeToMarkdown(CANONICAL_RESUME) },
  ats_score: null,
  source: 'edited',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  role: null,
  sent: null,
  ...over,
})

const versions = (n: number) => Array.from({ length: n }, (_, i) => row(n - i))

function render(over: Partial<ProfileViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ProfileView, {
      facts: buildFacts({ fullName: 'Jordan Rivera', preferences: {}, resume: CANONICAL_RESUME, resumeLabel: 'Base resume', resumeAt: null, mail: false, model: null, emailCount: null }),
      versions: versions(3),
      fallbackText: '',
      targets: [],
      hasModel: true,
      onCorrect: async () => null,
      ...over,
    })
  )
}

const opens = (html: string) => (html.match(/aria-label="Open /g) ?? []).length

describe('ProfileView', () => {
  it('with no resume says how to add one and shows no editor, versions or health line', () => {
    const html = render({ versions: [], facts: [] })
    expect(html).toContain('Add your resume: paste it, or upload a PDF, Word file or photo.')
    expect(html).not.toContain('Edit resume')
    expect(html).not.toContain('>Versions<')
    expect(html).not.toContain('Too thin')
  })

  it('shows a resume saved only as text, with the thin line', () => {
    const html = render({ versions: [], fallbackText: 'Jordan Rivera\nEngineer' })
    expect(html).toContain('Edit resume')
    expect(html).toContain('3 words. Too thin for chance checks')
  })

  it('lists 0, 1, 25 and 26 versions, with Show all only past 25', () => {
    expect(render({ versions: versions(0) })).not.toContain('>Versions<')
    expect(opens(render({ versions: versions(1) }))).toBe(1)
    const at25 = render({ versions: versions(25) })
    expect(opens(at25)).toBe(25)
    expect(at25).not.toContain('Show all')
    const at26 = render({ versions: versions(26) })
    expect(opens(at26)).toBe(25)
    expect(at26).toContain('Show all 26 versions')
  })

  it('never shows a file name as a version label', () => {
    const html = render({ versions: [row(2, { title: 'Jordan Resume Final.pdf' }), row(1)] })
    expect(html).not.toContain('Jordan Resume Final.pdf')
  })

  it('refuses to delete a sent version, naming where it went, and the current base', () => {
    const sent = row(1, { id: 'old', sent: { at: '2026-10-04T10:00:00Z', company: 'Northwind Atlas' } })
    const html = render({ versions: [row(2), sent] })
    expect(html).toContain('This version was sent to Northwind Atlas. It stays with that application.')
    expect(html).toContain('This is your base resume. Edit it to make a new version.')
    expect(html).toContain('sent Oct 4')
  })

  it('names what Cello knows with each source, and the material line', () => {
    const html = render()
    expect(html).toContain('What Cello knows about you')
    expect(html).toContain('You set this')
    expect(html).toContain('From your resume, Base resume')
    expect(html).toContain('For letters and answers, not your resume.')
    expect(html).toContain('Learn more')
    expect(html).toContain('What your resume has no room for. Cello uses it in letters, answers and messages, and puts it on your resume only when you add it.')
  })

  it('keeps the first view inside five groups and ninety words a sentence', () => {
    const html = render()
    expect((html.match(/<details[^>]*class="group border-t/g) ?? []).length).toBeLessThanOrEqual(5)
    const intro = html.match(/<header>.*?<\/header>/)![0].replace(/<[^>]+>/g, ' ')
    expect(intro.trim().split(/\s+/).length).toBeLessThanOrEqual(90)
  })
})

describe('TailorRead', () => {
  const report = { atsScore: 62, matchedKeywords: ['Go'], missingKeywords: ['Kafka'], formatIssues: [], rescore: { atsScore: 81, matchedKeywords: [], missingKeywords: [], formatIssues: [] } }

  it('shows the number only beside its keywords', () => {
    const html = renderToStaticMarkup(createElement(TailorRead, { report }))
    expect(html).toContain('62 of 100 now, 81 after the rewrite')
    expect(html).toContain('Kafka')
    expect(html).toContain('Go')
  })

  it('shows no number when there is no evidence', () => {
    const bare = { ...report, matchedKeywords: [], missingKeywords: [] }
    expect(readIsShowable(bare)).toBe(false)
    const html = renderToStaticMarkup(createElement(TailorRead, { report: bare }))
    expect(html).not.toMatch(/\d+ of 100/)
    expect(html).toContain('no read of this resume')
  })
})
