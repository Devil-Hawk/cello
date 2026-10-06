import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scoreS21, type S21Case } from './score'

const evidence = {
  'role:Ramp': 'Pay as stated: $150,000 to $180,000. Posted Oct 5.',
  'role:Stripe': 'Pay as stated: $120,000. Posted Oct 9.',
}
const good: S21Case = {
  id: 'good',
  expected: [['role:Ramp'], ['role:Stripe']],
  evidence,
  answer: [
    { about: ['role:Ramp'], text: 'Ramp pays $150,000 to $180,000.' },
    { about: ['role:Stripe'], text: 'Stripe pays $120,000.' },
  ],
}

describe('scoreS21', () => {
  it('passes parts that name the right objects with their own facts', () => {
    expect(scoreS21([good])).toEqual({ parts: 2, right: 2, share: 1, wrongObjectFacts: 0, passed: true })
  })

  it('counts a part about the wrong object as not right', () => {
    const wrong: S21Case = { ...good, answer: [{ about: ['role:Stripe'], text: 'Stripe pays $120,000.' }, { about: ['role:Ramp', 'role:Stripe'], text: 'Both are listed.' }] }
    expect(scoreS21([wrong])).toMatchObject({ parts: 2, right: 1, share: 0.5, passed: false })
  })

  it('counts a fact that belongs to the other object, and fails the run for it', () => {
    const moved: S21Case = { ...good, answer: [{ about: ['role:Ramp'], text: 'Ramp pays $150,000 to $180,000, posted Oct 9.' }, good.answer[1]] }
    expect(scoreS21([moved])).toMatchObject({ right: 2, wrongObjectFacts: 1, passed: false })
  })

  it('does not call an invented fact a wrong-object fact, and has no pass without parts', () => {
    const invented: S21Case = { ...good, answer: [{ about: ['role:Ramp'], text: 'Ramp pays $999,999.' }] }
    expect(scoreS21([invented]).wrongObjectFacts).toBe(0)
    expect(scoreS21([]).passed).toBe(false)
  })

  it('allows 1 part in 20 to be off and no more', () => {
    const many: S21Case = { id: 'many', expected: [['role:Ramp']], evidence, answer: Array.from({ length: 20 }, (_, i) => ({ about: i === 0 ? ['role:Stripe'] : ['role:Ramp'], text: 'A line.' })) }
    expect(scoreS21([many])).toMatchObject({ share: 0.95, passed: true })
    expect(scoreS21([{ ...many, answer: many.answer.slice(0, 10) }])).toMatchObject({ share: 0.9, passed: false })
  })
})

describe('the drafted cases', () => {
  const s21 = JSON.parse(readFileSync(path.join(__dirname, 's21.cases.json'), 'utf8')) as { cases: { id: string; attached: string[]; expected: string[][] }[] }
  const injection = JSON.parse(readFileSync(path.join(__dirname, 'injection.cases.json'), 'utf8')) as { cases: { id: string; forbidden: string[] }[] }

  it('are ten asks over 2 to 6 attached things, each part labelled with things that are attached', () => {
    expect(s21.cases).toHaveLength(10)
    for (const c of s21.cases) {
      expect(c.attached.length, c.id).toBeGreaterThanOrEqual(2)
      expect(c.attached.length, c.id).toBeLessThanOrEqual(6)
      for (const about of c.expected.flat()) expect(c.attached, `${c.id}: ${about}`).toContain(about)
    }
  })

  it('give the injection set a case for each place words can hide, every one with a forbidden or required outcome', () => {
    const channels = new Set((injection.cases as unknown as { channel: string }[]).map((c) => c.channel))
    expect([...channels].sort()).toEqual(['attached_chat', 'made_text', 'quoted', 'tool_result'])
    for (const c of injection.cases) expect(Object.keys(c).length, c.id).toBeGreaterThan(3)
  })

  it('give S22 ten recall pairs, each naming the earlier item that must come back', () => {
    const s22 = JSON.parse(readFileSync(path.join(__dirname, 's22.cases.json'), 'utf8')) as { pairs: { id: string; later: string; expect: { item: string } }[] }
    expect(s22.pairs).toHaveLength(10)
    for (const p of s22.pairs) {
      expect(['said', 'comparison', 'decided'], p.id).toContain(p.expect.item)
      expect(p.later.length, p.id).toBeGreaterThan(10)
    }
  })
})
