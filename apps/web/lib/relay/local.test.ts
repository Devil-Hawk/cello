import { describe, expect, it } from 'vitest'
import { CANNOT_RUN_MODEL, deviceCanRun, type DeviceNav } from './local'

const gpu = (maxBufferSize: number): DeviceNav['gpu'] => ({ requestAdapter: async () => ({ limits: { maxBufferSize } }) })

describe('deviceCanRun', () => {
  it('says this browser cannot run a model without WebGPU', async () => {
    expect(await deviceCanRun({})).toBe(CANNOT_RUN_MODEL)
    expect(await deviceCanRun({ gpu: { requestAdapter: async () => null } })).toBe(CANNOT_RUN_MODEL)
  })

  it('says it with a 256 MB buffer limit, little memory, or Save-Data on', async () => {
    expect(await deviceCanRun({ gpu: gpu(256 * 1024 ** 2) })).toBe(CANNOT_RUN_MODEL)
    expect(await deviceCanRun({ gpu: gpu(2 * 1024 ** 3), deviceMemory: 2 })).toBe(CANNOT_RUN_MODEL)
    expect(await deviceCanRun({ gpu: gpu(2 * 1024 ** 3), connection: { saveData: true } })).toBe(CANNOT_RUN_MODEL)
  })

  it('says it when the adapter request throws, and passes a capable device', async () => {
    const throwing: DeviceNav['gpu'] = {
      requestAdapter: async () => {
        throw new Error('no')
      },
    }
    expect(await deviceCanRun({ gpu: throwing })).toBe(CANNOT_RUN_MODEL)
    expect(await deviceCanRun({ gpu: gpu(2 * 1024 ** 3), deviceMemory: 8 })).toBeNull()
  })
})
