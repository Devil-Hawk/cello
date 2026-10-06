import type { BrowserContext, Page } from '@playwright/test'
import { dataUrlBytes, MAX_SCREENSHOT_BYTES } from '../lib/shrink'
import { connect, expect, test } from './harness'
import type { Site } from './harness'
import { FIELDS_ASHBY, FIELDS_GREENHOUSE, FIELDS_LEVER, page as build } from './fixtures/pages'

// The person's own fill (T13, T14): they click, Cello fills what it knows, they send.

async function open(context: BrowserContext, site: Site, host: string, path: string, html: string): Promise<Page> {
  site.pages.set(host + path, html)
  const p = await context.newPage()
  await p.goto(`https://${host}${path}`)
  return p
}

const fillButton = (p: Page) => p.getByRole('button', { name: 'Fill with Cello' })
const CHALLENGE_NAME = /captcha|turnstile/i

const FORMS = [
  { name: 'Greenhouse', host: 'job-boards.greenhouse.io', path: '/acme/jobs/4001', fields: FIELDS_GREENHOUSE, bar: 'Filled 7 of 10 fields. 3 need you on the page.', first: '#first_name' },
  { name: 'Lever', host: 'jobs.lever.co', path: '/acme/1234/apply', fields: FIELDS_LEVER, bar: 'Filled 6 of 7 fields. 1 need you on the page.', first: '#name' },
  { name: 'Ashby', host: 'jobs.ashbyhq.com', path: '/acme/5678/application', fields: FIELDS_ASHBY, bar: 'Filled 4 of 5 fields. 1 need you on the page.', first: '[name=_systemfield_name]' },
]

for (const f of FORMS) {
  test(`${f.name}: fills known fields, leaves the challenge alone, submits nothing until the test does`, async ({ context, stub, site }) => {
    await connect(context, stub)
    const p = await open(context, site, f.host, f.path, build({ fields: f.fields }))
    await fillButton(p).click()
    await expect(p.getByText(f.bar)).toBeVisible()

    await expect(p.locator(f.first)).not.toHaveValue('')
    expect(await p.locator('input[type=file]').evaluate((e: HTMLInputElement) => e.files?.[0]?.name)).toBe('Ada-Lovelace.pdf')

    // The challenge's inputs hold what they held before, and its frame was never asked for more than the page did.
    expect(await p.locator('[name=h-captcha-response]').inputValue()).toBe('')
    expect(await p.locator('[name=g-recaptcha-response]').evaluate((e: HTMLInputElement) => e.value)).toBe('')
    const asked = (stub.calls('/api/fill/session')[0]?.body.fields as Array<{ name: string }>).map((x) => x.name)
    expect(asked.filter((n) => CHALLENGE_NAME.test(n))).toEqual([])
    expect(site.submits).toBe(0)
    expect(stub.reports('filled')).toHaveLength(1)
  })
}

test('a form that submits on change does not submit while Cello fills, and does once the person sends', async ({ context, stub, site }) => {
  await connect(context, stub)
  const html = build({
    script: `document.querySelectorAll('input').forEach(function (i) { i.addEventListener('change', function () { if (i.form) i.form.submit(); }); });`,
  })
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4101', html)
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  expect(site.submits).toBe(0)
  await p.getByRole('button', { name: 'Submit application' }).click()
  await expect.poll(() => site.submits).toBe(1)
})

test('a form that submits on input does not submit while Cello fills', async ({ context, stub, site }) => {
  await connect(context, stub)
  // The page raises its own submit event whenever a field changes, and posts if nothing cancels it.
  const html = build({
    script: `var form = document.getElementById('application_form');
      form.addEventListener('input', function () {
        var ev = new Event('submit', { bubbles: true, cancelable: true });
        if (form.dispatchEvent(ev)) fetch('/__submit', { method: 'POST' });
      });`,
  })
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4102', html)
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  expect(site.submits).toBe(0)
  expect(site.clicks).toBe(0)
})

const LOGIN = `<div><label for="email">Email</label><input id="email" name="email" type="email"></div>
  <div><label for="password">Password</label><input id="password" name="password" type="password"></div>`
const ACCOUNT = `${LOGIN}
  <div><label for="password2">Confirm password</label><input id="password2" name="password2" type="password"></div>`

for (const [name, fields, cause] of [
  ['a login wall', LOGIN, 'sign_in'],
  ['an account form', ACCOUNT, 'account'],
] as const) {
  test(`${name} reports blocked ${cause} and fills nothing`, async ({ context, stub, site }) => {
    await connect(context, stub)
    const extra = `<div><label for="a">Name</label><input id="a" name="name"></div><div><label for="b">Phone</label><input id="b" name="phone"></div>`
    const p = await open(context, site, 'jobs.lever.co', `/acme/wall-${cause}`, build({ fields: fields + extra, challenge: '' }))
    await fillButton(p).click()
    await expect(p.getByText("Sign in or finish the site's check yourself, then click Fill again.")).toBeVisible()
    expect(await p.locator('#email').inputValue()).toBe('')
    expect(await p.locator('#a').inputValue()).toBe('')
    expect(stub.calls('/api/fill/session')).toHaveLength(0)
    expect(stub.reports('blocked')[0]?.body.cause).toBe(cause)
  })
}

test('a password and an EEO answer typed by the person never appear in a report', async ({ context, stub, site }) => {
  await connect(context, stub)
  const fields = `${FIELDS_GREENHOUSE}<div><label for="pw">Create a passphrase</label><input id="pw" name="pw" type="password"></div>`
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4103', build({ fields }))
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  await p.locator('#pw').fill('Sup3rSecret9')
  await p.locator('#gender').selectOption('Woman')
  await p.locator('#first_name').fill('Grace')
  await p.getByRole('button', { name: 'Submit application' }).click()
  await expect.poll(() => stub.reports('submitted').length).toBe(1)

  const submitted = stub.reports('submitted')[0]!.body.values as Record<string, unknown>
  expect(submitted.gender).toEqual({ answered_by_you: true })
  expect(submitted.pw).toBeUndefined()
  // The session request lists the select's options, as it must; every other body is checked.
  const everything = JSON.stringify(stub.requests.filter((r) => r.path !== '/api/fill/session').map((r) => r.body))
  expect(everything).not.toContain('Sup3rSecret9')
  expect(everything).not.toContain('Woman')
})

test('what is reported as submitted is the DOM after the person edited it, allowlisted only', async ({ context, stub, site }) => {
  await connect(context, stub)
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4104', build())
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  await p.locator('#first_name').fill('Grace')
  await p.getByRole('button', { name: 'Submit application' }).click()
  await expect.poll(() => stub.reports('submitted').length).toBe(1)
  const values = stub.reports('submitted')[0]!.body.values as Record<string, unknown>
  expect(values.first_name).toBe('Grace')
  expect(values.last_name).toBe('Lovelace')
  expect(values.resume).toEqual({ file: 'Ada-Lovelace.pdf' })
  expect(Object.keys(values).filter((k) => CHALLENGE_NAME.test(k))).toEqual([])
})

test('a three-page portal fills each page on its own click', async ({ context, stub, site }) => {
  await connect(context, stub)
  const pages: Array<[string, string]> = [
    ['/acme/portal/1', `<div><label for="a">First name</label><input id="a" name="first_name"></div><div><label for="b">Last name</label><input id="b" name="last_name"></div><div><label for="c">Email</label><input id="c" name="email"></div>`],
    ['/acme/portal/2', `<div><label for="a">Phone</label><input id="a" name="phone"></div><div><label for="b">Location</label><input id="b" name="location"></div><div><label for="c">LinkedIn</label><input id="c" name="linkedin"></div>`],
    ['/acme/portal/3', `<div><label for="a">First name</label><input id="a" name="first_name"></div><div><label for="b">Email</label><input id="b" name="email"></div><div><label for="c">Phone</label><input id="c" name="phone"></div>`],
  ]
  stub.cfg.file = false
  const p = await context.newPage()
  for (const [path, fields] of pages) {
    site.pages.set(`jobs.lever.co${path}`, build({ fields, challenge: '' }))
    await p.goto(`https://jobs.lever.co${path}`)
    await fillButton(p).click()
    await expect(p.getByText('Filled 3 of 3 fields.')).toBeVisible()
  }
  expect(stub.calls('/api/fill/session').map((r) => new URL(r.body.url as string).pathname)).toEqual(pages.map(([path]) => path))
  expect(await p.locator('#a').inputValue()).toBe('Ada')
})

test('a click the page made itself does nothing', async ({ context, stub, site }) => {
  await connect(context, stub)
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4105', build())
  await expect(fillButton(p)).toBeVisible()
  await p.evaluate(() => {
    const b = document.querySelector('cello-fill-button')!.shadowRoot!.querySelector('button')!
    b.click()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
  })
  await p.waitForTimeout(800)
  expect(stub.calls('/api/fill/session')).toHaveLength(0)
  expect(await p.locator('#first_name').inputValue()).toBe('')
})

test('Draft this fills a motivation field with a draft the person can read', async ({ context, stub, site }) => {
  await connect(context, stub)
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4106', build())
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  await p.getByRole('button', { name: 'Draft this' }).click()
  await expect(p.locator('#why')).toHaveValue(/building tools/)
  expect(stub.calls('/api/fill/draft')).toHaveLength(1)
})

test('the confirmation is captured with its text and address, and a big screenshot is shrunk or not sent', async ({ context, stub, site }) => {
  await connect(context, stub)
  site.noisy = true
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4107', build())
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  await p.getByRole('button', { name: 'Submit application' }).click()
  await expect.poll(() => stub.reports('confirmation').length, { timeout: 20_000 }).toBe(1)
  const c = stub.reports('confirmation')[0]!.body as { text: string; url: string; screenshot?: string }
  expect(c.text).toMatch(/Thank you for applying/)
  expect(c.url).toContain('/__submit')
  if (c.screenshot) expect(dataUrlBytes(c.screenshot)).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES)
})

test('Send next opens the next ready application', async ({ context, stub, site }) => {
  await connect(context, stub)
  stub.cfg.nextReady = { application: 'app-next', url: 'https://jobs.lever.co/acme/next/apply', company: 'Next Co' }
  site.pages.set('jobs.lever.co/acme/next/apply', build({ fields: FIELDS_LEVER }))
  const p = await open(context, site, 'job-boards.greenhouse.io', '/acme/jobs/4108', build())
  await fillButton(p).click()
  await expect(p.getByText('Filled 7 of 10 fields.')).toBeVisible()
  const opened = context.waitForEvent('page')
  await p.getByRole('button', { name: 'Send next' }).click()
  expect((await opened).url()).toContain('/acme/next/apply')
})
