'use client'

// Your skills (T4): Cello's own skills with why one is off on a kind of model, the person's skills with a switch and
// Delete, pasting a SKILL.md, importing a folder. A skill tells Cello how to do one thing; it never gives it a tool.
// The folder is read here, in the browser, and only its text is sent. Types are local copies of the route's shapes
// (app/api/settings/skills/route.ts), so this file imports nothing from lib.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Key } from '@/components/ui/key'

export type SkillTier = 'local' | 'free' | 'paid'
export interface CelloSkillView {
  name: string
  description: string
  tiers: Record<SkillTier, { on: boolean; reason: string | null }>
}
export interface PersonSkillView {
  id: string
  name: string
  description: string
  source: string
  enabled: boolean
  created_at: string
}
export interface Refusal {
  message: string
  fix: string
}
export interface FolderFile {
  /** Path from the picked folder's name down, as the browser gives it: pack/refs/a.md */
  path: string
  size: number
  text: () => Promise<string>
}

export const INTRO = 'A skill tells Cello how to do one thing. It never gives Cello a new tool.'
const MAX_BYTES = 200_000

const LABELS: Record<string, string> = {
  'find-roles': 'Find roles',
  'company-research': 'Research a company',
  'tailor-resume': 'Tailor a resume',
  'answer-questions': 'Answer application questions',
  'cold-outreach': 'Write outreach',
  'follow-up': 'Follow up',
  'compare-roles': 'Compare roles',
  'board-reader': 'Read a posting',
}
const TIER_LABELS: [SkillTier, string][] = [
  ['free', 'Free models'],
  ['local', 'Models on this computer'],
  ['paid', 'Paid models'],
]

const GONE: Refusal = { message: 'Cello could not reach the server.', fix: 'Check your connection and try again.' }

async function refusalOf(res: Response): Promise<Refusal> {
  const b = (await res.json().catch(() => null)) as { message?: unknown; fix?: unknown } | null
  return typeof b?.message === 'string' && b.message ? { message: b.message, fix: typeof b.fix === 'string' && b.fix ? b.fix : 'Try again.' } : GONE
}

/** The folder's SKILL.md and the other .md files in it, or why it cannot be added. Checked here so nothing is sent for a folder that cannot work. */
export async function readFolder(files: FolderFile[]): Promise<{ ok: true; markdown: string; references: { path: string; text: string }[]; folder: string } | ({ ok: false } & Refusal)> {
  const md = files.filter((f) => /\.md$/i.test(f.path) && !f.path.split('/').some((seg, i) => i > 0 && seg.startsWith('.')))
  const main = md.find((f) => f.path.split('/').length === 2 && f.path.endsWith('/SKILL.md'))
  if (!main) return { ok: false, message: 'That folder has no SKILL.md.', fix: 'Pick the folder that holds it.' }
  if (md.reduce((n, f) => n + f.size, 0) > MAX_BYTES) return { ok: false, message: 'That is more than 200 KB.', fix: 'Remove some files and try again.' }
  const others = md.filter((f) => f !== main)
  const texts = await Promise.all(others.map((f) => f.text()))
  return {
    ok: true,
    markdown: await main.text(),
    references: others.map((f, i) => ({ path: f.path.slice(f.path.indexOf('/') + 1), text: texts[i] })),
    folder: main.path.split('/')[0],
  }
}

type Body = { markdown: string; references?: { path: string; text: string }[]; folder?: string }

export async function sendSkill(body: Body, f: typeof fetch = fetch): Promise<{ ok: true; skill: PersonSkillView } | ({ ok: false } & Refusal)> {
  try {
    const res = await f('/api/settings/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return { ok: false, ...(await refusalOf(res)) }
    return { ok: true, skill: ((await res.json()) as { skill: PersonSkillView }).skill }
  } catch {
    return { ok: false, ...GONE }
  }
}

export async function setSkillEnabled(id: string, enabled: boolean, f: typeof fetch = fetch): Promise<{ ok: true } | ({ ok: false } & Refusal)> {
  try {
    const res = await f('/api/settings/skills', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled }) })
    return res.ok ? { ok: true } : { ok: false, ...(await refusalOf(res)) }
  } catch {
    return { ok: false, ...GONE }
  }
}

export async function removeSkill(id: string, f: typeof fetch = fetch): Promise<{ ok: true } | ({ ok: false } & Refusal)> {
  try {
    const res = await f(`/api/settings/skills?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res.ok ? { ok: true } : { ok: false, ...(await refusalOf(res)) }
  } catch {
    return { ok: false, ...GONE }
  }
}

export function CelloSkillsView({ skills }: { skills: CelloSkillView[] }) {
  return (
    <ul className="divide-y divide-[var(--r-line)]">
      {skills.map((s) => (
        <li key={s.name} className="space-y-1 py-3">
          <p className="r-name">{LABELS[s.name] ?? s.name}</p>
          <p className="r-body">{s.description}</p>
          <ul className="r-meta">
            {TIER_LABELS.map(([t, label]) => (
              <li key={t}>
                {label}: {s.tiers[t].on ? 'On' : `Off. ${s.tiers[t].reason ?? ''}`.trim()}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

export function YoursView({ skills, busy, onToggle, onDelete }: { skills: PersonSkillView[]; busy: string | null; onToggle: (s: PersonSkillView) => void; onDelete: (s: PersonSkillView) => void }) {
  if (skills.length === 0) return <p className="r-body">You have not added a skill yet. Paste a SKILL.md or import a folder.</p>
  return (
    <ul className="divide-y divide-[var(--r-line)]">
      {skills.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <div className="min-w-0 flex-1 basis-56 space-y-1">
            <p className="r-name">{s.name}</p>
            <p className="r-body break-words">{s.description}</p>
            <p className="r-meta">{s.source}. Not measured: no eval set</p>
          </div>
          <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center gap-2 r-body">
            <input type="checkbox" role="switch" className="h-4 w-4" aria-label={`Use ${s.name}`} checked={s.enabled} disabled={busy === s.id} onChange={() => onToggle(s)} />
            Use
          </label>
          <Key variant="ghost" aria-label={`Delete ${s.name}`} disabled={busy === s.id} onClick={() => onDelete(s)}>Delete</Key>
        </li>
      ))}
    </ul>
  )
}

function Sheet({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className="r-sheet space-y-3 p-6">
      <h2 id={`${id}-h`} className="r-title">{title}</h2>
      {children}
    </section>
  )
}

export function Skills() {
  const [cello, setCello] = useState<CelloSkillView[] | null>(null)
  const [mine, setMine] = useState<PersonSkillView[] | null>(null)
  const [problem, setProblem] = useState<Refusal | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [adding, setAdding] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/skills')
      if (!res.ok) return setProblem(await refusalOf(res))
      const b = (await res.json()) as { cello: CelloSkillView[]; mine: PersonSkillView[] }
      setProblem(null)
      setCello(b.cello)
      setMine(b.mine)
    } catch {
      setProblem(GONE)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function add(body: Body) {
    setAdding(true)
    setProblem(null)
    setNote(null)
    const r = await sendSkill(body)
    setAdding(false)
    if (!r.ok) return setProblem({ message: r.message, fix: r.fix })
    setNote(`Added ${r.skill.name}.`)
    setMarkdown('')
    await load()
  }

  async function change(s: PersonSkillView, run: () => ReturnType<typeof removeSkill>, said: string) {
    setBusy(s.id)
    setProblem(null)
    setNote(null)
    const r = await run()
    setBusy(null)
    if (!r.ok) return setProblem({ message: r.message, fix: r.fix })
    setNote(said)
    await load()
  }

  async function pick(list: FileList | null) {
    if (!list || list.length === 0) return
    const files: FolderFile[] = Array.from(list).map((f) => ({ path: f.webkitRelativePath || f.name, size: f.size, text: () => f.text() }))
    if (picker.current) picker.current.value = ''
    const r = await readFolder(files)
    if (!r.ok) {
      setNote(null)
      return setProblem({ message: r.message, fix: r.fix })
    }
    await add({ markdown: r.markdown, references: r.references, folder: r.folder })
  }

  return (
    <div className="space-y-6">
      <p className="r-body">{INTRO}</p>
      {problem && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="r-body">
            <span className="font-semibold">{problem.message}</span> {problem.fix}
          </p>
          {mine === null && <Key variant="raised" onClick={() => void load()}>Try again</Key>}
        </div>
      )}
      {note && <p role="status" className="r-meta">{note}</p>}

      <Sheet id="cello-skills" title="Cello's skills">
        {cello === null ? <p className="r-meta">{problem ? 'Not read yet.' : 'Reading your skills.'}</p> : <CelloSkillsView skills={cello} />}
      </Sheet>

      <Sheet id="yours" title="Yours">
        {mine === null ? <p className="r-meta">{problem ? 'Not read yet.' : 'Reading your skills.'}</p> : (
          <YoursView
            skills={mine}
            busy={busy}
            onToggle={(s) => void change(s, () => setSkillEnabled(s.id, !s.enabled), 'Saved.')}
            onDelete={(s) => void change(s, () => removeSkill(s.id), `Deleted ${s.name}.`)}
          />
        )}
      </Sheet>

      <Sheet id="paste" title="Paste a SKILL.md">
        <label htmlFor="skill-markdown" className="r-meta">The whole file, starting with the name and description at the top.</label>
        <textarea id="skill-markdown" className="r-field font-mono" rows={8} value={markdown} onChange={(e) => setMarkdown(e.target.value)} />
        <Key variant="ink" disabled={adding || !markdown.trim()} onClick={() => void add({ markdown })}>{adding ? 'Adding' : 'Add skill'}</Key>
      </Sheet>

      <Sheet id="import" title="Import a folder">
        <p className="r-meta">Pick the folder that holds SKILL.md. Cello reads its .md files here, in your browser, and adds them as one skill. Up to 200 KB.</p>
        <input
          ref={picker}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Import a folder"
          // webkitdirectory is not in React's input types
          {...({ webkitdirectory: '' } as object)}
          onChange={(e) => void pick(e.target.files)}
        />
        <Key variant="raised" disabled={adding} onClick={() => picker.current?.click()}>Choose a folder</Key>
      </Sheet>
    </div>
  )
}
