import type { BrowserContext, Page } from '@playwright/test'
import type { Site } from './harness'
import { autoPages, claim, connect, expect, gh, test, tick } from './harness'
import { FIELDS_GREENHOUSE, page as build } from './fixtures/pages'
import { contrastOf, copyProblems, shoot, sizes } from './shots'

// PG10: the page bar in each state it has: filled with Send next, saved with Send next,
// sending with Pause Cello, and handed back with its cause. Every control is at least 44
// pixels, the colours pass AA in both appearances, the bar fits a phone width, and the
// words pass the copy scan. Screenshots go to test-results/shots.

async function open(context: BrowserContext, site: Site, job: number, html: string): Promise<Page> {
  site.pages.set(`job-boards.greenhouse.io/acme/jobs/${job}`, html)
  const p = await context.newPage()
  await p.goto(gh(job))
  return p
}

async function check(p: Page, name: string): Promise<void> {
  await expect(p.locator('cello-bar .bar')).toBeVisible()
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme })
    await shoot(p, `bar-${name}-${scheme}`)
    expect(await contrastOf(p.locator('cello-bar .text')), `${name} ${scheme} text`).toBeGreaterThanOrEqual(4.5)
    for (const btn of await p.locator('cello-bar button').all()) {
      expect(await contrastOf(btn), `${name} ${scheme} button`).toBeGreaterThanOrEqual(4.5)
    }
  }
  for (const s of await sizes(p.locator('cello-bar button'))) {
    expect(s.width, `${s.label} width`).toBeGreaterThanOrEqual(44)
    expect(s.height, `${s.label} height`).toBeGreaterThanOrEqual(44)
  }
  // On a phone the bar still fits the width.
  await p.setViewportSize({ width: 390, height: 844 })
  await shoot(p, `bar-${name}-390`)
  const box = await p.locator('cello-bar .bar').boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  expect(copyProblems(await p.locator('cello-bar .text').innerText())).toEqual([])
  await p.setViewportSize({ width: 1280, height: 720 })
}

test('filled: the count and Send next, from Cello', async ({ context, stub, site }) => {
  await connect(context, stub)
  const p = await open(context, site, 5001, build({ fields: FIELDS_GREENHOUSE }))
  await p.getByRole('button', { name: 'Fill with Cello' }).click()
  await expect(p.locator('cello-bar .text')).toHaveText('Filled 7 of 10 fields. 3 need you on the page.')
  await expect(p.locator('cello-bar button')).toHaveText(['Send next'])
  await check(p, 'filled')
})

test('saved: the confirmation is kept and Send next is offered', async ({ context, stub, site }) => {
  await connect(context, stub)
  const p = await open(context, site, 5002, build())
  await p.getByRole('button', { name: 'Fill with Cello' }).click()
  await expect(p.locator('cello-bar .text')).toContainText('Filled 7 of 10 fields.')
  await p.getByRole('button', { name: 'Submit application' }).click()
  await expect(p.locator('cello-bar .text')).toHaveText('Cello saved the confirmation.', { timeout: 20_000 })
  await check(p, 'saved')
})

test('sending: the bar says who it is sending to and offers Pause Cello, which ends the send', async ({ context, stub, site }) => {
  site.pages.set('job-boards.greenhouse.io/acme/jobs/5003', build())
  stub.cfg.sessionDelayMs = 8000
  await connect(context, stub)
  stub.cfg.claim = claim(5003)
  await tick(context)
  await expect.poll(() => autoPages(context).length).toBe(1)
  const p = autoPages(context)[0]!
  await expect(p.locator('cello-bar .text')).toHaveText('Cello is sending your application to Acme.')
  await expect(p.locator('cello-bar button')).toHaveText(['Pause Cello'])
  await check(p, 'sending')

  await p.locator('cello-bar').getByRole('button', { name: 'Pause Cello' }).click()
  await expect.poll(() => stub.calls('/api/pipeline/pause').length).toBe(1)
  // The send ends and its window closes: the bar leaves with it.
  await expect.poll(() => autoPages(context).length, { timeout: 30_000 }).toBe(0)
  expect(stub.reports('ready_to_send')).toHaveLength(0)
})

test('handed back: the bar names the cause and what the person does next', async ({ context, stub, site }) => {
  const script = `document.getElementById('application_form').addEventListener('submit', function (e) { e.preventDefault(); var f = document.createElement('iframe'); f.src = 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'; f.style.cssText = 'display:block;width:304px;height:78px'; document.body.appendChild(f); });`
  site.pages.set('job-boards.greenhouse.io/acme/jobs/5004', build({ script }))
  await connect(context, stub)
  stub.cfg.claim = claim(5004)
  await tick(context)
  await expect.poll(() => autoPages(context).length).toBe(1)
  const p = autoPages(context)[0]!
  await expect(p.locator('cello-bar .text')).toHaveText(
    'Cello stopped here: the site is checking that you are a person. Finish this application yourself.',
    { timeout: 40_000 },
  )
  await check(p, 'handed-back')
})
