// The depth rules as a pure check. Relief has one tokens file (app/relief.css)
// and one elevation scale. Anywhere else a raw shadow, a gradient or a blur is
// a second scale in the making, and three (the 3D library) belongs only in
// components/depth so it never reaches first-load JS by accident.

const TOKENS_FILE = 'app/relief.css'

// ponytail: legacy files, emptied as their pages ship
export const LEGACY_ALLOW = ['app/globals.css', 'components/ui/empty-state-hero.tsx']

// This file and its test hold the patterns as text.
const SELF = ['lib/depth/rules.ts', 'lib/depth/rules.test.ts']

const SHADOW_VALUE = /(?:box-shadow\s*:|boxShadow\s*:)\s*['"`]?([^;}'"`\n]+)/gi
const BANNED: Array<[RegExp, string]> = [
  [/gradient\(/, 'gradient'],
  [/bg-gradient/, 'bg-gradient'],
  [/backdrop-filter/, 'backdrop-filter'],
  [/backdrop-blur/, 'backdrop-blur'],
  [/shadow-\[/, 'arbitrary shadow'],
]
const THREE_IMPORT = /from\s+['"]three['"]|@react-three\//

export function findDepthViolations(path: string, text: string): string[] {
  const p = path.split('\\').join('/')
  if (p === TOKENS_FILE || SELF.includes(p) || LEGACY_ALLOW.includes(p)) return []
  const found: string[] = []
  text.split('\n').forEach((line, i) => {
    const at = `${p}:${i + 1}`
    for (const m of Array.from(line.matchAll(SHADOW_VALUE))) {
      const v = m[1].trim()
      if (!v.startsWith('var(--') && v !== 'none') found.push(`${at} raw box-shadow: ${v.slice(0, 60)}`)
    }
    for (const [re, name] of BANNED) if (re.test(line)) found.push(`${at} ${name}`)
    if (!p.startsWith('components/depth/') && THREE_IMPORT.test(line)) {
      found.push(`${at} three outside components/depth`)
    }
  })
  return found
}
