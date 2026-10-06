// runApifyActor over a mocked apify-client: the HTTP belongs to the library, so
// these cover what this module adds: the wait budget, the terminal statuses and
// the plain-language errors.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const start = vi.fn()
const waitForFinish = vi.fn()
const listItems = vi.fn()
const constructed: unknown[] = []

vi.mock('apify-client', () => {
  class ApifyApiError extends Error {
    statusCode: number
    type?: string
    constructor(message: string, statusCode: number, type?: string) {
      super(message)
      this.statusCode = statusCode
      this.type = type
    }
  }
  class ApifyClient {
    constructor(options: unknown) {
      constructed.push(options)
    }
    actor() {
      return { start }
    }
    run() {
      return { waitForFinish }
    }
    dataset() {
      return { listItems }
    }
  }
  return { ApifyClient, ApifyApiError }
})

import * as apifyClient from 'apify-client'
import { runApifyActor } from './client'
import { ApifyError } from './types'

beforeEach(() => {
  vi.clearAllMocks()
  constructed.length = 0
})

// The mock above stands in for the real class, whose constructor takes an HTTP response.
const ApifyApiError = (apifyClient as unknown as { ApifyApiError: new (message: string, statusCode: number, type?: string) => Error }).ApifyApiError

const base = { actorId: 'user/actor', token: 'secret-token' }

describe('runApifyActor', () => {
  it('starts the run, waits for it and returns the dataset items', async () => {
    start.mockResolvedValue({ id: 'run-1', status: 'READY', defaultDatasetId: 'ds-1' })
    waitForFinish.mockResolvedValue({ id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1', statusMessage: 'Done' })
    listItems.mockResolvedValue({ items: [{ a: 1 }, { a: 2 }] })

    const out = await runApifyActor({ ...base, input: { q: 'x' }, itemLimit: 50 })

    expect(start).toHaveBeenCalledWith({ q: 'x' })
    expect(listItems).toHaveBeenCalledWith({ clean: true, limit: 50 })
    expect(out).toMatchObject({ runId: 'run-1', actorId: 'user/actor', status: 'SUCCEEDED', defaultDatasetId: 'ds-1', itemCount: 2 })
    expect(constructed[0]).toMatchObject({ token: 'secret-token' })
  })

  it('names the run and its status when it ends FAILED', async () => {
    start.mockResolvedValue({ id: 'run-2', status: 'READY' })
    waitForFinish.mockResolvedValue({ id: 'run-2', status: 'FAILED', statusMessage: 'Actor crashed' })
    await expect(runApifyActor(base)).rejects.toThrow('Apify run run-2 ended with status FAILED: Actor crashed')
    expect(listItems).not.toHaveBeenCalled()
  })

  it('says the run may still finish when the wait budget runs out', async () => {
    start.mockResolvedValue({ id: 'run-3', status: 'READY' })
    waitForFinish.mockResolvedValue({ id: 'run-3', status: 'RUNNING' })
    const err = await runApifyActor({ ...base, maxWaitMs: 5_000 }).catch((e) => e)
    expect(err).toBeInstanceOf(ApifyError)
    expect(err.message).toMatch(/did not finish within 5s \(last status: RUNNING\)/)
    expect(err.runId).toBe('run-3')
  })

  it("turns Apify's own API error into an ApifyError with its status, and never leaks the token", async () => {
    start.mockRejectedValue(new ApifyApiError('User was not found or authentication token is not valid', 401, 'token-not-provided'))
    const err = await runApifyActor(base).catch((e) => e)
    expect(err).toBeInstanceOf(ApifyError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Apify API error: User was not found or authentication token is not valid')
    expect(err.message).not.toContain('secret-token')
  })

  it('refuses a missing actor id or token before calling Apify', async () => {
    await expect(runApifyActor({ ...base, actorId: ' ' })).rejects.toThrow('Apify actor id is required')
    await expect(runApifyActor({ ...base, token: '' })).rejects.toThrow('Apify token is required')
    expect(start).not.toHaveBeenCalled()
  })

  it('stops waiting when the caller aborts', async () => {
    start.mockResolvedValue({ id: 'run-4', status: 'READY' })
    waitForFinish.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const pending = runApifyActor({ ...base, signal: controller.signal }).catch((e) => e)
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    expect((await pending).message).toBe('Apify request was cancelled')
  })
})
