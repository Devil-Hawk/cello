import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  accountRoutes,
  applications,
  barRoutes,
  chat,
  companies,
  conversations,
  isCurrent,
  landing,
  login,
  network,
  phoneTabs,
  profile,
  roles,
  search,
  settings,
  today,
  welcome,
} from './index'
import { companyHref } from './companies'
import { recordHref } from './roles'

const ROUTES_DIR = path.join(process.cwd(), 'lib/routes')
const APP_DIR = path.join(process.cwd(), 'app')

// The pages of blueprint 4.0 that have a route file, by file name.
const PAGES = ['today', 'roles', 'companies', 'network', 'applications', 'conversations', 'chat', 'profile', 'search', 'settings', 'welcome', 'landing', 'login']

/** Every page.tsx under app/, as the address it serves (route groups removed). */
function pageAddresses(dir = APP_DIR, base = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      const seg = /^\(.*\)$/.test(entry) ? '' : `/${entry}`
      out.push(...pageAddresses(full, base + seg))
    } else if (entry === 'page.tsx') out.push(base || '/')
  }
  return out
}

describe('route files', () => {
  it('has one file per page of the set', () => {
    const files = readdirSync(ROUTES_DIR)
    for (const p of PAGES) expect(files, p).toContain(`${p}.ts`)
  })

  it('every href is a page that exists', () => {
    const pages = pageAddresses()
    for (const r of [today, roles, companies, network, applications, conversations, chat, profile, search, settings, welcome, landing, login]) {
      expect(pages, `${r.label} -> ${r.href}`).toContain(r.href.split('?')[0])
    }
  })

  it('links a role to its record and a logo to its company', () => {
    expect(recordHref('abc')).toContain('abc')
    expect(companyHref('stripe')).toBe('/companies/stripe')
  })
})

describe('the bar', () => {
  it('orders Today, Roles, Companies before the rest', () => {
    const labels = barRoutes.map((r) => r.label)
    expect(labels.slice(0, 3)).toEqual(['Today', 'Roles', 'Companies'])
    expect(labels.indexOf('Roles')).toBeLessThan(labels.indexOf('Companies'))
  })

  it('has no Chat key until it ships, and no duplicate pages', () => {
    expect(chat.bar).toBe(false)
    expect(barRoutes.map((r) => r.label)).not.toContain('Chat')
    expect(new Set(barRoutes.map((r) => r.href)).size).toBe(barRoutes.length)
  })

  it('has five phone tabs, Conversations in the fifth until Chat is in the bar', () => {
    expect(phoneTabs).toHaveLength(5)
    expect(phoneTabs[4]).toBe(chat.bar ? chat : conversations)
    expect(phoneTabs.slice(0, 4)).toEqual([today, roles, companies, applications])
  })

  it('puts every page that is not a key in the account menu, once per address', () => {
    const menu = accountRoutes()
    expect(menu.map((r) => r.label)).toContain('Profile')
    // Network sits in the account menu until it is a key in the bar
    if (!network.bar) expect(menu.map((r) => r.label)).toContain('Network')
    expect(new Set(menu.map((r) => r.href)).size).toBe(menu.length)
    for (const r of menu) expect(r.bar).toBe(false)
    expect(menu).toContain(profile)
    // one entry per address: while Your search shares Settings' page only Settings shows; once it has its own, both do
    if (search.href === settings.href) expect(menu.includes(search)).toBe(false)
    else expect(menu).toContain(search)
  })

  it('knows the current page from the address', () => {
    expect(isCurrent('/jobs', '/jobs')).toBe(true)
    expect(isCurrent('/jobs/abc', '/jobs')).toBe(true)
    expect(isCurrent('/jobsy', '/jobs')).toBe(false)
    expect(isCurrent('/jobs', '/jobs?job=1')).toBe(true)
  })
})

describe('labels', () => {
  it('names no retired page', () => {
    const all = [today, roles, companies, network, applications, conversations, chat, profile, search, settings]
    for (const r of all) expect(r.label).not.toMatch(/Copilot|Opportunities|dashboard/i)
  })
})
