import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../security/untrusted', async (orig) => ({
  ...(await orig<typeof import('../security/untrusted')>()),
  assertSsrfSafe: async () => {},
}))

import { pythonFetchPage } from './fetch-page'

/** A stand-in for `python -m src.page`: prints the JSON line it is given. */
function fakePython(line: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cello-fetcher-'))
  const file = path.join(dir, 'python')
  writeFileSync(file, `#!/bin/sh\necho '${line}'\n`)
  chmodSync(file, 0o755)
  process.env.INGEST_PYTHON = file
  process.env.INGEST_SCRAPERS_DIR = dir
  return file
}

afterEach(() => {
  delete process.env.INGEST_PYTHON
  delete process.env.INGEST_SCRAPERS_DIR
})

describe('pythonFetchPage', () => {
  it('returns the page the fetcher printed', async () => {
    fakePython('{"ok": true, "html": "<p>roles</p>", "final_url": "https://acme.test/careers", "rendered": true}')
    await expect(pythonFetchPage('https://acme.test/careers', { render: true })).resolves.toEqual({
      html: '<p>roles</p>',
      finalUrl: 'https://acme.test/careers',
      rendered: true,
    })
  })

  it('a render that was asked for and could not run is an error with its class, never an empty page', async () => {
    fakePython('{"ok": true, "html": "<p>plain</p>", "final_url": "https://acme.test/careers", "rendered": false, "render_error": "PlaywrightMissing"}')
    await expect(pythonFetchPage('https://acme.test/careers', { render: true })).rejects.toThrow('fetcher_render_PlaywrightMissing')
    // Without a render being asked for, the plain page is what was wanted.
    await expect(pythonFetchPage('https://acme.test/careers')).resolves.toMatchObject({ html: '<p>plain</p>' })
  })

  it('a failure is its class name only', async () => {
    fakePython('{"ok": false, "error": "RobotsDisallowed"}')
    await expect(pythonFetchPage('https://acme.test/careers')).rejects.toThrow('fetcher_RobotsDisallowed')
  })
})
