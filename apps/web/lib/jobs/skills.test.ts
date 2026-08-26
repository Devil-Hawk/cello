import { describe, expect, it } from 'vitest'
import { extractSkillsFromText } from './skills'

describe('extractSkillsFromText', () => {
  it('finds known skills across categories', () => {
    const skills = extractSkillsFromText('Requirements: 5+ years of TypeScript, React, and PostgreSQL. AWS a plus.')
    const names = skills.map((s) => s.name)
    expect(names).toContain('typescript')
    expect(names).toContain('react')
    expect(names).toContain('postgresql')
  })

  it('marks a skill in the requirements section as required', () => {
    const skills = extractSkillsFromText('Requirements: Python experience required. Nice to have: Kubernetes.')
    const python = skills.find((s) => s.name === 'python')
    const k8s = skills.find((s) => s.name === 'kubernetes')
    expect(python?.required).toBe(true)
    expect(k8s?.required).toBe(false)
  })

  it('does not double-count a skill mentioned in both sections', () => {
    const skills = extractSkillsFromText('Requirements: Python. Nice to have: Python for scripting.')
    expect(skills.filter((s) => s.name === 'python')).toHaveLength(1)
  })

  it('finds a soft skill by exact phrase', () => {
    const skills = extractSkillsFromText('We value strong communication and teamwork.')
    expect(skills.map((s) => s.name)).toEqual(expect.arrayContaining(['communication', 'teamwork']))
  })
})
