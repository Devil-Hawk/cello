import { describe, expect, it } from 'vitest'
import { applyTailorPatch, keepsEntry, rankBulletsForJob } from './tailor'
import { ResumeSchema, type TailorPatch } from './schema'
import { CANONICAL_RESUME } from './test-fixtures'

const base = ResumeSchema.parse({
  ...CANONICAL_RESUME,
  skills: [
    { name: 'Languages', keywords: ['Go', 'TypeScript', 'C++'] },
    { name: 'Platforms', keywords: ['Google Cloud', 'Kafka'] },
  ],
  meta: { cello: { templateId: 'classic', sectionOrder: ['skills', 'work'] } },
})

const empty: TailorPatch = { summary: '', skills: [], work: [], projects: [] }
const patch = (over: Partial<TailorPatch>): TailorPatch => ({ ...empty, ...over })

describe('keepsEntry', () => {
  const before = ['Rebuilt the ingestion pipeline behind a dual-write migration.', 'Cut compute spend 48% by right-sizing the streaming tier.', 'Mentored four engineers.']
  it('lets an entry reorder and reword its own bullets', () => {
    expect(keepsEntry(before, [before[1], 'Rebuilt the ingestion pipeline with a dual-write migration.', before[2]])).toBe(true)
  })
  it('refuses another entry\'s bullets in place of its own', () => {
    expect(keepsEntry(before, ['An open-source CLI that diffs two Postgres query plans.', 'A Go library for typed feature flags.'])).toBe(false)
  })
})

describe('applyTailorPatch', () => {
  it('rewrites a summary and highlights that stay inside the base', () => {
    const { resume, warnings } = applyTailorPatch(
      base,
      patch({
        summary: 'Engineer with 8 years building data platforms.',
        work: [{ index: 0, highlights: ['Led a team of 6 engineers on data platforms.'] }],
      })
    )
    expect(resume.basics.summary).toBe('Engineer with 8 years building data platforms.')
    expect(resume.work[0].highlights).toEqual(['Led a team of 6 engineers on data platforms.'])
    expect(warnings).toEqual([])
  })

  it('cannot change identity: employers, titles, dates, education, template and order survive', () => {
    const { resume } = applyTailorPatch(
      base,
      patch({ work: [{ index: 0, highlights: ['Led a team of 6 engineers.'] }] })
    )
    expect(resume.work.map((w) => [w.name, w.position, w.startDate, w.endDate, w.current])).toEqual(
      base.work.map((w) => [w.name, w.position, w.startDate, w.endDate, w.current])
    )
    expect(resume.education).toEqual(base.education)
    expect(resume.basics.name).toBe(base.basics.name)
    expect(resume.meta.cello.templateId).toBe('classic')
    expect(resume.meta.cello.sectionOrder).toEqual(['skills', 'work'])
    expect(resume.meta.cello.structuredBy).toBe('tailor')
  })

  it('ignores an index that does not exist', () => {
    const { resume } = applyTailorPatch(base, patch({ work: [{ index: 9, highlights: ['Anything.'] }] }))
    expect(resume.work).toEqual(base.work)
  })

  it('reverts an entry that invents a fact, and says so', () => {
    const { resume, warnings } = applyTailorPatch(
      base,
      patch({ work: [{ index: 0, highlights: ['Directed 40 engineers at Initech.'] }] })
    )
    expect(resume.work[0].highlights).toEqual(base.work[0].highlights)
    expect(warnings[0]).toMatch(/dropped because they are not in your resume/)
    expect(warnings[0]).toMatch(/Initech/)
  })

  it('reverts an invented summary', () => {
    const { resume, warnings } = applyTailorPatch(base, patch({ summary: 'Former Director of Engineering at Google.' }))
    expect(resume.basics.summary).toBe(base.basics.summary)
    expect(warnings).toHaveLength(1)
  })

  describe('skills', () => {
    it('drops a keyword the base never mentions, with a warning', () => {
      const { resume, warnings } = applyTailorPatch(
        base,
        patch({ skills: [{ name: 'Languages', keywords: ['Go', 'kubernetes'] }] })
      )
      expect(resume.skills[0]).toEqual({ name: 'Languages', keywords: ['Go', 'TypeScript', 'C++'] })
      expect(resume.skills.flatMap((g) => g.keywords)).not.toContain('kubernetes')
      expect(warnings[0]).toMatch(/kubernetes/)
    })

    it('does not accept "Go" from inside "Google"', () => {
      const googleOnly = ResumeSchema.parse({
        basics: { name: 'Ada' },
        skills: [{ name: 'Cloud', keywords: ['Google Cloud'] }],
      })
      const { resume } = applyTailorPatch(googleOnly, patch({ skills: [{ name: 'Cloud', keywords: ['Go', 'Google Cloud'] }] }))
      expect(resume.skills[0].keywords).toEqual(['Google Cloud'])
      expect(resume.skills[0].keywords).not.toContain('Go')
    })

    it('keeps "C++" when the base has it', () => {
      const { resume } = applyTailorPatch(base, patch({ skills: [{ name: 'Languages', keywords: ['C++', 'Go'] }] }))
      expect(resume.skills[0].keywords).toEqual(['C++', 'Go', 'TypeScript'])
    })

    it('keeps a keyword that appears in the base as a whole token outside the skills list', () => {
      const { resume } = applyTailorPatch(base, patch({ skills: [{ name: 'Languages', keywords: ['engineers'] }] }))
      expect(resume.skills[0].keywords).toEqual(['engineers', 'Go', 'TypeScript', 'C++'])
    })

    it('renames an invented group to the base group at that position', () => {
      const { resume } = applyTailorPatch(base, patch({ skills: [{ name: 'Quantum', keywords: ['Go'] }] }))
      expect(resume.skills[0].name).toBe('Languages')
    })

    it('adds no group for a patch group left with no valid keywords', () => {
      const { resume } = applyTailorPatch(
        base,
        patch({ skills: [{ name: 'Languages', keywords: ['Go'] }, { name: 'Ops', keywords: ['terraform'] }] })
      )
      expect(resume.skills.map((g) => g.name)).toEqual(['Languages', 'Platforms'])
    })

    it('a partial skills patch keeps every base group and keyword it does not mention', () => {
      const { resume, warnings } = applyTailorPatch(base, patch({ skills: [{ name: 'Languages', keywords: ['Go'] }] }))
      expect(resume.skills).toEqual([
        { name: 'Languages', keywords: ['Go', 'TypeScript', 'C++'] },
        base.skills[1],
      ])
      expect(warnings).toEqual([])
    })

    it('reorders within a group: the patch order comes first', () => {
      const { resume } = applyTailorPatch(base, patch({ skills: [{ name: 'platforms', keywords: ['Kafka'] }] }))
      expect(resume.skills[1].keywords).toEqual(['Kafka', 'Google Cloud'])
    })

    it('keeps the base skills when the patch has none', () => {
      expect(applyTailorPatch(base, empty).resume.skills).toEqual(base.skills)
    })
  })
})

describe('rankBulletsForJob', () => {
  const resume = ResumeSchema.parse({
    ...base,
    work: [{ ...base.work[0], highlights: ['Mentored four engineers.', 'Cut compute spend by right-sizing the streaming tier.', 'Rebuilt the streaming ingestion pipeline and the streaming query tier.'] }],
  })
  it('moves the bullet that shares the most words with the posting to the top, and says why', () => {
    const r = rankBulletsForJob(resume, { title: 'Streaming Engineer', description: 'Own the streaming pipeline. The streaming tier and the pipeline tier are yours.' })
    expect(r.resume.work[0].highlights[0]).toMatch(/^Rebuilt the streaming/)
    expect([...r.resume.work[0].highlights].sort()).toEqual([...resume.work[0].highlights].sort())
    expect(r.changes[0]).toMatch(/shares .*streaming.* with the posting/)
  })
  it('leaves an entry alone when nothing matches better', () => {
    expect(rankBulletsForJob(resume, { title: 'Pastry Chef', description: '' }).changes).toEqual([])
  })
})
