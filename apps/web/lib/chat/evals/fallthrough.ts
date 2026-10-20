// Which typed asks fall through the code router to the model loop.
//
//   npx --no-install tsx lib/chat/evals/fallthrough.ts [--days 30]
//
// Reads the answers of the window whose stored route is "loop", finds the line the person typed for each, and
// prints the opening words that recur most. It writes nothing.

/** The first three words of a typed line, lowercased, without punctuation. */
export function phraseOf(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
}

/** Typed lines counted by their opening words, most first, ties in alphabetical order. */
export function groupFallthrough(lines: string[]): { phrase: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const phrase = phraseOf(line)
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
  }
  return [...counts].map(([phrase, count]) => ({ phrase, count })).sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
}

async function main() {
  const { createAdminClient } = await import('@/lib/harness/supabase-admin')
  const db = createAdminClient()
  const at = process.argv.indexOf('--days')
  const days = at > -1 && Number(process.argv[at + 1]) > 0 ? Number(process.argv[at + 1]) : 30
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const cello: { ran: { route?: string } | null; prov: { turn_id?: string } | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('chat_turns').select('ran, prov').eq('kind', 'cello').gte('created_at', since).order('created_at').range(from, from + 999)
    if (error) throw new Error(error.message)
    cello.push(...((data ?? []) as typeof cello))
    if ((data ?? []).length < 1000) break
  }
  const looped = cello.filter((t) => t.ran?.route === 'loop')
  const noRoute = cello.filter((t) => !t.ran?.route).length
  const ids = [...new Set(looped.flatMap((t) => (t.prov?.turn_id ? [t.prov.turn_id] : [])))]

  const lines: string[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('chat_turns').select('typed').eq('kind', 'person').in('id', ids.slice(i, i + 100))
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as { typed: string | null }[]) if (r.typed) lines.push(r.typed)
  }

  console.log(`Typed lines that went to the loop in the last ${days} days: ${lines.length}`)
  console.log(`Answers with no route recorded: ${noRoute}`)
  for (const g of groupFallthrough(lines).slice(0, 40)) console.log(`${g.count}  ${g.phrase}`)
}

if (process.argv[1]?.endsWith('evals/fallthrough.ts')) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
