'use client'

// The Chat page: the rail on the left, the conversation in the middle with its compose box fixed at the bottom, and
// the side panel on the right only while a made thing is open. Everything it shows is read from rows through
// /api/chat: tiles with names, answers as the parts code passed, cards from stored rows, the tasks line from agent_tasks.
// The page reads the chat through the stream while a turn is answered, and Realtime updates rows after the stream ends.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Menu, X, Check, Loader2 } from 'lucide-react'
import { Markdown } from '@/components/chat/markdown'
import { MadeBlock } from '@/components/chat/made-block'
import { SourcesAndTools } from '@/components/chat/sources-and-tools'
import { ModelPicker, steppedDownWords, type PickScope } from '@/components/chat/model-picker'
import { ModePicker } from '@/components/chat/mode-picker'
import { Composer } from '@/components/chat/composer'
import { AnswerParts, type Named } from '@/components/chat/parts'
import { Finder } from '@/components/chat/finder'
import { Rail, type EarlierChat, type RailChat, type ScheduledRow } from '@/components/chat/rail'
import { SidePanel } from '@/components/chat/side-panel'
import { StatusTurn } from '@/components/chat/status-turn'
import { TasksLine, type TaskRow, type TaskStatus } from '@/components/chat/tasks-line'
import { Tiles, type TileData } from '@/components/chat/tiles'
import type { Disclosure } from '@/lib/chat/disclosure'
import type { Found } from '@/lib/chat/find'
import { chatHref } from '@/lib/chat/links'
import type { ChatPageData } from '@/lib/chat/page-data'
import type { SettingsView } from '@/lib/chat/settings'
import { resolveMode, type Mode } from '@/lib/chat/mode'
import type { Suggestions } from '@/lib/chat/suggest'
import { refId, type AttachKind } from '@/lib/chat/types'
import { visibleTurns } from '@/lib/chat/versions'
import type { ModelChoice } from '@/lib/models/choice'
import { createClient } from '@/lib/supabase/client'
import { FetchStreamTransport, useStream } from '@langchain/langgraph-sdk/react'
import { agentFetch, errorMessage, unsentMessage } from '@/lib/agents/client'

export interface ChatViewProps {
  /** The chat to open; null for a new one. */
  chatId: string | null
  person: { name: string }
  /** A question carried in by /ask?ask= or a quick chat: put in the compose box, never sent for the person. */
  initialAsk?: string
  /** A thing the person was looking at: a chip in the compose box that attaches when the first turn is sent. */
  initialAbout?: { kind: string; ref: string }
}

const PAGE = 50
// The stream route refuses anything longer; checking here keeps a chat from being made for a send that cannot go.
const MAX_SEND = 20_000
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
  return (await sendJson(url, method, body)).ok
}

async function sendJson<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<{ ok: boolean; body: (T & { message?: string; fix?: string }) | null }> {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { ok: res.ok, body: (await res.json().catch(() => null)) as (T & { message?: string; fix?: string }) | null }
  } catch {
    return { ok: false, body: null }
  }
}

const toTaskRow = (t: ChatPageData['tasks'][number]): TaskRow => ({ id: t.id, title: t.title, status: t.status as TaskStatus, command: t.command, reads: t.reads?.length ?? 0 })
const alive = (t: TaskRow) => t.status === 'queued' || t.status === 'working'
const seconds = (rows: ChatPageData['tasks']) => {
  const starts = rows.map((r) => Date.parse(r.started_at ?? r.created_at)).filter((n) => !Number.isNaN(n))
  const ends = rows.map((r) => (r.finished_at ? Date.parse(r.finished_at) : Date.now()))
  return starts.length ? Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000)) : 0
}

export function ChatView({ chatId: routeId, person, initialAsk, initialAbout }: ChatViewProps) {
  const router = useRouter()
  // The chat shown. A first send keeps this view mounted and moves the address with pushState, so the sent line, the rail and
  // the picker stay on screen; the address is the source of truth after that (Back, New chat and the rail's links change it).
  const pathId = usePathname()?.match(/^\/chat\/([^/]+)/)?.[1] ?? null
  const [chatId, setChatId] = useState(routeId)
  useEffect(() => setChatId(pathId ? decodeURIComponent(pathId) : null), [pathId])
  // Null until the first list has been read: the rail says nothing rather than "Your chats stay here" while it loads.
  const [rows, setRows] = useState<ListRow[] | null>(null)
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
  // "Just this message": used by the next send only.
  const [once, setOnce] = useState<ModelChoice | null>(null)
  // A mode picked before the chat exists: stored on the chat when the first turn creates it. Undefined means no pick.
  const [pendingMode, setPendingMode] = useState<Mode | null | undefined>(undefined)
  const [sending, setSending] = useState(false)
  // What was just sent, shown as the person's turn until the chat's rows hold it: the line never vanishes after Enter.
  const [justSent, setJustSent] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // True while the person is at the newest content: a new turn or row keeps them there, and never pulls them back from older turns.
  const stuck = useRef(true)
  const [live, setLive] = useState<{ words: string; tools: { label: string; phase: 'start' | 'end' }[] } | null>(null)
  const streamChatId = useRef(routeId)
  streamChatId.current = chatId
  // The turn the open stream is answering, from its first event: Stop posts exactly this id, never a row from an earlier read.
  const streamTurnId = useRef<string | null>(null)
  // Stop pressed before the stream has named its turn: sent the moment it does.
  const stopWanted = useRef(false)
  // Puts a send that never reached the server back as it was (text, chips, picks), and says why. Null once the stream has named its turn.
  const unsent = useRef<((why: string) => void) | null>(null)
  const answered = useRef<Set<string> | null>(null)
  const [estimate, setEstimate] = useState<string | null>(null)

  const loadChats = useCallback(async () => {
    const body = await getJson<{ chats: ListRow[] }>(`/api/chat?limit=${PAGE}`)
    if (!body) return
    setRows(body.chats)
    setMore(body.chats.filter((c) => !c.pinned_at).length >= PAGE)
  }, [])

  // The next page of Recents, from the last chat listed. ponytail: pages by last_turn_at, so two chats with the very same instant could straddle a page.
  const loadMore = useCallback(async () => {
    const last = [...(rows ?? [])].reverse().find((c) => !c.pinned_at)
    if (paging.current || !last) return
    paging.current = true
    const body = await getJson<{ chats: ListRow[] }>(`/api/chat?limit=${PAGE}&before=${encodeURIComponent(last.last_turn_at)}`)
    paging.current = false
    if (!body) return setMore(false)
    setRows((have) => [...(have ?? []), ...body.chats.filter((c) => !have?.some((h) => h.id === c.id))])
    setMore(body.chats.length >= PAGE)
  }, [rows])

  const loadScheduled = useCallback(async () => {
    // While scheduled tasks are closed the route answers an empty list, which is truly "nothing scheduled".
    const res = await fetch('/api/scheduled-tasks', { cache: 'no-store' }).catch(() => null)
    const body = res?.ok ? ((await res.json().catch(() => null)) as { tasks: { id: string; name: string; card: { schedule: string; last: string | null; next: string | null } }[] } | null) : null
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
    answered.current = null
    stuck.current = true
    void loadPage()
  }, [loadPage])

  const streamTransport = useMemo(
    () =>
      new FetchStreamTransport({
        apiUrl: '/api/chat/__chat__/stream',
        fetch: (input: RequestInfo | URL, init?: RequestInit) => agentFetch(typeof input === 'string' ? input.replace('__chat__', encodeURIComponent(streamChatId.current ?? '')) : input, init),
      }),
    [],
  )
  const onCustomEvent = useCallback(
    (data: unknown) => {
      if (!data || typeof data !== 'object') return
      const event = data as { type?: string; text?: unknown; label?: unknown; phase?: unknown }
      if (event.type === 'words' && typeof event.text === 'string') return setLive((current) => ({ words: event.text as string, tools: current?.tools ?? [] }))
      if (event.type === 'tool' && typeof event.label === 'string' && (event.phase === 'start' || event.phase === 'end')) {
        return setLive((current) => {
          const tools = [...(current?.tools ?? [])]
          const index = tools.findIndex((tool) => tool.label === event.label)
          if (index < 0) tools.push({ label: event.label as string, phase: event.phase as 'start' | 'end' })
          else tools[index] = { label: event.label as string, phase: event.phase as 'start' | 'end' }
          return { words: current?.words ?? '', tools }
        })
      }
      if (event.type === 'answer') {
        setLive(null)
        streamTurnId.current = null
        void loadPage()
      }
    },
    [loadPage],
  )
  const stream = useStream({
    transport: streamTransport,
    // The stream names the turn it answers first of all: Stop targets this turn from the first moment, before any row is read.
    onMetadataEvent: (data) => {
      const turnId = (data as unknown as { turn_id?: unknown }).turn_id
      if (typeof turnId !== 'string') return
      streamTurnId.current = turnId
      unsent.current = null
      if (stopWanted.current) {
        stopWanted.current = false
        void send(`/api/chat/${encodeURIComponent(streamChatId.current ?? '')}/stop`, 'POST', { turn_id: turnId }).then(() => loadPage())
      }
    },
    onCustomEvent,
    onError: (error) => {
      setLive(null)
      if (unsent.current) unsent.current(unsentMessage(error))
      else {
        setNote(errorMessage(error))
        void loadPage()
      }
    },
    onFinish: () => {
      streamTurnId.current = null
      void loadPage()
    },
  })

  useEffect(() => {
    if (!chatId) return
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void loadPage(), 300)
    }
    const channel = supabase
      .channel(`chat-${chatId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_turns', filter: `chat_id=eq.${chatId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_tasks', filter: `chat_id=eq.${chatId}` }, refresh)
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [chatId, loadPage])

  const loadSettings = useCallback(async () => {
    setSettings(await getJson<SettingsView>(`/api/chat/settings${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`))
  }, [chatId])
  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const choice: ModelChoice | null = once ?? pending ?? (settings?.ran ? { rung: settings.ran.rung, model: settings.ran.model, effort: settings.ran.effort } : null)
  useEffect(() => {
    if (!choice) return setEstimate(null)
    void getJson<{ text: string }>(`/api/chat/estimate?rung=${choice.rung}&model=${encodeURIComponent(choice.model)}&effort=${choice.effort}`).then((e) => setEstimate(e?.text ?? null))
  }, [choice?.rung, choice?.model, choice?.effort]) // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(next: ModelChoice, scope: PickScope) {
    // One message, or this chat before it exists: held until the first turn is sent. A default needs no chat.
    if (scope === 'once') return setOnce(next)
    if (!chatId && scope === 'chat') return setPending(next)
    const ok = await send('/api/chat/settings', 'POST', { ...(chatId ? { chat: chatId } : {}), choice: next, as_default: scope === 'default' })
    if (ok) setPending(null)
    else setNote('Cello could not save that choice. It is above what you allow, or the save failed.')
    await loadSettings()
  }

  async function pickMode(next: Mode | null) {
    if (!chatId) return setPendingMode(next)
    const ok = await send('/api/chat/settings', 'POST', { chat: chatId, mode: next })
    if (!ok) setNote('Cello could not save that mode. Try again.')
    await loadSettings()
  }
  // The mode control's view: the server's, or with the pick held for a chat that does not exist yet.
  const modeView = useMemo(() => {
    if (!settings) return null
    if (pendingMode === undefined || chatId) return settings.mode
    return { ...settings.mode, chat: pendingMode, resolved: resolveMode({ chat: pendingMode, settings: settings.mode.settings, ...settings.mode.facts }) }
  }, [settings, pendingMode, chatId])

  const tasks = useMemo(() => (page?.tasks ?? []).map(toTaskRow), [page])
  // A turn is being answered while the last thing in the chat is the person's own message.
  const lastTurn = page?.turns.filter((t) => !t.superseded_at && t.kind !== 'status').at(-1)
  // What the newest answer ran on, from its disclosure (the ledger's model, disclosure.ts), for the picker's step-down line.
  const lastRan = (page?.turns.filter((t) => !t.superseded_at && t.kind === 'cello').at(-1)?.disclosure as Disclosure | null | undefined)?.ran ?? null
  const awaiting = lastTurn?.kind === 'person' && Date.now() - Date.parse(lastTurn.created_at) < 6 * 60_000
  // The sent line stands in for the person's turn until the rows hold it.
  const pendingLine = justSent !== null && !page?.turns.some((t) => t.kind === 'person' && t.typed === justSent) ? justSent : null
  useEffect(() => {
    if (justSent !== null && pendingLine === null) setJustSent(null)
  }, [justSent, pendingLine])
  const running = tasks.some(alive) || awaiting || sending || pendingLine !== null || stream.isLoading

  // A comparison that arrives while the person is here opens beside the chat; one already there does not.
  useEffect(() => {
    if (!page) return
    const cello = page.turns.filter((t) => t.kind === 'cello')
    if (answered.current === null) {
      answered.current = new Set(cello.map((t) => t.id))
      return
    }
    for (const t of cello) {
      if (answered.current.has(t.id)) continue
      answered.current.add(t.id)
      const made = (t.links ?? []).map((l) => (l.kind === 'made' && l.role !== 'recalled' ? page.made[l.id] : undefined)).find((m) => m?.type === 'comparison')
      if (made) setPanel(made.id)
    }
  }, [page])

  // A chip is read under the person's rights before it is shown; one that is not theirs never appears.
  useEffect(() => {
    if (!initialAbout) return
    void getJson<{ kind: string; ref: string; name: string }>(`/api/chat/object?kind=${encodeURIComponent(initialAbout.kind)}&ref=${encodeURIComponent(initialAbout.ref)}`).then((o) => o && setChips([o]))
  }, [initialAbout])

  const empty = (!chatId || (page !== null && page.turns.length === 0)) && pendingLine === null
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
  // The turn's own row (chat.turn) is the loop, not work: it is listed nowhere, so the counts here and in Sources and tools agree.
  // While a new line is pending the rows are the earlier turn's, so none are shown.
  const work = pendingLine === null ? turnTasks.filter((t) => t.command !== 'chat.turn') : []

  // A chat opens at its newest turn, and a new turn, row, word or tool line keeps the person there unless they have scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [chatId, page?.turns.length, tasks.length, pendingLine, live])

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
  const chipThing = (found: Found) => setChips((have) => (have.some((c) => c.kind === found.kind && c.ref === found.id) ? have : [...have, { kind: found.kind, ref: found.id, name: (found.kind === 'role' || found.kind === 'application') && found.detail ? `${found.name} at ${found.detail}` : found.name }]))

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

  // Send: a new chat is made first (holding the chips), then the words go to it and the page follows the answer.
  async function sendMessage() {
    const typed = draft.trim()
    if (!typed || sending) return
    if (typed.length > MAX_SEND) return setNote('Type something to send, up to 20,000 characters.')
    setSending(true)
    stopWanted.current = false
    streamTurnId.current = null
    // The line moves from the compose box to the conversation at once; it comes back to the box if the send fails.
    setJustSent(typed)
    setDraft('')
    stuck.current = true
    setNote(null)
    const failed = (note: string) => {
      setSending(false)
      setJustSent(null)
      setDraft(typed)
      setNote(note)
    }
    const before = { chips, quoted, once, pending, pendingMode }
    let id = chatId
    if (!id) {
      const made = await sendJson<{ id: string }>('/api/chat', 'POST', { chips: chips.map((c) => ({ kind: c.kind, id: c.ref })), ...(pending ? { choice: pending } : {}), ...(pendingMode !== undefined ? { mode: pendingMode } : {}) })
      if (!made.ok || !made.body?.id) return failed('Cello could not start the chat. Try again.')
      id = made.body.id
    } else {
      for (const c of chips) await send(`/api/chat/${encodeURIComponent(id)}/attachments`, 'POST', { kind: c.kind, ref: refOf(c.kind, c.ref) })
    }
    const choiceOnce = once
    setChips([])
    setQuoted(null)
    setOnce(null)
    setPending(null)
    setPendingMode(undefined)
    streamChatId.current = id
    if (id !== chatId) {
      // Keep the page mounted so the stream can append below the person's line.
      window.history.replaceState(null, '', `/chat/${encodeURIComponent(id)}`)
      setChatId(id)
    }
    // A refused or dropped send leaves nothing stored: the text, chips and picks come back, and a chat made for it goes.
    let refused = false
    unsent.current = (why) => {
      unsent.current = null
      refused = true
      stopWanted.current = false
      setLive(null)
      failed(why)
      setQuoted(before.quoted)
      setOnce(before.once)
      if (id === chatId) return
      setChips(before.chips)
      setPending(before.pending)
      setPendingMode(before.pendingMode)
      streamChatId.current = null
      window.history.replaceState(null, '', '/chat')
      setChatId(null)
      void send(`/api/chat/${encodeURIComponent(id as string)}`, 'DELETE').then(() => loadChats())
    }
    try {
      await stream.submit({ messages: [{ type: 'human', content: typed }] }, { context: { quoted, choice: choiceOnce } })
    } catch {
      unsent.current?.(unsentMessage(null))
    }
    // The stream ended without naming a turn and without an error: nothing was stored.
    unsent.current?.(unsentMessage(null))
    if (refused) return
    setSending(false)
    void loadPage()
    void loadChats()
  }

  // A suggestion puts its words in the compose box and its things beside them as chips; nothing is sent until Send.
  async function takeSuggestion(s: { text: string; objects: { kind: string; ref: string }[] }) {
    setDraft(s.text)
    const named = await Promise.all(s.objects.map((o) => getJson<{ kind: string; ref: string; name: string }>(`/api/chat/object?kind=${encodeURIComponent(o.kind)}&ref=${encodeURIComponent(o.ref)}`)))
    setChips(named.filter((o): o is { kind: string; ref: string; name: string } => o !== null))
  }

  // Stop marks the turn's rows on the server (the work itself lives there, not in the stream); the stream's own turn id wins
  // over the newest row, which can still be the earlier turn right after Send.
  const stopTurn = useCallback(() => {
    // While a send is in flight the stream has not named its turn yet: hold the Stop for the metadata event.
    if (sending && !streamTurnId.current) {
      stopWanted.current = true
      return
    }
    const turnId = streamTurnId.current ?? lastPersonTurn?.id
    const id = streamChatId.current ?? chatId
    if (id && turnId) void send(`/api/chat/${encodeURIComponent(id)}/stop`, 'POST', { turn_id: turnId }).then(() => loadPage())
  }, [chatId, lastPersonTurn?.id, loadPage, sending])

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
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-[24rem] overflow-hidden rounded-card border border-border bg-background md:h-[calc(100dvh-9.25rem)]">
      <div className={`${railOpen ? 'fixed inset-y-0 left-0 z-40 w-72 bg-background shadow-pop' : 'hidden'} md:static md:block md:w-64 md:shrink-0 md:border-r md:border-border md:shadow-none`}>
        <Rail
          chats={rows?.map((c): RailChat => ({ id: c.id, title: c.title, pinned: Boolean(c.pinned_at) })) ?? null}
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
          <button type="button" aria-label="Open the list of chats" className="-my-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control hover:bg-muted" onClick={() => setRailOpen(true)}>
            <Menu className="h-4 w-4" aria-hidden />
          </button>
          <span className="truncate text-body font-medium text-foreground">{page?.chat.title || 'New chat'}</span>
        </div>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onMouseUp={onSelect}
          onScroll={(e) => {
            const el = e.currentTarget
            stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            setSelection(null)
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
            <Tiles tiles={tiles} onAdd={() => setAdding((v) => !v)} onOpen={(t) => openThing(t.kind, t.ref)} onRemove={(t) => void send(`/api/chat/${chatId}/attachments?tile=${encodeURIComponent(t.id)}`, 'DELETE').then(loadPage)} />
            {adding && (
              <div className="rounded-card border border-border bg-card p-2">
                <input autoFocus aria-label="Find something to add" value={addWords} onChange={(e) => setAddWords(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} placeholder="Search your roles, companies, applications, people, chats and things Cello made" className="mb-1 h-11 w-full rounded-control border border-input bg-background px-2 text-body" />
                <Finder query={addWords} onPick={(f) => void addThing(f)} />
              </div>
            )}
            {note && (
              <p role="status" className="text-caption text-muted-foreground">
                {note}
              </p>
            )}

            {chatId && !page && pendingLine === null ? (
              <p role="status" className="text-caption text-muted-foreground">
                Opening the chat
              </p>
            ) : empty ? (
              <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
                <h1 className="font-display text-title text-foreground">{suggested?.greeting ?? 'What are we working on?'}</h1>
                <ul className="flex flex-wrap justify-center gap-2">
                  {(suggested?.suggestions ?? []).map((s) => (
                    // A tap puts the words in the compose box. Nothing is sent until Send.
                    <li key={s.text}>
                      <button type="button" className="min-h-11 rounded-full border border-border bg-card px-3 py-1.5 text-caption text-foreground hover:bg-muted" onClick={() => void takeSuggestion(s)}>
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
                          <button type="button" className="min-h-11 rounded-control px-2 py-1 text-muted-foreground hover:bg-muted" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={!editing.text.trim()}
                            className="min-h-11 rounded-control border border-border bg-card px-2 py-1 text-foreground hover:bg-muted disabled:opacity-40"
                            onClick={() =>
                              // This forks the chat and keeps the old version; the page then follows the new answer.
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
                              <button type="button" aria-label="Previous version" disabled={seen.slots[t.id].index <= 1} className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 hover:text-foreground disabled:opacity-40" onClick={() => setPicks({ ...picks, [seen.slots[t.id].root]: seen.slots[t.id].index - 2 })}>
                                {'\u2039'}
                              </button>
                              Version {seen.slots[t.id].index} of {seen.slots[t.id].count}
                              <button type="button" aria-label="Next version" disabled={seen.slots[t.id].index >= seen.slots[t.id].count} className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 hover:text-foreground disabled:opacity-40" onClick={() => setPicks({ ...picks, [seen.slots[t.id].root]: seen.slots[t.id].index })}>
                                {'\u203a'}
                              </button>
                            </span>
                          )}
                          {chatId && !t.superseded_at && (
                            <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100" onClick={() => setEditing({ id: t.id, text: t.typed ?? '' })}>
                              Edit
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : t.kind === 'cello' ? (
                  <div key={t.id} className="space-y-1" data-answer-turn={t.id}>
                    {t.parts.length > 0 ? <AnswerParts parts={t.parts} names={names} tileCount={active.length} cards={page?.cards ?? []} onOpen={openThing} recalled={page?.recalled} onAddChat={(id) => void addThing({ kind: 'chat', id, name: '', detail: null })} /> : t.answer ? <Markdown content={t.answer} /> : null}
                    {(t.links ?? []).flatMap((l) => (l.kind === 'made' && l.role !== 'recalled' && page?.made[l.id] ? [page.made[l.id]] : [])).map((m) => (
                      <MadeBlock key={m.id} made={m} onOpen={setPanel} />
                    ))}
                    {t.disclosure ? <SourcesAndTools d={t.disclosure as Disclosure} /> : null}
                  </div>
                ) : (
                  <StatusTurn
                    key={t.id}
                    line={t.event_id ? page?.statuses[t.event_id] : undefined}
                    onReview={setPanel}
                    onApproved={() => {
                      void loadPage()
                    }}
                  />
                )
              )
            )}

            {pendingLine !== null && (
              <div className="ml-auto max-w-[85%]">
                <div className="rounded-card bg-muted px-3 py-2 text-body text-foreground">
                  <p className="whitespace-pre-wrap break-words">{pendingLine}</p>
                </div>
              </div>
            )}

            {live && (live.words || live.tools.length > 0) && (
              <div className="space-y-2 text-caption text-muted-foreground" aria-live="polite">
                {live.tools.length > 0 && (
                  <ul className="space-y-1" aria-label="What Cello is doing">
                    {live.tools.map((tool) => (
                      <li key={tool.label} className="flex items-center gap-2">
                        {tool.phase === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
                        <span>{tool.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {live.words && (
                  <div className="rounded-control border border-border bg-muted/50 px-3 py-2">
                    <p className="mb-1 text-label uppercase tracking-wide">Writing</p>
                    <p className="whitespace-pre-wrap break-words text-foreground">{live.words}</p>
                  </div>
                )}
              </div>
            )}


            {(work.length > 0 || running) && (
              <TasksLine
                tasks={work.map(toTaskRow)}
                running={running}
                defaultOpen
                seconds={seconds(turnTasks)}
                onStop={stopTurn}
                onStopTask={(id) => void send(`/api/chat/${chatId}/stop`, 'POST', { task_id: id }).then(loadPage)}
              />
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-3">
          <Composer value={draft} onChange={setDraft} onSend={() => void sendMessage()} onStop={stopTurn} running={running} quoted={quoted}
            onRemoveQuote={() => setQuoted(null)}
            controls={
              settings ? (
                <>
                  <ModelPicker key={`${choice?.rung}:${choice?.model}:${choice?.effort}`} choice={choice} rungs={settings.rungs} estimate={estimate} onPick={(c, scope) => void pick(c, scope)} />
                  {modeView && <ModePicker chat={modeView.chat} settings={modeView.settings} resolved={modeView.resolved} facts={modeView.facts} onPick={(m) => void pickMode(m)} />}
                </>
              ) : null
            }
            status={settings ? steppedDownWords(lastRan, choice, settings.rungs) || null : null}
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
                    <li key={`${c.kind}:${c.ref}`} className="flex min-h-11 items-center gap-1 rounded-control border border-border bg-muted py-0.5 pl-2 pr-1 text-caption text-foreground">
                      <span className="max-w-[14rem] truncate" title={c.name}>{c.name}</span>
                      <button type="button" aria-label={`Remove ${c.name}`} className="inline-flex h-11 w-11 items-center justify-center rounded-control text-muted-foreground hover:bg-card hover:text-foreground" onClick={() => setChips(chips.filter((x) => x !== c))}>
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
          className="fixed z-50 min-h-11 -translate-x-1/2 -translate-y-full rounded-control border border-border bg-card px-2 py-1 text-caption text-foreground shadow-pop hover:bg-muted"
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
