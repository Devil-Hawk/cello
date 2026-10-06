'use client'

// The Chat page: the rail on the left, the conversation in the middle with its compose box fixed at the bottom, and
// the side panel on the right only while a made thing is open. Everything it shows is read from rows through
// /api/chat: tiles with names, answers as the parts code passed, cards from stored rows, the tasks line from agent_tasks.
// ponytail: tasks are polled every 2 s while one is working; Realtime replaces the poll when the stream route lands.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { Markdown } from '@/components/chat/markdown'
import { Composer } from '@/components/chat/composer'
import { AnswerParts, type Named } from '@/components/chat/parts'
import { Rail, type RailChat } from '@/components/chat/rail'
import { SidePanel } from '@/components/chat/side-panel'
import { TasksLine, type TaskRow, type TaskStatus } from '@/components/chat/tasks-line'
import { Tiles, type TileData } from '@/components/chat/tiles'
import { disclosureLine, type Disclosure } from '@/lib/chat/disclosure'
import type { ChatPageData } from '@/lib/chat/page-data'
import type { Suggestions } from '@/lib/chat/suggest'
import { refId, type AttachKind } from '@/lib/chat/types'

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
  const [chats, setChats] = useState<RailChat[]>([])
  const [page, setPage] = useState<ChatPageData | null>(null)
  const [missing, setMissing] = useState(false)
  const [suggested, setSuggested] = useState<Suggestions | null>(null)
  const [draft, setDraft] = useState(initialAsk ?? '')
  const [panel, setPanel] = useState<string | null>(null)
  const [railOpen, setRailOpen] = useState(false)
  const [quoted, setQuoted] = useState<{ text: string; turn_id: string } | null>(null)
  const [chips, setChips] = useState<{ kind: string; ref: string; name: string }[]>([])
  const [selection, setSelection] = useState<{ text: string; turnId: string; x: number; y: number } | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadChats = useCallback(async () => {
    const body = await getJson<{ chats: { id: string; title: string; pinned_at: string | null }[] }>('/api/chat')
    if (body) setChats(body.chats.map((c) => ({ id: c.id, title: c.title, pinned: Boolean(c.pinned_at) })))
  }, [])

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
  const lastPersonTurn = [...(page?.turns ?? [])].reverse().find((t) => t.kind === 'person')
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

  const openThing = (kind: AttachKind, ref: string) => {
    if (kind === 'made') setPanel(ref)
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
          chats={chats}
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
            {tiles.length > 0 && <Tiles tiles={tiles} onOpen={(t) => openThing(t.kind, t.ref)} onRemove={(t) => void send(`/api/chat/${chatId}/attachments?tile=${encodeURIComponent(t.id)}`, 'DELETE').then(loadPage)} />}

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
              (page?.turns ?? [])
                .filter((t) => !t.superseded_at)
                .map((t) =>
                  t.kind === 'person' ? (
                    <div key={t.id} className="ml-auto max-w-[85%] rounded-card bg-muted px-3 py-2 text-body text-foreground">
                      {t.quoted && <p className="mb-1 border-l-2 border-border pl-2 text-caption text-muted-foreground">{t.quoted.text}</p>}
                      <p className="whitespace-pre-wrap break-words">{t.typed}</p>
                    </div>
                  ) : t.kind === 'cello' ? (
                    <div key={t.id} className="space-y-1" data-answer-turn={t.id}>
                      {t.parts.length > 0 ? <AnswerParts parts={t.parts} names={names} tileCount={active.length} cards={page?.cards ?? []} onOpen={openThing} /> : t.answer ? <Markdown content={t.answer} /> : null}
                      {t.disclosure ? <p className="text-caption text-muted-foreground">{disclosureLine(t.disclosure as Disclosure)}</p> : null}
                    </div>
                  ) : (
                    <p key={t.id} className="text-caption text-muted-foreground">
                      {t.answer}
                    </p>
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
            above={
              chips.length > 0 ? (
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
              ) : null
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
          <SidePanel artifactId={panel} onClose={() => setPanel(null)} />
        </div>
      )}
    </div>
  )
}
