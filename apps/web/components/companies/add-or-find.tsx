'use client'

// Add or find a company: one field that is the page's search and its way in. A name finds every verified
// employer Cello knows (then the ones it has not checked yet); a pasted link or a chosen candidate is checked live
// through companies.add and ends as Added or as one sentence with a button for each thing Cello did find. Nothing
// unverified is ever added from here.

import { Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useReducer, useRef, useState } from 'react'
import { Key } from '@/components/ui/key'
import { LogoTile } from '@/components/roles/role-tile'
import { followAnyway, findCompaniesAction } from '@/app/(app)/companies/actions'
import { companyHref } from '@/lib/routes/companies'
import {
  addOutcome,
  addReducer,
  classifyInput,
  followedLine,
  forYouLine,
  unknownLine,
  verifyingLine,
  type AddAction,
  type AddContext,
  type AddResponse,
  type AddState,
  type Found,
} from './logic'
import { refreshCompanyJobs } from './refresh'

export interface AddOrFindProps {
  /** Called once an employer was followed, so the page behind can read again. */
  onAdded?: () => void
  autoFocus?: boolean
  /** The state to open in; the fixtures show each one without a network. */
  initial?: AddState
}

type By = { employerId: string } | { candidateId: string } | { link: string }

export function AddOrFind({ onAdded, autoFocus, initial }: AddOrFindProps) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(0)
  const [text, setText] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [finding, setFinding] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [add, dispatch] = useReducer(addReducer, initial ?? { kind: 'idle' })
  const typed = classifyInput(text)

  // The type-ahead: from the second character, once typing pauses. A slower answer never replaces a newer one.
  useEffect(() => {
    if (typed.kind !== 'name') {
      setFound(null)
      setFailed(null)
      setFinding(false)
      return
    }
    const id = ++latest.current
    setFinding(true)
    const t = setTimeout(async () => {
      const r = await findCompaniesAction(typed.text).catch(() => ({ error: 'Could not search companies. Try again.' }))
      if (id !== latest.current) return
      setFailed('error' in r ? r.error : null)
      setFound('error' in r ? null : r)
      setFinding(false)
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed.kind === 'name' ? typed.text : typed.kind])

  async function run(by: By, ctx: AddContext) {
    dispatch({ type: 'verify', line: verifyingLine(ctx) })
    try {
      const res = await fetch('/api/companies/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(by) })
      const body = (await res.json().catch(() => null)) as AddResponse | { error: string } | null
      if (!body || !('ok' in body)) {
        dispatch({ type: 'result', state: { kind: 'failed', line: 'Could not reach Cello. Try again.', reason: 'network', actions: [] } })
        return
      }
      dispatch({ type: 'result', state: addOutcome(body, ctx) })
      if (body.ok) {
        if (!body.already) void refreshCompanyJobs(body.companyId)
        setFound(null)
        onAdded?.()
        router.refresh()
      }
    } catch {
      dispatch({ type: 'result', state: { kind: 'failed', line: 'Could not reach Cello. Try again.', reason: 'network', actions: [] } })
    }
  }

  async function doAction(a: AddAction) {
    if (a.kind === 'follow') return run({ employerId: a.employerId }, { name: a.label.replace(/^Follow /, '') })
    if (a.kind === 'link') return run({ link: a.link }, { link: a.link })
    if (a.kind === 'paste') {
      setText('')
      dispatch({ type: 'reset' })
      return input.current?.focus()
    }
    if (a.kind === 'anyway') {
      dispatch({ type: 'verify', line: 'Following it by the address you gave.' })
      const r = await followAnyway(a.link).catch(() => null)
      if (r?.ok) {
        dispatch({ type: 'result', state: { kind: 'added', line: followedLine(r.name), actions: [] } })
        void refreshCompanyJobs(r.companyId)
        setFound(null)
        onAdded?.()
        router.refresh()
      } else dispatch({ type: 'result', state: { kind: 'failed', line: r?.sentence ?? 'Could not save that. Try again.', reason: 'not_saved', actions: [] } })
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (typed.kind === 'link') void run({ link: typed.text }, { link: typed.text })
  }

  const name = typed.kind === 'name' ? typed.text : null
  const none = name !== null && found && !finding && found.employers.length === 0 && found.notChecked.length === 0

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2" role="search">
        <label className="relative block min-w-0 flex-1 basis-64">
          <span className="sr-only">Add or find a company</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-r-ink-3" strokeWidth={1.75} aria-hidden />
          <input
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              dispatch({ type: 'reset' })
            }}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            placeholder="Name, or a careers page or job board link"
            aria-label="Add or find a company"
            className="r-field w-full pl-10"
          />
        </label>
        {typed.kind === 'link' && <Key type="submit">Check and follow</Key>}
      </form>

      {add.kind === 'verifying' && (
        <p role="status" className="r-body">
          {add.line}
        </p>
      )}
      {(add.kind === 'added' || add.kind === 'failed') && (
        <div role="status" className="space-y-2">
          <p className="r-body">{add.line}</p>
          {add.actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {add.actions.map((a) =>
                a.kind === 'open' ? (
                  <Key key={a.label} asChild variant="raised">
                    {a.external ? (
                      <a href={a.href} target="_blank" rel="noopener noreferrer">
                        {a.label}
                      </a>
                    ) : (
                      <Link href={a.href}>{a.label}</Link>
                    )}
                  </Key>
                ) : (
                  <Key key={a.label} variant="raised" onClick={() => doAction(a)}>
                    {a.label}
                  </Key>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {typed.kind === 'name' && found && (found.employers.length > 0 || found.notChecked.length > 0) && (
        <div className="r-sheet space-y-1">
          {found.employers.map((e) => {
            const line = forYouLine(e)
            return (
              <div key={e.id} className="r-row flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-3">
                <LogoTile name={e.name} domain={e.domain} logoUrl={e.logoUrl} companyId={e.id} size={40} />
                <div className="min-w-0 flex-1 basis-40">
                  <Link href={companyHref(e.id)} prefetch={false} className="r-name hover:underline">
                    {e.name}
                  </Link>
                  <p className="r-meta">{[e.domain, line?.head].filter(Boolean).join(' · ')}</p>
                </div>
                {e.following ? (
                  <span className="r-meta px-2">Following</span>
                ) : (
                  <Key variant="raised" aria-label={`Follow ${e.name}`} onClick={() => run({ employerId: e.id }, { name: e.name })}>
                    Follow
                  </Key>
                )}
              </div>
            )
          })}
          {found.notChecked.length > 0 && (
            <>
              <h3 className="r-meta px-2 pt-2">Not checked yet</h3>
              {found.notChecked.map((c) => (
                <div key={c.id} className="r-row flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-3">
                  <LogoTile name={c.name} domain={c.domain} size={40} />
                  <div className="min-w-0 flex-1 basis-40">
                    <span className="r-name">{c.name}</span>
                    {c.domain && <p className="r-meta">{c.domain}</p>}
                  </div>
                  <Key variant="raised" onClick={() => run({ candidateId: c.id }, { name: c.name, domain: c.domain })}>
                    Check and follow
                  </Key>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {failed && !finding && (
        <p role="status" className="r-body">
          {failed}
        </p>
      )}

      {none && name && (
        <div className="space-y-2">
          <p className="r-body">{unknownLine(name)}</p>
          <Key variant="raised" onClick={() => doAction({ kind: 'paste', label: 'Paste their careers page' })}>
            Paste their careers page
          </Key>
        </div>
      )}
    </div>
  )
}
