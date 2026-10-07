// The agent's view of files: one CompositeBackend with four places.
//
//   /memories/        one read-only file, /memories/taste.md: the person's last reactions to roles
//   /artifacts/       the versioned artifacts table, shown as markdown files
//   /skills/          the SKILL.md files in apps/web/skills, read-only
//   everything else   scratch space in the thread's state
//
// Writes are refused by permissions for every agent loop (PERMISSIONS below), and
// the backends refuse them too, so a missing permission rule is not the only door.
// What Cello remembers about a person is mem0, written only by the remember tool, which
// checks the person's own words in code; there is no second memory store here.
// Artifacts change only through create_artifact and update_artifact.

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
import type { AdminClient } from '@/lib/harness/types'
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
  researcher: ['dossier'],
  writer: ['resume', 'cover_letter', 'outreach_email'],
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

/**
 * Skills that are switched off: they missed their own bar in the last recorded S19 run
 * (lib/evals/agent/reports/skills-s19.md), so no path serves them to a model. The value is the bars
 * each one missed; "cannot read" counts as both. A skill comes back by earning its bars in a new run
 * and leaving this list. lib/agents/skills-off.test.ts fails if this list and the report disagree.
 */
export const SKILLS_OFF: Readonly<Record<string, readonly ('trigger' | 'checks')[]>> = {}

/** apps/web/skills as read-only files, without the skills that are switched off. */
export class ReadOnlySkills implements BackendProtocolV2 {
  private readonly fs: FilesystemBackend
  constructor(
    rootDir: string = path.join(process.cwd(), 'skills'),
    private readonly hidden: readonly string[] = Object.keys(SKILLS_OFF),
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

// --- the composite ------------------------------------------------------------------

export interface CelloBackendDeps {
  admin: AdminClient
  userId: string
  skillsDir?: string
  /** A test and eval seam: replaces SKILLS_OFF, so an eval can still measure a skill that is off. */
  hiddenSkills?: readonly string[]
}

export function celloBackend(deps: CelloBackendDeps): CompositeBackend {
  return new CompositeBackend(new StateBackend(), {
    '/memories/': new MemoriesBackend(deps),
    '/artifacts/': new ArtifactsBackend(deps),
    '/skills/': new ReadOnlySkills(deps.skillsDir, deps.hiddenSkills),
  })
}
