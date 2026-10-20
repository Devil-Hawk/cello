// The agent's view of files: one CompositeBackend with four places.
//
//   /memories/        one read-only file, /memories/taste.md: the person's last reactions to roles
//   /artifacts/       the versioned artifacts table, shown as markdown files
//   /skills/          the SKILL.md files in apps/web/skills that met their bars on this kind of model, read-only
//   /my-skills/       the skills the person added and left on, read-only
//   everything else   scratch space in the thread's state
//
// Writes are refused by permissions for every agent loop (PERMISSIONS below), and
// the backends refuse them too, so a missing permission rule is not the only door.
// What Cello remembers about a person is mem0, written only by the remember tool, which
// checks the person's own words in code; there is no second memory store here.
// Artifacts change only through create_artifact and update_artifact.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  type BackendProtocolV2,
  type FileInfo,
  type FilesystemPermission,
  type GrepMatch,
} from 'deepagents'
import s19 from '@/lib/evals/agent/reports/skills-s19.json'
import thresholds from '@/lib/evals/agent/thresholds.json'
import type { AdminClient } from '@/lib/harness/types'
import { parseSkillMd, skillFile } from '@/lib/skills/parse'
import { ARTIFACT_TYPES, artifactIdFromPath, artifactPath, getArtifact, listArtifacts, type ArtifactRow, type ArtifactType } from './artifacts'

export const NO_TASTE_YET = 'Cello has not learned anything about your taste yet. React to a few roles on Today.'
export const READ_ONLY_TASTE = "Taste is read from the person's reactions to roles. It cannot be edited here."
export const USE_ARTIFACT_TOOLS = 'Use create_artifact or update_artifact to change an artifact. Files under /artifacts cannot be written directly.'
export const READ_ONLY_SKILLS = 'Skills are read-only.'

// --- permissions --------------------------------------------------------------------

/**
 * Filesystem permissions per agent loop. First match wins. The orchestrator
 * reads everything and writes only scratch space. The Researcher also reads
 * everything and writes nothing at all (it returns text, and the dossier is
 * saved in code). The Writer and Scout are workflows with no file tools:
 * they save through createArtifact, limited to their own types (ARTIFACT_WRITE_TYPES).
 */
export const PERMISSIONS: Record<'orchestrator' | 'researcher', FilesystemPermission[]> = {
  orchestrator: [{ operations: ['write'], paths: ['/memories/**', '/artifacts/**', '/skills/**'], mode: 'deny' }],
  researcher: [
    { operations: ['read'], paths: ['/**'], mode: 'allow' },
    { operations: ['write'], paths: ['/**'], mode: 'deny' },
  ],
}

/** The artifact types each specialist may create or revise. Enforced where they save. */
export const ARTIFACT_WRITE_TYPES: Record<'scout' | 'researcher' | 'writer' | 'cello', readonly ArtifactType[]> = {
  scout: ['shortlist'],
  researcher: ['research'],
  writer: ['resume', 'cover_letter', 'message'],
  cello: ARTIFACT_TYPES,
}

// --- helpers ------------------------------------------------------------------------

/** One page of a text, with the line numbers the filesystem tools expect. */
export function pageText(text: string, offset = 0, limit = 500) {
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const lines = text.split('\n')
  const total = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  const selected = lines.slice(start, start + count)
  if (selected.length === 0 || start >= total || count === 0) return { content: selected.join('\n'), mimeType: 'text/markdown' }
  const end = Math.min(start + selected.length, total)
  return {
    content: selected.join('\n'),
    mimeType: 'text/markdown',
    totalLines: total,
    startLine: start + 1,
    endLine: end,
    nextOffset: end < total ? end : undefined,
  }
}

const rawFile = (text: string, modifiedAt?: string) => {
  const at = modifiedAt ?? new Date().toISOString()
  return { content: text, mimeType: 'text/markdown', created_at: at, modified_at: at }
}

/** A small glob: ** matches any depth, * matches within one segment. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?')
  return new RegExp(`^${body}$`)
}

function grepText(pattern: string, filePath: string, text: string): GrepMatch[] {
  const out: GrepMatch[] = []
  text.split('\n').forEach((line, i) => {
    if (line.includes(pattern)) out.push({ path: filePath, line: i + 1, text: line })
  })
  return out
}

// --- artifacts ----------------------------------------------------------------------

/** /artifacts/ as files. Reads render the current version. Every write says what to use instead. */
export class ArtifactsBackend implements BackendProtocolV2 {
  constructor(private readonly deps: { admin: AdminClient; userId: string }) {}

  private async rows(type?: ArtifactType, limit = 100): Promise<ArtifactRow[]> {
    return listArtifacts(this.deps.admin, this.deps.userId, { type, limit })
  }

  async ls(dir: string) {
    const clean = dir.replace(/\/+$/, '')
    if (clean === '' || clean === '/') {
      const files: FileInfo[] = ARTIFACT_TYPES.map((t) => ({ path: `/${t}/`, is_dir: true, size: 0, modified_at: '' }))
      return { files }
    }
    const type = clean.slice(1) as ArtifactType
    if (!ARTIFACT_TYPES.includes(type)) return { files: [] }
    const rows = await this.rows(type)
    return {
      files: rows.map((r) => ({ path: artifactPath(r).replace('/artifacts', ''), is_dir: false, size: 0, modified_at: r.updated_at })),
    }
  }

  async read(filePath: string, offset?: number, limit?: number) {
    const found = await this.find(filePath)
    if (!found) return { error: `File '${filePath}' not found` }
    return pageText(found.version.content_text, offset, limit)
  }

  async readRaw(filePath: string) {
    const found = await this.find(filePath)
    if (!found) return { error: `File '${filePath}' not found` }
    return { data: rawFile(found.version.content_text, found.artifact.updated_at) }
  }

  async grep(pattern: string, dir?: string | null, glob?: string | null, maxCount?: number | null) {
    const matches: GrepMatch[] = []
    const re = glob ? globToRegExp(glob.startsWith('/') ? glob : `**/${glob}`) : null
    for (const row of await this.rows(undefined, 50)) {
      const p = artifactPath(row).replace('/artifacts', '')
      if (dir && dir !== '/' && !p.startsWith(dir.endsWith('/') ? dir : `${dir}/`)) continue
      if (re && !re.test(p)) continue
      const full = await getArtifact(this.deps.admin, this.deps.userId, row.id)
      if (full) matches.push(...grepText(pattern, p, full.version.content_text))
      if (maxCount && matches.length >= maxCount) return { matches: matches.slice(0, maxCount), truncated: true }
    }
    return { matches }
  }

  async glob(pattern: string, dir = '/') {
    const re = globToRegExp(pattern.startsWith('/') ? pattern : `${dir.replace(/\/$/, '')}/${pattern}`)
    const rows = await this.rows()
    return {
      files: rows
        .map((r) => ({ path: artifactPath(r).replace('/artifacts', ''), is_dir: false, size: 0, modified_at: r.updated_at }))
        .filter((f) => re.test(f.path)),
    }
  }

  async write() {
    return { error: USE_ARTIFACT_TOOLS }
  }

  async edit() {
    return { error: USE_ARTIFACT_TOOLS }
  }

  async delete() {
    return { error: USE_ARTIFACT_TOOLS }
  }

  private async find(filePath: string) {
    const id = artifactIdFromPath(`/artifacts${filePath}`)
    return id ? getArtifact(this.deps.admin, this.deps.userId, id) : null
  }
}

// --- taste --------------------------------------------------------------------------

/** How many of the person's latest reactions /memories/taste.md shows. */
export const TASTE_REACTIONS = 20

interface ReactionRow {
  reaction: string
  reason: string | null
  job_title: string | null
  company_name: string | null
  created_at: string
}

const REACTION_LABELS: Record<string, string> = { interested: 'Interested', not_for_me: 'Not for me', applied: 'Applied' }

/** The person's last reactions to roles, newest first. Everything the agent knows about taste comes from them. */
export async function renderTaste(admin: AdminClient, userId: string): Promise<{ text: string; updatedAt: string }> {
  const { data } = await admin
    .from('role_reactions')
    .select('reaction, reason, job_title, company_name, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(TASTE_REACTIONS)
  const rows = (data as ReactionRow[] | null) ?? []
  if (rows.length === 0) return { text: NO_TASTE_YET, updatedAt: '' }
  const lines = rows.map((r) => {
    const role = `${r.job_title ?? 'A role'}${r.company_name ? ` at ${r.company_name}` : ''}`
    return `- ${REACTION_LABELS[r.reaction] ?? r.reaction}: ${role}${r.reason ? ` (${r.reason})` : ''}, ${r.created_at.slice(0, 10)}`
  })
  return {
    text: `# What Cello has seen of your taste\n\nYour last ${rows.length} reactions to roles, newest first.\n\n${lines.join('\n')}\n`,
    updatedAt: rows[0].created_at,
  }
}

const TASTE_PATH = '/taste.md'

/** /memories/: one read-only file with the person's recent reactions. */
export class MemoriesBackend implements BackendProtocolV2 {
  constructor(private readonly deps: { admin: AdminClient; userId: string }) {}

  private taste() {
    return renderTaste(this.deps.admin, this.deps.userId)
  }

  async ls(dir: string) {
    const clean = dir.replace(/\/+$/, '')
    if (clean !== '' && clean !== '/') return { files: [] }
    const taste = await this.taste()
    return { files: [{ path: TASTE_PATH, is_dir: false, size: taste.text.length, modified_at: taste.updatedAt }] }
  }

  async read(filePath: string, offset?: number, limit?: number) {
    if (filePath !== TASTE_PATH) return { error: `File '${filePath}' not found` }
    return pageText((await this.taste()).text, offset, limit)
  }

  async readRaw(filePath: string) {
    if (filePath !== TASTE_PATH) return { error: `File '${filePath}' not found` }
    const t = await this.taste()
    return { data: rawFile(t.text, t.updatedAt || undefined) }
  }

  async grep(pattern: string, dir?: string | null) {
    if (dir && dir !== '/') return { matches: [] }
    return { matches: grepText(pattern, TASTE_PATH, (await this.taste()).text) }
  }

  async glob(pattern: string) {
    const matches = globToRegExp(pattern.startsWith('/') ? pattern : `/${pattern}`).test(TASTE_PATH)
    return { files: matches ? [{ path: TASTE_PATH, is_dir: false, size: 0, modified_at: '' }] : [] }
  }

  async write() {
    return { error: READ_ONLY_TASTE }
  }

  async edit() {
    return { error: READ_ONLY_TASTE }
  }

  async delete() {
    return { error: READ_ONLY_TASTE }
  }
}

// --- skills -------------------------------------------------------------------------

export type SkillTier = 'local' | 'free' | 'paid'
export type SkillMiss = 'trigger' | 'checks' | 'unmeasured'
/** Cello's own skills for v2, in the order the skills page lists them. */
export const CELLO_SKILLS = ['find-roles', 'company-research', 'tailor-resume', 'answer-questions', 'cold-outreach', 'follow-up', 'compare-roles', 'board-reader'] as const

type Bar = 'trigger' | 'checks'
type Report = { perSkill: { skill: string; trigger: number | null; checks: number | null }[] }
const BARS = thresholds.skills as Record<string, Record<Bar, number>>
// The recorded S19 run (lib/evals/agent/reports/skills-s19.json, written by skills.eval.test.ts) is the free tier's.
// ponytail: local and paid have no report yet, so every Cello skill is unmeasured there; v2-9 adds its per-tier
// report files (skills-s19-local.json, skills-s19-paid.json) to this map when it measures them.
const REPORTS: Partial<Record<SkillTier, Report>> = { free: s19 as Report }
const NOT_MEASURED = 'Not measured on this kind of model yet'
const SKILLS_DIR = () => path.join(process.cwd(), 'skills')

/** The skill folders on disk, read at call time. A folder list that cannot be read counts as none. */
function skillFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return []
  }
}

// A float must not push a bar up a notch: 0.7 * 10 is 7.000000000000001.
const need = (bar: number, n: number) => Math.ceil(bar * n - 1e-9)

/** Why a skill is off on a tier: the bars it missed and the sentence for them. Both empty when it is on. */
function judge(tier: SkillTier, name: string): { misses: SkillMiss[]; reason: string | null } {
  const row = REPORTS[tier]?.perSkill.find((r) => r.skill === name)
  const bar = BARS[name]
  if (!row || !bar) return { misses: ['unmeasured'], reason: NOT_MEASURED }
  const misses: Bar[] = []
  const said: string[] = []
  const miss = (b: Bar, sentence: string) => {
    misses.push(b)
    said.push(sentence)
  }
  if (row.trigger === null) miss('trigger', 'Its picks could not be read')
  else if (row.trigger < bar.trigger) miss('trigger', `Picked ${Math.round(row.trigger * 3)} of 3 times, it needs ${need(bar.trigger, 3)} of 3`)
  if (row.checks === null) miss('checks', 'Its answers could not be read')
  else if (row.checks < bar.checks) miss('checks', `Its answers passed ${Math.round(row.checks * 10)} of 10 checks, it needs ${need(bar.checks, 10)} of 10`)
  return { misses, reason: said.length ? `${said.join('. ')}.` : null }
}

/**
 * Every skill folder that is off on this tier, and the bars it missed. Off only because a recorded run put it below
 * its own bar, or because no run measured it: a folder with no row in the tier's report (or a tier with no report, or
 * no bar for the folder) is ['unmeasured'], never served on trust. "Cannot read" (null) counts as missing. A skill
 * comes back by earning its bars in a new run.
 */
export function skillsOff(tier: SkillTier, skillsDir: string = SKILLS_DIR()): Readonly<Record<string, readonly SkillMiss[]>> {
  return Object.fromEntries(
    skillFolders(skillsDir)
      .map((name) => [name, judge(tier, name).misses] as const)
      .filter(([, misses]) => misses.length),
  )
}

/** Kept for the orchestrator and the Researcher: skillsOff('free'). */
export const SKILLS_OFF: Readonly<Record<string, readonly SkillMiss[]>> = skillsOff('free')

export interface CelloSkillView {
  name: string
  description: string
  tiers: Record<SkillTier, { on: boolean; reason: string | null }>
}

/** Cello's own skills with their state on each tier. A folder that is missing is off and unmeasured, never on. */
export function celloSkillStates(skillsDir: string = SKILLS_DIR()): CelloSkillView[] {
  const here = new Set(skillFolders(skillsDir))
  return CELLO_SKILLS.map((name) => {
    let description = ''
    if (here.has(name)) {
      try {
        const parsed = parseSkillMd(readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8'))
        if (parsed.ok) description = parsed.description
      } catch {
        // A folder without a readable SKILL.md is listed with no description, and is off like a missing one.
      }
    }
    const tier = (t: SkillTier) => {
      const j = description && here.has(name) ? judge(t, name) : { misses: ['unmeasured'], reason: NOT_MEASURED }
      return { on: j.misses.length === 0, reason: j.reason }
    }
    return { name, description, tiers: { local: tier('local'), free: tier('free'), paid: tier('paid') } }
  })
}

/** apps/web/skills as read-only files, without the skills that are switched off. */
export class ReadOnlySkills implements BackendProtocolV2 {
  private readonly fs: FilesystemBackend
  constructor(
    rootDir: string = path.join(process.cwd(), 'skills'),
    private readonly hidden: readonly string[] = Object.keys(skillsOff('free', rootDir)),
  ) {
    this.fs = new FilesystemBackend({ rootDir, virtualMode: true })
  }
  /** Paths arrive with "/skills" already stripped, so the first segment is the skill folder. */
  private off(p: string): boolean {
    return this.hidden.includes(p.split('/').filter(Boolean)[0] ?? '')
  }
  private gone(p: string) {
    return { error: `File '${p}' not found` }
  }
  async ls(dir: string) {
    const r = await this.fs.ls(dir)
    return r.files ? { ...r, files: r.files.filter((f) => !this.off(f.path)) } : r
  }
  async read(filePath: string, offset?: number, limit?: number) {
    return this.off(filePath) ? this.gone(filePath) : this.fs.read(filePath, offset, limit)
  }
  async readRaw(filePath: string) {
    return this.off(filePath) ? this.gone(filePath) : this.fs.readRaw(filePath)
  }
  async grep(pattern: string, dir?: string | null, glob?: string | null, maxCount?: number | null) {
    const r = await this.fs.grep(pattern, dir ?? undefined, glob, maxCount)
    return r.matches ? { ...r, matches: r.matches.filter((m) => !this.off(m.path)) } : r
  }
  async glob(pattern: string, dir?: string) {
    const r = await this.fs.glob(pattern, dir)
    return r.files ? { ...r, files: r.files.filter((f) => !this.off(f.path)) } : r
  }
  // The skills middleware loads every SKILL.md through downloadFiles.
  async downloadFiles(paths: string[]) {
    const gone = (p: string) => ({ path: p, content: null, error: 'file_not_found' as const })
    const open = paths.filter((p) => !this.off(p))
    const got = open.length && this.fs.downloadFiles ? await this.fs.downloadFiles(open) : open.map(gone)
    // The backend answers in the order asked, so the answers go back into the positions of the paths that were let through.
    let i = 0
    return paths.map((p) => (this.off(p) ? gone(p) : got[i++]))
  }
  async write() {
    return { error: READ_ONLY_SKILLS }
  }
  async edit() {
    return { error: READ_ONLY_SKILLS }
  }
  async delete() {
    return { error: READ_ONLY_SKILLS }
  }
}

// --- the person's own skills --------------------------------------------------------

interface PersonSkillRow {
  name: string
  description: string
  body: string
  updated_at?: string
}

/**
 * /my-skills/: the skills the person added and left on, one /<name>/SKILL.md each. The file is built by skillFile from
 * the stored name, description and body, so nothing but those two frontmatter keys is ever served: a skill grants no
 * tool and no permission. Rows are this user's own and enabled only; they are read once per instance.
 */
export class PersonSkills implements BackendProtocolV2 {
  private cached?: Promise<{ name: string; file: string; at: string }[]>
  constructor(private readonly deps: { admin: AdminClient; userId: string }) {}

  private files() {
    this.cached ??= (async () => {
      const { data, error } = await this.deps.admin
        .from('person_skills')
        .select('name, description, body, updated_at')
        .eq('user_id', this.deps.userId)
        .eq('enabled', true)
        .order('name')
      if (error) {
        this.cached = undefined
        return []
      }
      return ((data as PersonSkillRow[] | null) ?? []).map((r) => ({ name: r.name, file: skillFile(r.name, r.description, r.body), at: r.updated_at ?? '' }))
    })()
    return this.cached
  }

  private static path = (name: string) => `/${name}/SKILL.md`

  private async find(filePath: string) {
    return (await this.files()).find((f) => PersonSkills.path(f.name) === filePath)
  }

  async ls(dir: string) {
    const clean = dir.replace(/\/+$/, '')
    const all = await this.files()
    if (clean === '' || clean === '/') return { files: all.map((f) => ({ path: `/${f.name}/`, is_dir: true, size: 0, modified_at: f.at })) }
    return { files: all.filter((f) => clean === `/${f.name}`).map((f) => ({ path: PersonSkills.path(f.name), is_dir: false, size: f.file.length, modified_at: f.at })) }
  }

  async read(filePath: string, offset?: number, limit?: number) {
    const f = await this.find(filePath)
    return f ? pageText(f.file, offset, limit) : { error: `File '${filePath}' not found` }
  }

  async readRaw(filePath: string) {
    const f = await this.find(filePath)
    return f ? { data: rawFile(f.file, f.at || undefined) } : { error: `File '${filePath}' not found` }
  }

  async grep(pattern: string, dir?: string | null, glob?: string | null, maxCount?: number | null) {
    const re = glob ? globToRegExp(glob.startsWith('/') ? glob : `**/${glob}`) : null
    const base = dir && dir !== '/' ? (dir.endsWith('/') ? dir : `${dir}/`) : ''
    const matches: GrepMatch[] = []
    for (const f of await this.files()) {
      const p = PersonSkills.path(f.name)
      if ((base && !p.startsWith(base)) || (re && !re.test(p))) continue
      matches.push(...grepText(pattern, p, f.file))
    }
    return maxCount && matches.length > maxCount ? { matches: matches.slice(0, maxCount), truncated: true } : { matches }
  }

  async glob(pattern: string, dir = '/') {
    const re = globToRegExp(pattern.startsWith('/') ? pattern : `${dir.replace(/\/$/, '')}/${pattern}`)
    return {
      files: (await this.files())
        .filter((f) => re.test(PersonSkills.path(f.name)))
        .map((f) => ({ path: PersonSkills.path(f.name), is_dir: false, size: f.file.length, modified_at: f.at })),
    }
  }

  // The skills middleware loads every SKILL.md through downloadFiles.
  async downloadFiles(paths: string[]) {
    const all = await this.files()
    return paths.map((p) => {
      const f = all.find((x) => PersonSkills.path(x.name) === p)
      return f ? { path: p, content: new TextEncoder().encode(f.file), error: null } : { path: p, content: null, error: 'file_not_found' as const }
    })
  }

  async write() {
    return { error: READ_ONLY_SKILLS }
  }

  async edit() {
    return { error: READ_ONLY_SKILLS }
  }

  async delete() {
    return { error: READ_ONLY_SKILLS }
  }
}

// --- the composite ------------------------------------------------------------------

export interface CelloBackendDeps {
  admin: AdminClient
  userId: string
  skillsDir?: string
  /** A test and eval seam: replaces the skills that are off, so an eval can still measure a skill that is off. */
  hiddenSkills?: readonly string[]
  /** The kind of model this turn runs on; Cello's own skills are served only where they met their bars. Free when left out. */
  skillsTier?: SkillTier
}

export function celloBackend(deps: CelloBackendDeps): CompositeBackend {
  return new CompositeBackend(new StateBackend(), {
    '/memories/': new MemoriesBackend(deps),
    '/artifacts/': new ArtifactsBackend(deps),
    '/skills/': new ReadOnlySkills(deps.skillsDir, deps.hiddenSkills ?? Object.keys(skillsOff(deps.skillsTier ?? 'free', deps.skillsDir))),
    '/my-skills/': new PersonSkills(deps),
  })
}
