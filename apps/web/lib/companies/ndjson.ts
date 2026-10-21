// One JSON object per line, written as it happens: the framing of the streamed add and find answers.

export function ndjson(run: (emit: (event: object) => void) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: object) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          /* the reader went away: nobody is waiting for the rest */
        }
      }
      try {
        await run(emit)
      } catch (error) {
        // The class only: an address or a search is never logged.
        console.error('[companies] stream failed', error instanceof Error ? error.name : 'error')
        emit({ step: 'error', line: 'Cello could not finish that right now. Try again.' })
      }
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
}
