// One JSON object per line, written as it happens: the framing of the streamed add and find answers.
//
// A route can hold the stream back until its first real network step (`streamFrom`). If the work ends before that, the
// answer is plain JSON (the last event) with the status `status` gives it, so a refusal that is known up front keeps its
// 400, 403 or 429. Once a line passes `streamFrom` the response is 200 NDJSON and the last line says how it ended.

export interface NdjsonOpts {
  /** The first event that starts the stream; without it the stream starts at once. */
  streamFrom?: (event: object) => boolean
  /** The status of a plain JSON answer, from its event. */
  status?: (event: object) => number
}

export async function ndjson(run: (emit: (event: object) => void) => Promise<void>, opts: NdjsonOpts = {}): Promise<Response> {
  const encoder = new TextEncoder()
  const line = (event: object) => encoder.encode(`${JSON.stringify(event)}\n`)
  const errorLine = { step: 'error', line: 'Cello could not finish that right now. Try again.' }
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
  const write = (event: object) => {
    try {
      controller.enqueue(line(event))
    } catch {
      /* the reader went away: nobody is waiting for the rest */
    }
  }

  const held: object[] = []
  let streaming = !opts.streamFrom
  let failed = false
  let begin!: () => void
  const began = new Promise<void>((resolve) => (begin = resolve))
  const emit = (event: object) => {
    if (streaming) return write(event)
    held.push(event)
    if (!opts.streamFrom?.(event)) return
    streaming = true
    held.splice(0).forEach(write)
    begin()
  }

  const finished = run(emit)
    .catch((error) => {
      // The class only: an address or a search is never logged.
      console.error('[companies] stream failed', error instanceof Error ? error.name : 'error')
      failed = true
    })
    .then(() => {
      if (!streaming) return
      if (failed) write(errorLine)
      controller.close()
    })
  await Promise.race([began, finished])

  if (streaming) return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  if (failed) return Response.json(errorLine, { status: 500, headers: { 'cache-control': 'no-store' } })
  const last = held[held.length - 1] ?? {}
  return Response.json(last, { status: opts.status?.(last) ?? 200, headers: { 'cache-control': 'no-store' } })
}
