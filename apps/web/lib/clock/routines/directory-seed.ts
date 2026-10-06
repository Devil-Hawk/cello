// directory.seed: the directory's candidates, from two public lists. It never writes company_directory: an entry is
// a candidate until the verifier (directory.sweep, or a person choosing it in Add) ties its board to it.
//
//   Y Combinator   the hiring list (yc-oss mirror), weekly: name, website, tags and one line, for "Suggested for you"
//   ats-scrapers   kalil0321/ats-scrapers, MIT licensed, the tenant lists of the applicant systems Cello can read,
//                  monthly. The data's own licence is not stated, so only the slug, the provider and the name are
//                  kept, and this line is the attribution. Never Feashliaa's data (CC BY-NC); never guessed slugs.
//
// Only new or changed entries are written (upsert_directory_candidates). Both lists are fetched with Cello's own
// guarded helpers; a list whose shape changed makes the routine fail loudly, which the scorecard shows as T26.
//
// ponytail: Workday and Eightfold are left out: their tenant is a host and a site, not a slug a board token can hold.
// Add them with their own parser when the verifier reads those boards by token.

import { assertAllowedHost, fetchText } from '../../ats/http'
import { isValidToken, type AtsProviderId } from '../../ats/types'
import { normalizeCompanyName } from '../../entities/companies'
import { fetchYcHiringCompanies, type YcCompany } from '../../sources/ycombinator'
import type { RoutineContext, RoutineOutcome } from '../routines'

const KALIL_BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies'
const KALIL_HOSTS = new Set(['raw.githubusercontent.com'])
export const KALIL_PROVIDERS: readonly AtsProviderId[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'personio']

const DAY_MS = 86_400_000
export const YC_EVERY_DAYS = 7
export const KALIL_EVERY_DAYS = 30
const BATCH = 500

export interface SeedRow {
  name: string
  name_norm: string
  domain: string | null
  ats_provider: AtsProviderId | null
  ats_token: string | null
  source: 'kalil' | 'yc'
  tags?: string[]
  one_liner?: string | null
  batch?: string | null
  team_size?: number | null
  regions?: string[]
  locations?: string | null
  profile_url?: string | null
}

// --- ats-scrapers --------------------------------------------------------------

/** One CSV record, with quoted fields ("Foo, Bar Inc") and doubled quotes. */
function csvFields(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted && ch === '"' && line[i + 1] === '"') {
      cur += '"'
      i++
    } else if (ch === '"') {
      quoted = !quoted
    } else if (ch === ',' && !quoted) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/**
 * A provider's tenant list as candidates. The canonical shape is `name,slug,url`; a few files still carry the old
 * `name,url` where the second column is the bare slug. A header that is neither throws: the list changed shape.
 */
export function parseKalil(csv: string, provider: AtsProviderId): SeedRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '')
  const header = csvFields(lines[0] ?? '').map((h) => h.trim().toLowerCase())
  const nameAt = header.indexOf('name')
  const slugAt = header.indexOf('slug') >= 0 ? header.indexOf('slug') : header.indexOf('url')
  if (nameAt < 0 || slugAt < 0) throw new Error(`ats-scrapers ${provider}: unexpected header`)
  const seen = new Set<string>()
  const rows: SeedRow[] = []
  for (const line of lines.slice(1)) {
    const f = csvFields(line)
    const name = (f[nameAt] ?? '').trim().slice(0, 200)
    const token = (f[slugAt] ?? '').trim()
    // A slug that cannot be a board token (a path, a symbol) is not seeded; a name that is empty has nothing to check.
    if (!name || !isValidToken(token) || seen.has(token.toLowerCase())) continue
    seen.add(token.toLowerCase())
    rows.push({ name, name_norm: normalizeCompanyName(name), domain: null, ats_provider: provider, ats_token: token, source: 'kalil' })
  }
  return rows
}

// --- Y Combinator ----------------------------------------------------------------

function websiteHost(website?: string): string | null {
  try {
    return website ? new URL(website).hostname.toLowerCase().replace(/^www\./, '') || null : null
  } catch {
    return null
  }
}

/** The hiring list as candidates with a website; rows with no website have nothing to verify and are left out. */
export function ycRows(list: readonly YcCompany[]): SeedRow[] {
  const seen = new Set<string>()
  const rows: SeedRow[] = []
  for (const c of list) {
    const name = c.name?.trim().slice(0, 200)
    const domain = websiteHost(c.website)
    if (!name || !domain || seen.has(domain) || c.isHiring === false || (c.status && /inactive|dead/i.test(c.status))) continue
    seen.add(domain)
    const profile = c.url ?? (c.slug ? `https://www.ycombinator.com/companies/${c.slug}` : null)
    rows.push({
      name,
      name_norm: normalizeCompanyName(name),
      domain,
      ats_provider: null,
      ats_token: null,
      source: 'yc',
      tags: [...(c.tags ?? []), ...(c.industries ?? []), ...(c.industry ? [c.industry] : [])].map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 30),
      one_liner: c.one_liner?.slice(0, 300) ?? null,
      batch: c.batch ?? null,
      team_size: typeof c.team_size === 'number' ? c.team_size : null,
      regions: (c.regions ?? []).slice(0, 10),
      locations: c.all_locations?.slice(0, 500) ?? null,
      profile_url: profile && /^https:\/\//.test(profile) ? profile : null,
    })
  }
  return rows
}

// --- the routine -------------------------------------------------------------------

export interface SeedDeps {
  fetchKalil: (provider: AtsProviderId) => Promise<string>
  fetchYc: () => Promise<YcCompany[]>
}

export const realSeedDeps: SeedDeps = {
  fetchKalil: (provider) => fetchText(assertAllowedHost(`${KALIL_BASE}/${provider}.csv`, KALIL_HOSTS), { retries: 1, timeoutMs: 30_000 }),
  fetchYc: fetchYcHiringCompanies,
}

async function write(ctx: RoutineContext, rows: SeedRow[]): Promise<number> {
  let n = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const { data, error } = await ctx.admin.rpc('upsert_directory_candidates', { p_rows: rows.slice(i, i + BATCH) })
    if (error) throw new Error('upsert_directory_candidates')
    n += Number(data ?? 0)
  }
  return n
}

type SeedState = { phase: 'yc' | 'kalil'; at: number; yc: number; kalil: number }

/**
 * One slice of the seed. A list is due when it was last loaded more than a week (YC) or a month (the tenant lists) ago;
 * the loaded-at times live in the routine's own args. A slice stops between providers when its deadline comes and hands
 * the next provider on.
 */
export async function seedWith(ctx: RoutineContext, deps: SeedDeps): Promise<RoutineOutcome> {
  const args = (ctx.routine.args ?? {}) as { yc_at?: string; kalil_at?: string }
  const age = (at?: string) => (at ? ctx.now() - Date.parse(at) : Infinity)
  const state = (ctx.state ?? null) as SeedState | null
  // A slice that carries on (state) is in the middle of the tenant lists: YC was done in the slice before.
  const ycDue = !state && age(args.yc_at) > YC_EVERY_DAYS * DAY_MS
  const kalilDue = Boolean(state) || age(args.kalil_at) > KALIL_EVERY_DAYS * DAY_MS
  const total = { yc: state?.yc ?? 0, kalil: state?.kalil ?? 0 }
  const stamped = { ...args }
  const stamp = (key: 'yc_at' | 'kalil_at') => {
    stamped[key] = new Date(ctx.now()).toISOString()
    return ctx.admin.from('routines').update({ args: { ...stamped } }).eq('id', ctx.routine.id)
  }
  let ycFailed = false

  try {
    if (ycDue) {
      const list = await deps.fetchYc()
      // The mirror answers [] when it is down: that is not a list, so nothing is stamped and the next tick tries again.
      if (list.length === 0) ycFailed = true
      else {
        total.yc += await write(ctx, ycRows(list))
        await stamp('yc_at')
      }
    }
    if (kalilDue) {
      const from = state?.phase === 'kalil' ? state.at : 0
      for (let i = from; i < KALIL_PROVIDERS.length; i++) {
        if (ctx.now() >= ctx.deadlineAt) return { ok: true, found: total, next: { phase: 'kalil', at: i, ...total } }
        total.kalil += await write(ctx, parseKalil(await deps.fetchKalil(KALIL_PROVIDERS[i]), KALIL_PROVIDERS[i]))
      }
      await stamp('kalil_at')
    }
  } catch (error) {
    // The list moved or the database refused: the routine fails and says so; nothing is stamped.
    return { ok: false, failure: error instanceof Error && error.message.startsWith('ats-scrapers') ? 'seed_format_changed' : 'seed_failed', found: total }
  }
  return ycFailed ? { ok: false, failure: 'yc_list_empty', found: total } : { ok: true, found: total }
}

export const directorySeed = (ctx: RoutineContext): Promise<RoutineOutcome> => seedWith(ctx, realSeedDeps)
