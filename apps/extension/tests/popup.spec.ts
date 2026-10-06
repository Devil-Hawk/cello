import type { BrowserContext, Page } from '@playwright/test'
import { connect, expect, localGet, serviceWorker, test } from './harness'
import { contrastRatio } from '../ui/tokens'
import { contrastOf, copyProblems, shoot, sizes } from './shots'

// PG10: the popup in every state. Each state has one next step, its numbers are the ones
// Cello's own count gave, every control is at least 44 pixels, the words pass the copy
// scan and the colours pass AA in both appearances. Screenshots go to test-results/shots.

const extensionId = async (context: BrowserContext): Promise<string> => new URL((await serviceWorker(context)).url()).host

async function openPopup(context: BrowserContext): Promise<Page> {
  const p = await context.newPage()
  await p.goto(`chrome-extension://${await extensionId(context)}/popup.html`)
  return p
}

async function check(p: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme })
    await shoot(p, `popup-${name}-${scheme}`)
    for (const loc of [p.locator('h1'), p.locator('p'), ...(await p.locator('button').all())]) {
      expect(await contrastOf(loc), `${name} ${scheme}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  for (const s of await sizes(p.locator('button'))) {
    expect(s.width, `${s.label} width`).toBeGreaterThanOrEqual(44)
    expect(s.height, `${s.label} height`).toBeGreaterThanOrEqual(44)
  }
  expect(copyProblems(await p.locator('main').innerText())).toEqual([])
}

test('not connected: one next step, Open options', async ({ context }) => {
  const p = await openPopup(context)
  await expect(p.getByRole('heading', { name: 'Cello is not connected' })).toBeVisible()
  await expect(p.getByRole('button')).toHaveCount(1)
  await check(p, 'not-connected')
})

test('Send for me on: the numbers are the ones Cello counted, and Pause Cello is the next step', async ({ context, stub }) => {
  stub.cfg.status = { send_for_me: true, paused: false, sent_today: 1, tries_today: 2, cap: 3 }
  await connect(context, stub)
  const p = await openPopup(context)
  await expect(p.getByRole('heading', { name: 'Send for me is on.' })).toBeVisible()
  await expect(p.getByText('1 sent today, 2 of 3 tries used.')).toBeVisible()
  await expect(p.getByRole('button', { name: 'Pause Cello' })).toHaveClass(/primary/)
  await check(p, 'send-on')

  // Another answer from Cello: the popup shows what it says and nothing it worked out.
  stub.cfg.status = { send_for_me: true, paused: false, sent_today: 0, tries_today: 3, cap: 3 }
  await p.reload()
  await expect(p.getByText('0 sent today, 3 of 3 tries used.')).toBeVisible()
})

test('Send for me off: Fill this page is the next step', async ({ context, stub }) => {
  stub.cfg.status = { send_for_me: false, paused: false, sent_today: 0, tries_today: 0, cap: 3 }
  await connect(context, stub)
  const p = await openPopup(context)
  await expect(p.getByRole('heading', { name: 'Send for me is off.' })).toBeVisible()
  await expect(p.getByRole('button', { name: 'Fill this page' })).toHaveClass(/primary/)
  await check(p, 'send-off')
})

test('Pause Cello in the popup tells Cello, and Resume undoes it', async ({ context, stub }) => {
  await connect(context, stub)
  const p = await openPopup(context)
  await p.getByRole('button', { name: 'Pause Cello' }).click()
  await expect(p.getByRole('heading', { name: 'Cello is paused' })).toBeVisible()
  await expect.poll(() => stub.calls('/api/pipeline/pause').length).toBe(1)
  expect(stub.calls('/api/pipeline/pause')[0]!.body).toEqual({ paused: true })
  await check(p, 'paused')
  await p.getByRole('button', { name: 'Resume Cello' }).click()
  await expect(p.getByRole('heading', { name: 'Send for me is on.' })).toBeVisible()
})

test('paused on Cello shows paused here too', async ({ context, stub }) => {
  stub.cfg.status = { send_for_me: true, paused: true, sent_today: 1, tries_today: 2, cap: 3 }
  await connect(context, stub)
  const p = await openPopup(context)
  await expect(p.getByRole('heading', { name: 'Cello is paused' })).toBeVisible()
})

test('Cello that cannot be reached offers Try again', async ({ context, stub }) => {
  stub.cfg.status = null
  await connect(context, stub)
  const p = await openPopup(context)
  await expect(p.getByRole('heading', { name: 'Cello could not be reached' })).toBeVisible()
  await check(p, 'unreachable')
  stub.cfg.status = { send_for_me: true, paused: false, sent_today: 1, tries_today: 2, cap: 3 }
  await p.getByRole('button', { name: 'Try again' }).click()
  await expect(p.getByRole('heading', { name: 'Send for me is on.' })).toBeVisible()
})

test('update needed: the build is older than Cello allows', async ({ context, stub }) => {
  stub.cfg.minVersion = '9.0.0'
  await connect(context, stub)
  await expect.poll(async () => ((await localGet(context, 'presence')) as { min_version?: string } | undefined)?.min_version).toBe('9.0.0')
  const p = await openPopup(context)
  await expect(p.getByRole('heading', { name: 'Update the Cello extension' })).toBeVisible()
  await check(p, 'update')
})

// The options page is where the token goes. Its fields must be drawn: a border you can see
// (3:1 against the page), text that passes AA, 44 pixel targets, in both appearances.
test('options page: fields and Save are drawn, readable and 44 pixels', async ({ context }) => {
  const p = await context.newPage()
  await p.goto(`chrome-extension://${await extensionId(context)}/options.html`)
  await expect(p.getByLabel('Token', { exact: true })).toBeVisible()
  // The popup's 320px body width must not leak onto this page.
  expect((await p.locator('body').boundingBox())!.width, 'options width').toBeGreaterThan(400)
  const hex = (c: string): string =>
    '#' +
    (c.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map((n) => Math.round(Number(n)).toString(16).padStart(2, '0'))
      .join('')
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme })
    await shoot(p, `options-${scheme}`)
    for (const loc of [p.locator('h1'), p.locator('label').first(), ...(await p.locator('input, select, button').all())]) {
      expect(await contrastOf(loc), `text ${scheme}`).toBeGreaterThanOrEqual(4.5)
    }
    const page = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
    for (const field of await p.locator('input, select').all()) {
      const border = await field.evaluate((e) => getComputedStyle(e).borderTopColor)
      expect(contrastRatio(hex(border), hex(page)), `border ${scheme}`).toBeGreaterThanOrEqual(3)
    }
  }
  for (const s of await sizes(p.locator('input, select, button'))) expect(s.height, 'options target').toBeGreaterThanOrEqual(44)
})
