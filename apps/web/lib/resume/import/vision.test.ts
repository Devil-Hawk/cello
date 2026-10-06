import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } }
  },
}))

import { VISION_MODELS, transcribeWithOpenRouter } from './vision'

const ok = (text: string) => ({ choices: [{ message: { content: text } }] })
const image = { bytes: Buffer.from('abc'), mimeType: 'image/jpeg', filename: 'cv.jpg' }

describe('transcribeWithOpenRouter', () => {
  beforeEach(() => {
    create.mockReset()
  })

  it('sends the instruction before the picture, as a data URL', async () => {
    create.mockResolvedValue(ok('Jordan Rivera\nSEATTLE'))
    const text = await transcribeWithOpenRouter('k', image)
    expect(text).toBe('Jordan Rivera\nSEATTLE')
    const body = create.mock.calls[0][0]
    expect(body.model).toBe(VISION_MODELS[0])
    expect(body.messages[0]).toMatchObject({ role: 'system' })
    expect(body.messages[0].content).toContain('Use only what this request gives you')
    const parts = body.messages[1].content
    expect(parts[0].type).toBe('text')
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YWJj' } })
  })

  it('sends a PDF as a file part', async () => {
    create.mockResolvedValue(ok('text'))
    await transcribeWithOpenRouter('k', { bytes: Buffer.from('abc'), mimeType: 'application/pdf', filename: 'scan.pdf' })
    const part = create.mock.calls[0][0].messages[1].content[1]
    expect(part).toEqual({
      type: 'file',
      file: { filename: 'scan.pdf', file_data: 'data:application/pdf;base64,YWJj' },
    })
  })

  it('tries the next model when the first is unknown', async () => {
    create.mockRejectedValueOnce(Object.assign(new Error('no such model'), { status: 404 }))
    create.mockResolvedValueOnce(ok('second'))
    expect(await transcribeWithOpenRouter('k', image)).toBe('second')
    expect(create.mock.calls.map((c) => c[0].model)).toEqual(VISION_MODELS)
  })

  it('does not hide a bad key behind a model fallback', async () => {
    create.mockImplementation(async () => {
      throw Object.assign(new Error('bad key'), { status: 401 })
    })
    await expect(transcribeWithOpenRouter('k', image)).rejects.toThrow('bad key')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('fails when the model returns nothing', async () => {
    create.mockResolvedValue(ok('   '))
    await expect(transcribeWithOpenRouter('k', image)).rejects.toThrow(/no text/)
  })
})
