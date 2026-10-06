'use client'

// The Chat page: the rail on the left, the conversation in the middle with its compose box fixed at the bottom, and
// the side panel on the right only while a made thing is open. Everything it shows is read from rows through
// /api/chat: tiles with names, answers as the parts code passed, cards from stored rows, the tasks line from agent_tasks.
// ponytail: tasks are polled every 2 s while one is working; Realtime replaces the poll when the stream route lands.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { Markdown } from '@/components/chat/markdown'
import { ModelPicker, type PickScope } from '@/components/chat/model-picker'
import { Composer } from '@/components/chat/composer'
import { AnswerParts, type Named } from '@/components/chat/parts'
import { Finder } from '@/components/chat/finder'
import { Rail, type EarlierChat, type RailChat, type ScheduledRow } from '@/components/chat/rail'
import { SidePanel } from '@/components/chat/side-panel'
import { StatusTurn } from '@/components/chat/status-turn'
import { TasksLine, type TaskRow, type TaskStatus } from '@/components/chat/tasks-line'
import { Tiles, type TileData } from '@/components/chat/tiles'
import { disclosureLine, type Disclosure } from '@/lib/chat/disclosure'
import type { Found } from '@/lib/chat/find'
import { chatHref } from '@/lib/chat/links'
import type { ChatPageData } from '@/lib/chat/page-data'
import type { SettingsView } from '@/lib/chat/settings'
import type { Suggestions } from '@/lib/chat/suggest'
import { refId, type AttachKind } from '@/lib/chat/types'
import { visibleTurns } from '@/lib/chat/versions'
import type { ModelChoice } from '@/lib/models/choice'
import { createClient } from '@/lib/supabase/client'

export interface ChatViewProps {
  /** The chat to open; null for a new one. */
  chatId: string | null
  person: { name: string }
  /** A question carried in by /ask?ask= or a quick chat: put in the compose box, never sent for the person. */
  initialAsk?: string
  /** A thing the person was looking at: a chip in the compose box that attaches when the first turn is sent. */
  initialAbout?: { kind: string; ref: string }
}

// ponytail: Send is switched on by the stream route of the engine package; until then the compose box says so.
const SEND_NOTICE = 'Chat cannot send yet. Every page and button works without it.'
const POLL_MS = 2000
const PAGE = 50
/** "@" and then the start of a name, at the end of what is typed. */
const AT_WORD = /(^|\s)@([^\s@]{0,40})$/

type ListRow = { id: string; title: string; pinned_at: string | null; last_turn_at: string }

/** The ref object /api/chat/[id]/attachments reads for a thing's id (the server checks it strictly). */
const refOf = (kind: string, id: string) => (kind === 'chat' ? { chat_id: id } : kind === 'made' ? { table: 'artifacts', id } : { id })

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

async function send(url: string, method: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return res.ok
  } catch {
    return false
  }
}

const toTaskRow = (t: ChatPageData['tasks'][number]): TaskRow => ({ id: t.id, title: t.title, status: t.status as TaskStatus, command: t.command, reads: t.reads?.length ?? 0 })
const alive = (t: TaskRow) => t.status === 'queued' || t.status === 'working'
const seconds = (rows: ChatPageData['tasks']) => {
  const starts = rows.map((r) => Date.parse(r.started_at ?? r.created_at)).filter((n) => !Number.isNaN(n))
  const ends = rows.map((r) => (r.finished_at ? Date.parse(r.finished_at) : Date.now()))
  return starts.length ? Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000)) : 0
}

export function ChatView({ chatId, person, initialAsk, initialAbout }: ChatViewProps) {
  const router = useRouter()
  const [rows, setRows] = useState<ListRow[]>([])
  const [more, setMore] = useState(false)
  const [earlier, setEarlier] = useState<EarlierChat[]>([])
  // Null until it has been read, and when it cannot be: the rail then says nothing rather than "Nothing scheduled".
  const [scheduled, setScheduled] = useState<ScheduledRow[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addWords, setAddWords] = useState('')
  const [picks, setPicks] = useState<Record<string, number>>({})
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const paging = useRef(false)
  const [page, setPage] = useState<ChatPageData | null>(null)
  const [missing, setMissing] = useState(false)
  const [suggested, setSuggested] = useState<Suggestions | null>(null)
  const [draft, setDraft] = useState(initialAsk ?? '')
  const [panel, setPanel] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(false)
  const [quoted, setQuoted] = useState<{ text: string; turn_id: string } | null>(null)
  const [chips, setChips] = useState<{ kind: string; ref: string; name: string }[]>([])
  const [selection, setSelection] = useState<{ text: string; turnId: string; x: number; y: number } | null>(null)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  // A choice made before the chat exists, or for one message: used by the next send. ponytail: stored on the chat when the first turn creates it.
  const [pending, setPending] = useState<ModelChoice | null>(null)
  const [estimate, setEstimate] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadChats = useCallback(async () => {
    const body = await getJson<{ chats: ListRow[] }>(`/api/chat?limit=${PAGE}`)
    if (!body) return
    setRows(body.chats)
    setMore(body.chats.filter((c) => !c.pinned_at).length >= PAGE)
  }, [])

  // The next page of Recents, from the last chat listed. ponytail: pages by last_turn_at, so two chats with the very same instant could straddle a page.
  const loadMore = useCallback(async () => {
    const last = [...rows].reverse().find((c) => !c.pinned_at)
    if (paging.current || !last) return
    paging.current = true
    const body = await getJson<{ chats: ListRow[] }>(`/api/chat?limit=${PAGE}&before=${encodeURIComponent(last.last_turn_at)}`)
    paging.current = false
    if (!body) return setMore(false)
    setRows((have) => [...have, ...body.chats.filter((c) => !have.some((h) => h.id === c.id))])
    setMore(body.chats.length >= PAGE)
  }, [rows])

  const loadScheduled = useCallback(async () => {
    const body = await getJson<{ tasks: { id: string; name: string; card: { schedule: string; last: string | null; next: string | null } }[] }>('/api/scheduled-tasks')
    setScheduled(body ? body.tasks.map((t) => ({ id: t.id, name: t.name, detail: [t.card.schedule, t.card.last, t.card.next].filter(Boolean).join(' \u00b7 ') })) : null)
  }, [])

  useEffect(() => {
    void loadScheduled()
    void getJson<{ earlier: { id: string; title: string }[] }>('/api/chat?earlier=1').then((b) => b && setEarlier(b.earlier))
  }, [loadScheduled])

  const loadPage = useCallback(async () => {
    if (!chatId) return
    const body = await getJson<ChatPageData>(`/api/chat/${encodeURIComponent(chatId)}`)
    if (body) setPage(body)
    else setMissing(true)
  }, [chatId])

  useEffect(() => {
    void loadChats()
  }, [loadChats])

  useEffect(() => {
    setPage(null)
    setMissing(false)
    setPanel(null)
    void loadPage()
  }, [loadPage])

  const loadSettings = useCallback(async () => {
    setSettings(await getJson<SettingsView>(`/api/chat/settings${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`))
  }, [chatId])
  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const choice: ModelChoice | null = pending ?? (settings?.ran ? { rung: settings.ran.rung, model: settings.ran.model, effort: settings.ran.effort } : null)
  useEffect(() => {
    if (!choice) return setEstimate(null)
    void getJson<{ text: string }>(`/api/chat/estimate?rung=${choice.rung}&model=${encodeURIComponent(choice.model)}&effort=${choice.effort}`).then((e) => setEstimate(e?.text ?? null))
  }, [choice?.rung, choice?.model, choice?.effort]) // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(next: ModelChoice, scope: PickScope) {
    // One message, or this chat before it exists: held until the first turn is sent. A default needs no chat.
    if (scope === 'once' || (!chatId && scope === 'chat')) return setPending(next)
    const ok = await send('/api/chat/settings', 'POST', { ...(chatId ? { chat: chatId } : {}), choice: next, as_default: scope === 'default' })
    if (ok) setPending(null)
    else setNote('Cello could not save that choice. It is above what you allow, or the save failed.')
    await loadSettings()
  }

  const tasks = useMemo(() => (page?.tasks ?? []).map(toTaskRow), [page])
  const running = tasks.some(alive)
  useEffect(() => {
    if (!running) return
    poll.current = setInterval(() => void loadPage(), POLL_MS)
    return () => {
      if (poll.current) clearInterval(poll.current)
    }
  }, [running, loadPage])

  // A chip is read under the person's rights before it is shown; one that is not theirs never appears.
  useEffect(() => {
    if (!initialAbout) return
    void getJson<{ kind: string; ref: string; name: string }>(`/api/chat/object?kind=${encodeURIComponent(initialAbout.kind)}&ref=${encodeURIComponent(initialAbout.ref)}`).then((o) => o && setChips([o]))
  }, [initialAbout])

  const empty = !chatId || (page !== null && page.turns.length === 0)
  useEffect(() => {
    if (!empty || suggested) return
    void getJson<Suggestions>(`/api/chat/suggest?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`).then(setSuggested)
  }, [empty, suggested])

  const active = useMemo(() => (page?.attachments ?? []).filter((a) => !a.removed_at), [page])
  const names: Named[] = useMemo(() => (page?.attachments ?? []).map((a) => ({ kind: a.kind, ref: refId(a.kind, a.ref), name: page?.names[a.id] ?? 'No longer listed' })), [page])
  const tiles: TileData[] = useMemo(() => active.map((a) => ({ id: a.id, kind: a.kind, ref: refId(a.kind, a.ref), name: page?.names[a.id] ?? 'No longer listed', origin: a.origin })), [active, page])
  const seen = useMemo(() => visibleTurns(page?.turns ?? [], picks), [page, picks])
  const lastPersonTurn = [...seen.turns].reverse().find((t) => t.kind === 'person')
  const turnTasks = page?.tasks.filter((t) => t.turn_id === lastPersonTurn?.id) ?? []

  // Selecting text in one of Cello's answers offers "Ask Cello": the selection becomes a quote above the compose box,
  // kept apart from what the person types. It never counts as their words.
  function onSelect() {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    const anchor = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement
    const turn = anchor?.closest('[data-answer-turn]')
    if (!sel || sel.rangeCount === 0 || text.length < 3 || !turn) return setSelection(null)
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setSelection({ text: text.slice(0, 1500), turnId: turn.getAttribute('data-answer-turn') ?? '', x: rect.left + rect.width / 2, y: rect.top })
  }

  // A role, company, application, person or earlier chat has a page, so Open goes there; a made thing opens in the panel.
  const openThing = (kind: AttachKind, ref: string) => {
    const href = chatHref(kind, ref)
    if (href) router.push(href)
    else if (kind === 'made') setPanel(ref)
  }

  // [Add] attaches at once; "@" and a new chat hold a chip until the first turn is sent.
  const chipThing = (found: Found) => setChips((have) => (have.some((c) => c.kind === found.kind && c.ref === found.id) ? have : [...have, { kind: found.kind, ref: found.id, name: found.name }]))

  async function addThing(found: Found) {
    setAdding(false)
    setAddWords('')
    if (!chatId) return chipThing(found)
    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}/attachments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: found.kind, ref: refOf(found.kind, found.id) }) })
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; fix?: string } | null
      setNote(body?.ok ? null : [body?.error ?? 'Cello could not add that.', body?.fix].filter(Boolean).join(' '))
    } catch {
      setNote('Cello could not add that.')
    }
    await loadPage()
  }

  const at = AT_WORD.exec(draft)

  async function signOut() {
    await createClient().auth.signOut()
    router.push('/login')
  }

  async function railAction(action: Promise<boolean>, leave = false) {
    await action
    await loadChats()
    if (leave) router.replace('/chat')
  }

  if (missing) {
    return <p className="p-6 text-muted-foreground">That chat was not found. Open one from your chats.</p>
  }

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-[24rem] overflow-hidden rounded-card border border-border bg-background md:h-[calc(100dvh-5rem)]">
      <div className={`${railOpen ? 'fixed inset-y-0 left-0 z-40 w-72 bg-background shadow-pop' : 'hidden'} md:static md:block md:w-64 md:shrink-0 md:border-r md:border-border md:shadow-none`}>
        <Rail
          chats={rows.map((c): RailChat => ({ id: c.id, title: c.title, pinned: Boolean(c.pinned_at) }))}
          hasMore={more}
          onLoadMore={() => void loadMore()}
          earlier={earlier}
          scheduled={scheduled}
          onRunNow={(id) =>
            void send(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, 'POST').then((ok) => {
              setNote(ok ? 'Started. Its result shows in Needs you when it is done.' : 'Cello could not start that. Try again.')
              void loadScheduled()
            })
          }
          onSignOut={() => void signOut()}
          activeId={chatId}
          person={person}
          onNew={() => {
            setRailOpen(false)
            router.push('/chat')
          }}
          onRename={(id, title) => void railAction(send(`/api/chat/${id}`, 'PATCH', { title }))}
          onPin={(id, pinned) => void railAction(send(`/api/chat/${id}`, 'PATCH', { pinned }))}
          onArchive={(id) => void railAction(send(`/api/chat/${id}`, 'PATCH', { archived: true }), id === chatId)}
          onDelete={(id) => void railAction(send(`/api/chat/${id}`, 'DELETE'), id === chatId)}
        />
      </div>
      {railOpen && <button type="button" aria-label="Close the list of chats" className="fixed inset-0 z-30 bg-foreground/30 md:hidden" onClick={() => setRailOpen(false)} />}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <button type="button" aria-label="Open the list of chats" className="inline-flex h-8 w-8 items-center justify-center rounded-control hover:bg-muted" onClick={() => setRailOpen(true)}>
            <Menu className="h-4 w-4" aria-hidden />
          </button>
          <span className="truncate text-body font-medium text-foreground">{page?.chat.title || 'New chat'}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" onMouseUp={onSelect} onScroll={() => setSelection(null)}>
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
            <Tiles tiles={tiles} onAdd={() => setAdding((v) => !v)} onOpen={(t) => openThing(t.kind, t.ref)} onRemove={(t) => void send(`/api/chat/${chatId}/attachments?tile=${encodeURIComponent(t.id)}`, 'DELETE').then(loadPage)} />
            {adding && (
              <div className="rounded-card border border-border bg-card p-2">
                <input autoFocus aria-label="Find something to add" value={addWords} onChange={(e) => setAddWords(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} placeholder="Search your roles, companies, applications, people, chats and things Cello made" className="mb-1 h-8 w-full rounded-control border border-input bg-background px-2 text-body" />
                <Finder query={addWords} onPick={(f) => void addThing(f)} />
              </div>
            )}
            {note && (
              <p role="status" className="text-caption text-muted-foreground">
                {note}
              </p>
            )}

            {empty ? (
              <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
                <h1 className="font-display text-title text-foreground">{suggested?.greeting ?? 'What are we working on?'}</h1>
                <ul className="flex flex-wrap justify-center gap-2">
                  {(suggested?.suggestions ?? []).map((s) => (
                    // A tap puts the words in the compose box. Nothing is sent until Send.
                    <li key={s.text}>
                      <button type="button" className="rounded-full border border-border bg-card px-3 py-1.5 text-caption text-foreground hover:bg-muted" onClick={() => setDraft(s.text)}>
                        {s.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              seen.turns.map((t) =>
                t.kind === 'person' ? (
                  <div key={t.id} className="group ml-auto max-w-[85%]">
                    {editing?.id === t.id ? (
                      <div className="space-y-1">
                        <textarea aria-label="Edit your message" value={editing.text} rows={3} onChange={(e) => setEditing({ id: t.id, text: e.target.value })} className="w-full rounded-control border border-input bg-card p-2 text-body" />
                        <div className="flex justify-end gap-2 text-caption">
                          <button type="button" className="rounded-control px-2 py-1 text-muted-foreground hover:bg-muted" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={!editing.text.trim()}
                            className="rounded-control border border-border bg-card px-2 py-1 text-foreground hover:bg-muted disabled:opacity-40"
                            onClick={() =>
                              // ponytail: this forks the chat and keeps the old version; the answer for the new one comes from the stream route.
                              void send(`/api/chat/${chatId}/edit`, 'POST', { turn_id: t.id, typed: editing.text }).then((ok) => {
                                if (!ok) setNote('Cello could not save that edit.')
                                setEditing(null)
                                return loadPage()
                              })
                            }
                          >
                            Save edit
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="rounded-card bg-muted px-3 py-2 text-body text-foreground">
                          {t.quoted && <p className="mb-1 border-l-2 border-border pl-2 text-caption text-muted-foreground">{t.quoted.text}</p>}
                          <p className="whitespace-pre-wrap break-words">{t.typed}</p>
                        </div>
                        <div className="mt-0.5 flex items-center justify-end gap-2 text-caption text-muted-foreground">
                          {seen.slots[t.id] && (
                            <span className="flex items-center gap-1">
                              <button type="button" aria-label="Previous version" disabled={seen.slots[t.id].index <= 1} className="px-1 hover:text-foreground disabled:opacity-40" onClick={() => setPicks({ ...picks, [seen.slots[t.id].root]: seen.slots[t.id].index - 2 })}>
                                {'\u2039'}
                              </button>
                              Version {seen.slots[t.id].index} of {seen.slots[t.id].count}
                              <button type="button" aria-label="Next version" disabled={seen.slots[t.id].index >= seen.slots[t.id].count} className="px-1 hover:text-foreground disabled:opacity-40" onClick={() => setPicks({ ...picks, [seen.slots[t.id].root]: seen.slots[t.id].index })}>
                                {'\u203a'}
                              </button>
                            </span>
                          )}
                          {chatId && !t.superseded_at && (
                            <button type="button" className="hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100" onClick={() => setEditing({ id: t.id, text: t.typed ?? '' })}>
                              Edit
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : t.kind === 'cello' ? (
                  <div key={t.id} className="space-y-1" data-answer-turn={t.id}>
                    {t.parts.length > 0 ? <AnswerParts parts={t.parts} names={names} tileCount={active.length} cards={page?.cards ?? []} onOpen={openThing} /> : t.answer ? <Markdown content={t.answer} /> : null}
                    {t.disclosure ? <p className="text-caption text-muted-foreground">{disclosureLine(t.disclosure as Disclosure)}</p> : null}
                  </div>
                ) : (
                  <StatusTurn key={t.id} line={t.event_id ? page?.statuses[t.event_id] : undefined} />
                )
              )
            )}

            {turnTasks.length > 0 && (
              <TasksLine
                tasks={turnTasks.map(toTaskRow)}
                running={running}
                seconds={seconds(turnTasks)}
                onStop={() => lastPersonTurn && void send(`/api/chat/${chatId}/stop`, 'POST', { turn_id: lastPersonTurn.id }).then(loadPage)}
                onStopTask={(id) => void send(`/api/chat/${chatId}/stop`, 'POST', { task_id: id }).then(loadPage)}
              />
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-3">
          <Composer value={draft} onChange={setDraft} onSend={() => undefined} onStop={() => undefined} running={false} notice={SEND_NOTICE} quoted={quoted}
            onRemoveQuote={() => setQuoted(null)}
            controls={settings ? <ModelPicker key={`${choice?.rung}:${choice?.model}:${choice?.effort}`} choice={choice} rungs={settings.rungs} estimate={estimate} onPick={(c, scope) => void pick(c, scope)} /> : null}
            above={
              <>
                {at && (
                  <div className="mb-2 rounded-control border border-border bg-background p-1">
                    <Finder
                      query={at[2]}
                      onPick={(f) => {
                        setDraft(draft.replace(AT_WORD, '$1'))
                        chipThing(f)
                      }}
                    />
                  </div>
                )}
                {chips.length > 0 ? (
                <ul className="mb-2 flex flex-wrap gap-2" aria-label="Will be attached when you send">
                  {chips.map((c) => (
                    <li key={`${c.kind}:${c.ref}`} className="flex items-center gap-1 rounded-control border border-border bg-muted py-0.5 pl-2 pr-1 text-caption text-foreground">
                      <span className="max-w-[14rem] truncate">{c.name}</span>
                      <button type="button" aria-label={`Remove ${c.name}`} className="inline-flex h-5 w-5 items-center justify-center rounded-control text-muted-foreground hover:bg-card hover:text-foreground" onClick={() => setChips(chips.filter((x) => x !== c))}>
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
                ) : null}
              </>
            }
          />
        </div>
      </main>

      {selection && (
        <button
          type="button"
          className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-control border border-border bg-card px-2 py-1 text-caption text-foreground shadow-pop hover:bg-muted"
          style={{ left: selection.x, top: Math.max(selection.y - 6, 8) }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuoted({ text: selection.text, turn_id: selection.turnId })
            setSelection(null)
            window.getSelection()?.removeAllRanges()
          }}
        >
          Ask Cello
        </button>
      )}

      {panel && (
        <div className="fixed inset-0 z-50 bg-background md:static md:z-auto md:w-[26rem] md:shrink-0">
          <SidePanel
            artifactId={panel}
            onClose={() => setPanel(null)}
            onAddToChat={chatId && !active.some((a) => a.kind === 'made' && refId('made', a.ref) === panel) ? () => void addThing({ kind: 'made', id: panel, name: '', detail: null }) : undefined}
            onUseInNewChat={() => router.push(`/chat?about=made:${encodeURIComponent(panel)}`)}
          />
        </div>
      )}
    </div>
  )
}
