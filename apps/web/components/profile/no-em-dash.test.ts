// The Profile page's copy has no em dashes. Comments may use them; what renders may not.
// ponytail: a source scan, not a render of every state; add a file here when Profile mounts a new one.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FILES = [
  'profile/profile-view.tsx',
  'profile/facts-group.tsx',
  'profile/versions-group.tsx',
  'profile/tailor-read.tsx',
  'profile/tailor-sheet.tsx',
  'profile/application-identity.tsx',
  'profile/employer-accounts.tsx',
  'resume/resume-download-menu.tsx',
  'resume/resume-preview.tsx',
  'resume/import-dialog.tsx',
  'resume/template-picker.tsx',
  'resume/editor/resume-editor.tsx',
]

// Drop comments and the preview's table separator (it mirrors the exporter, see resume-preview.test.tsx).
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
    .replace(/content: " — "/g, '')

describe('Profile copy', () => {
  it.each(FILES)('%s has no em dash outside comments', (file) => {
    expect(code(readFileSync(join(__dirname, '..', file), 'utf8'))).not.toContain('—')
  })
})
