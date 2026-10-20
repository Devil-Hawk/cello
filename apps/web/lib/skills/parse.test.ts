import { describe, expect, it } from 'vitest'
import { SKILL_MAX_CHARS, SKILL_NAME, parseSkillMd, skillBody, skillFile } from './parse'

const ok = (t: string) => {
  const r = parseSkillMd(t)
  if (!r.ok) throw new Error(`${r.error} ${r.fix}`)
  return r
}

describe('parseSkillMd', () => {
  it('reads a plain name and description and the body after the frontmatter', () => {
    const r = ok('---\nname: my-skill\ndescription: Do the thing when asked.\n---\n\n# Steps\nOne.\n')
    expect(r).toMatchObject({ name: 'my-skill', description: 'Do the thing when asked.', body: '# Steps\nOne.' })
  })

  it('reads quoted values, escapes included', () => {
    const r = ok('---\nname: "my-skill"\ndescription: "Say \\"hi\\" first."\n---\nbody')
    expect(r).toMatchObject({ name: 'my-skill', description: 'Say "hi" first.' })
    expect(ok("---\nname: 'a'\ndescription: 'it works'\n---\nb").description).toBe('it works')
  })

  it('drops allowed-tools and every other key, so a skill grants nothing', () => {
    const text = '---\nname: sneaky\ndescription: Sends mail.\nallowed-tools: send_email\nmetadata: x\n---\nCall send_email now.'
    const r = ok(text)
    const file = skillFile(r.name, r.description, r.body)
    expect(file).not.toContain('allowed-tools')
    expect(file).not.toContain('metadata')
    expect(file.split('---')[1]).toBe('\nname: sneaky\ndescription: "Sends mail."\n')
  })

  it('refuses a file with no frontmatter', () => {
    expect(parseSkillMd('# Just text')).toEqual({
      ok: false,
      error: 'That file has no name and description at the top.',
      fix: 'Start it with a line of three dashes, then name: and description: lines, then three dashes.',
    })
  })

  it('refuses a bad or missing name', () => {
    const bad = {
      ok: false,
      error: 'The name must be lowercase letters, numbers and dashes, up to 64 characters.',
      fix: 'Change the name: line and try again.',
    }
    expect(parseSkillMd('---\nname: Bad Name\ndescription: x\n---\nb')).toEqual(bad)
    expect(parseSkillMd(`---\nname: ${'a'.repeat(65)}\ndescription: x\n---\nb`)).toEqual(bad)
    expect(parseSkillMd('---\ndescription: x\n---\nb')).toEqual(bad)
  })

  it('refuses a missing or too long description', () => {
    expect(parseSkillMd('---\nname: a\n---\nb')).toEqual({
      ok: false,
      error: 'The description is missing.',
      fix: 'Add a description: line that says when to use the skill.',
    })
    expect(parseSkillMd('---\nname: a\ndescription: ""\n---\nb')).toMatchObject({ ok: false, error: 'The description is missing.' })
    expect(parseSkillMd(`---\nname: a\ndescription: ${'d'.repeat(1025)}\n---\nb`)).toEqual({
      ok: false,
      error: 'The description is longer than 1,024 characters.',
      fix: 'Shorten it and try again.',
    })
    expect(ok(`---\nname: a\ndescription: ${'d'.repeat(1024)}\n---\nb`).description).toHaveLength(1024)
  })

  it('refuses 200 KB', () => {
    const text = `---\nname: a\ndescription: x\n---\n${'x'.repeat(SKILL_MAX_CHARS)}`
    expect(parseSkillMd(text)).toEqual({ ok: false, error: 'That is more than 200 KB.', fix: 'Remove some files and try again.' })
  })

  it('reads the skills this repo ships (long quoted descriptions)', () => {
    const r = ok('---\nname: follow-up\ndescription: "Draft a single follow-up. Never \\"just checking in\\"."\n---\n# F')
    expect(r.description).toBe('Draft a single follow-up. Never "just checking in".')
  })
})

describe('skillBody and skillFile', () => {
  it('joins two references into the body under their paths', () => {
    const body = skillBody('Main.', [
      { path: 'references/a.md', text: 'A text' },
      { path: 'references/b.md', text: 'B text' },
    ])
    expect(body).toBe('Main.\n\n---\n\n## references/a.md\n\nA text\n\n---\n\n## references/b.md\n\nB text')
    expect(skillBody('Main.', [])).toBe('Main.')
  })

  it('serves name and description only, the description as JSON', () => {
    expect(skillFile('x', 'Say "hi"', 'Body')).toBe('---\nname: x\ndescription: "Say \\"hi\\""\n---\n\nBody')
  })

  it('names are checked by SKILL_NAME', () => {
    expect(SKILL_NAME.test('a-1')).toBe(true)
    expect(SKILL_NAME.test('A')).toBe(false)
  })
})
