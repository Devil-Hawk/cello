import http from 'node:http'
import { RELAY_TOKEN } from './fill-server.stub'
import { expect, localSet, serviceWorker, test, tick } from './harness'

// AG22's done line: with no Cello tab open, the alarm claims a model job, a model on
// this computer answers, and the result goes back. The "model" is a server on loopback
// that answers the way Ollama does.

const MODEL_PORT = 4598
const job = { job_id: 'job-1', claim_id: 'claim-1', request: { messages: [{ role: 'user', content: 'sort this mail' }] } }

async function fakeModel(): Promise<{ bodies: unknown[]; close: () => Promise<void> }> {
  const bodies: unknown[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'a reply from the fake model' } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(MODEL_PORT, '127.0.0.1', resolve))
  return { bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const relayOn = { relayToken: RELAY_TOKEN, relayLocal: { runtime: 'ollama', baseUrl: `http://127.0.0.1:${MODEL_PORT}`, model: 'fake' } }

test('with no Cello tab open, the alarm runs a model job on this computer and posts the answer', async ({ context, stub }) => {
  const model = await fakeModel()
  try {
    stub.cfg.relayJob = job
    await localSet(context, relayOn)
    await tick(context)
    await expect.poll(() => stub.calls('/api/model-jobs/result').length).toBe(1)

    expect(stub.calls('/api/model-jobs/claim')[0]!.headers.authorization).toBe(`Bearer ${RELAY_TOKEN}`)
    expect(stub.calls('/api/model-jobs/result')[0]!.body).toEqual({ job_id: 'job-1', claim_id: 'claim-1', text: 'a reply from the fake model' })
    expect(model.bodies).toHaveLength(1)
    // Nothing but model job routes was touched with the relay token, and the fill routes saw no relay token.
    expect(stub.requests.filter((r) => r.headers.authorization === `Bearer ${RELAY_TOKEN}`).every((r) => r.path.startsWith('/api/model-jobs/'))).toBe(true)
  } finally {
    await model.close()
  }
})

test('a failing local model is reported as a sentence, not a hang', async ({ context, stub }) => {
  // Nothing listens on the model port.
  stub.cfg.relayJob = job
  await localSet(context, relayOn)
  await tick(context)
  await expect.poll(() => stub.calls('/api/model-jobs/result').length).toBe(1)
  expect(String(stub.calls('/api/model-jobs/result')[0]!.body.error)).toContain('could not reach Ollama')
})

test('a job waits while a send holds the lock', async ({ context, stub }) => {
  const model = await fakeModel()
  try {
    const w = await serviceWorker(context)
    await w.evaluate(() => (globalThis as any).chrome.storage.session.set({ run_lock: { holder: 'send', at: Date.now() } }))
    stub.cfg.relayJob = job
    await localSet(context, relayOn)
    await tick(context)
    await new Promise((r) => setTimeout(r, 1500))
    expect(stub.calls('/api/model-jobs/claim')).toHaveLength(0)
    expect(model.bodies).toHaveLength(0)
  } finally {
    await model.close()
  }
})

test('no job is claimed without a relay token', async ({ context, stub }) => {
  stub.cfg.relayJob = job
  await localSet(context, { relayLocal: relayOn.relayLocal })
  await tick(context)
  await new Promise((r) => setTimeout(r, 1500))
  expect(stub.calls('/api/model-jobs/claim')).toHaveLength(0)
})
