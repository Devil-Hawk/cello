import { describe, expect, it } from 'vitest'
import { matchConfirmation, toPatterns } from '../fill/confirm-text'
import { sensitivityOf } from '../fill/classify'
import { MAX_SCREENSHOT_BYTES, dataUrlBytes, fitScreenshot } from './shrink'
import { compareVersions, needsUpdate } from './version'

const dataUrl = (bytes: number): string => `data:image/jpeg;base64,${Buffer.alloc(bytes, 1).toString('base64')}`

describe('version check', () => {
  it('orders dotted versions', () => {
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })
  it('asks for an update only below the minimum', () => {
    expect(needsUpdate('0.1.0', '0.2.0')).toBe(true)
    expect(needsUpdate('0.2.0', '0.2.0')).toBe(false)
    expect(needsUpdate('0.1.0', undefined)).toBe(false)
  })
})

describe('screenshot size', () => {
  it('measures a data url', () => {
    expect(dataUrlBytes(dataUrl(1000))).toBe(1000)
  })
  it('keeps a small shot as is', async () => {
    const small = dataUrl(1000)
    expect(await fitScreenshot(small, async () => 'never')).toBe(small)
  })
  it('shrinks a 1 MB shot under 250 KB', async () => {
    const big = dataUrl(1024 * 1024)
    const out = await fitScreenshot(big, async (scale) => dataUrl(Math.round(1024 * 1024 * scale * scale * 0.3)))
    expect(out).not.toBeNull()
    expect(dataUrlBytes(out as string)).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES)
  })
  it('does not send a shot that never fits', async () => {
    expect(await fitScreenshot(dataUrl(1024 * 1024), async () => dataUrl(900_000))).toBeNull()
  })
})

describe('confirmation text', () => {
  it('finds the host sentence and ignores a banner', () => {
    expect(matchConfirmation('Header. Thank you for applying to Acme. Footer')).toContain('Thank you for applying')
    expect(matchConfirmation('Apply now to join us')).toBeNull()
  })
  it('skips a bad pattern from the server instead of throwing', () => {
    expect(toPatterns(['(', 'ok'])).toHaveLength(1)
  })
})

describe('sensitive fields', () => {
  it('treats EEO, pay, work authorization and consent as private', () => {
    expect(sensitivityOf({ label: 'Gender', name: 'g', type: 'select' })).toBe('eeo')
    expect(sensitivityOf({ label: 'Salary expectations', name: 's', type: 'text' })).toBe('sensitive')
    expect(sensitivityOf({ label: 'I agree to the terms', name: 't', type: 'checkbox' })).toBe('consent')
    expect(sensitivityOf({ label: 'First name', name: 'first_name', type: 'text' })).toBeNull()
  })
  it('lets the server category win', () => {
    expect(sensitivityOf({ label: 'First name', name: 'first_name', type: 'text' }, 'eeo')).toBe('eeo')
  })
})
