// Skill files a person adds. Pure, no node imports, so a page can check a file before it is sent.
// A skill grants nothing: only name and description survive, so an allowed-tools line or any other key
// never reaches the engine. What the engine serves is built by skillFile, not copied from the upload.

export const SKILL_NAME = /^[a-z0-9-]{1,64}$/
export const SKILL_MAX_CHARS = 200_000
const DESCRIPTION_MAX = 1024

export type ParsedSkill = { ok: true; name: string; description: string; body: string } | { ok: false; error: string; fix: string }

const fail = (error: string, fix: string): ParsedSkill => ({ ok: false, error, fix })

/** A frontmatter value: plain, "double quoted" (JSON escapes) or 'single quoted'. */
function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v))
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** Reads the frontmatter's name and description (quoted or plain) and drops every other key (allowed-tools included). body = the text after the frontmatter. */
export function parseSkillMd(text: string): ParsedSkill {
  if (text.length > SKILL_MAX_CHARS) return fail('That is more than 200 KB.', 'Remove some files and try again.')
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return fail('That file has no name and description at the top.', 'Start it with a line of three dashes, then name: and description: lines, then three dashes.')
  const found: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description)[ \t]*:(.*)$/.exec(lines[i])
    if (!kv) continue
    let value = kv[2].trim()
    // A block value (description: > or |) is the indented lines that follow.
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) block.push(lines[++i].trim())
      value = block.join(value.startsWith('>') ? ' ' : '\n')
    } else value = unquote(value)
    found[kv[1]] = value
  }
  const name = found.name ?? ''
  if (!SKILL_NAME.test(name)) return fail('The name must be lowercase letters, numbers and dashes, up to 64 characters.', 'Change the name: line and try again.')
  const description = found.description ?? ''
  if (!description) return fail('The description is missing.', 'Add a description: line that says when to use the skill.')
  if (description.length > DESCRIPTION_MAX) return fail('The description is longer than 1,024 characters.', 'Shorten it and try again.')
  return { ok: true, name, description, body: text.slice(m[0].length).trim() }
}

/** The stored body: the SKILL.md body, then each reference as "\n\n---\n\n## <path>\n\n<text>". ponytail: references live inside body, a refs column if a skill ever needs separate files. */
export function skillBody(main: string, references: { path: string; text: string }[]): string {
  return main + references.map((r) => `\n\n---\n\n## ${r.path}\n\n${r.text}`).join('')
}

/** The served file: name and description only. */
export function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`
}
