import fs from 'node:fs'
import path from 'node:path'
import { TOKEN } from './fill-server.stub'
import { EXT, alarmInfo, autoPages, claim, connect, expect, localGet, serviceWorker, test, tick } from './harness'
import { page as build } from './fixtures/pages'

// The extension's own shell: manifest, presence, the options page, the token handoff and the popup.

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')) as {
  permissions: string[]
  host_permissions: string[]
  externally_connectable: { matches: string[] }
  content_security_policy?: unknown
  content_scripts: Array<{ matches: string[]; world?: string }>
  version: string
}

test('the manifest asks for exactly the blueprint permissions and no broad hosts', () => {
  expect([...manifest.permissions].sort()).toEqual(['activeTab', 'alarms', 'offscreen', 'scripting', 'storage', 'tabs'])
  expect(manifest.host_permissions).toEqual(
    expect.arrayContaining([
      'https://boards.greenhouse.io/*',
      'https://job-boards.greenhouse.io/*',
      'https://jobs.lever.co/*',
      'https://jobs.ashbyhq.com/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ]),
  )
  const everything = JSON.stringify(manifest)
  expect(everything).not.toContain('<all_urls>')
  expect(everything).not.toContain('"*://*/*"')
  for (const h of manifest.host_permissions) expect(h).not.toMatch(/^\*|:\/\/\*\//)
  // The content scripts run on the three hosted-form hosts only.
  for (const c of manifest.content_scripts) expect(c.matches.every((m) => /greenhouse\.io|lever\.co|ashbyhq\.com/.test(m))).toBe(true)
  // No remote code: no relaxed content security policy.
  expect(JSON.stringify(manifest.content_security_policy ?? '')).not.toMatch(/unsafe-eval|https?:/)
})

test('the bundle loads no remote script', () => {
  const dir = EXT
  const files: string[] = []
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (/\.(html)$/.test(f)) files.push(p)
    }
  }
  walk(dir)
  for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/<script[^>]+src=["']https?:/i)
})

test('presence: a five minute alarm, and every tick calls Cello with the token and the version', async ({ context, stub }) => {
  const alarm = await alarmInfo(context)
  expect(alarm?.periodInMinutes).toBe(5)

  await connect(context, stub)
  await tick(context)
  await expect.poll(() => stub.calls('/api/fill/next').length).toBeGreaterThanOrEqual(1)
  const call = stub.calls('/api/fill/next')[0]!
  expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
  expect(call.headers['x-cello-extension-version']).toBe(manifest.version)
  expect(call.body).toMatchObject({ auto: true, version: manifest.version })
})

test('below the minimum version the extension shows an update line and sends nothing', async ({ context, stub, site }) => {
  stub.cfg.minVersion = '9.0.0'
  site.pages.set('job-boards.greenhouse.io/acme/jobs/4001', build())
  await connect(context, stub)
  stub.cfg.claim = claim(4001)
  await tick(context)
  await expect.poll(() => stub.calls('/api/fill/next').length).toBe(1)
  await new Promise((r) => setTimeout(r, 1000))
  expect(stub.calls('/api/fill/session')).toHaveLength(0)
  expect(autoPages(context)).toHaveLength(0)

  const id = new URL((await serviceWorker(context)).url()).host
  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  await expect(popup.getByRole('heading', { name: 'Update the Cello extension' })).toBeVisible()
})

test('the options page saves the token the way a person pastes it', async ({ context }) => {
  const id = new URL((await serviceWorker(context)).url()).host
  const p = await context.newPage()
  await p.goto(`chrome-extension://${id}/options.html`)
  await p.getByLabel('Token', { exact: true }).fill('pasted-token')
  await p.getByRole('button', { name: 'Save' }).click()
  await expect(p.getByRole('status')).toContainText('Saved')
  expect(await localGet(context, 'token')).toBe('pasted-token')
})

test('Cello hands over the token from its own origin, and no other message is taken', async ({ context, stub }) => {
  const id = new URL((await serviceWorker(context)).url()).host
  const p = await context.newPage()
  await p.goto(`${stub.origin}/__page/connect`)
  const ok = await p.evaluate(
    (ext) =>
      new Promise((resolve) =>
        (globalThis as unknown as { chrome: { runtime: { sendMessage: (id: string, m: unknown, cb: (r: unknown) => void) => void } } }).chrome.runtime.sendMessage(ext, { type: 'cello-connect', token: 'handed-over' }, resolve),
      ),
    id,
  )
  expect(ok).toMatchObject({ ok: true })
  expect(await localGet(context, 'token')).toBe('handed-over')

  const refused = await p.evaluate(
    (ext) =>
      new Promise((resolve) =>
        (globalThis as unknown as { chrome: { runtime: { sendMessage: (id: string, m: unknown, cb: (r: unknown) => void) => void } } }).chrome.runtime.sendMessage(ext, { type: 'cello-fill', application: 'x' }, resolve),
      ),
    id,
  )
  expect(refused).toMatchObject({ ok: false })
})

test('the popup says when the extension is not connected, and offers Pause Cello when it is', async ({ context, stub }) => {
  const id = new URL((await serviceWorker(context)).url()).host
  const p = await context.newPage()
  await p.goto(`chrome-extension://${id}/popup.html`)
  await expect(p.getByRole('heading', { name: 'Cello is not connected' })).toBeVisible()

  await connect(context, stub)
  await p.reload()
  await expect(p.getByRole('heading', { name: 'Send for me is on.' })).toBeVisible()
  await p.getByRole('button', { name: 'Pause Cello' }).click()
  await expect(p.getByRole('heading', { name: 'Cello is paused' })).toBeVisible()
  await expect.poll(() => stub.calls('/api/pipeline/pause').length).toBe(1)
  expect(stub.calls('/api/pipeline/pause')[0]!.body).toEqual({ paused: true })
  await p.getByRole('button', { name: 'Resume Cello' }).click()
  await expect(p.getByRole('heading', { name: 'Send for me is on.' })).toBeVisible()
})
