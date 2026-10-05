import { describe, expect, it } from 'vitest'
import { blurbOf } from './studies'

describe('blurbOf', () => {
  it('keeps only the part where the company talks about itself, before anything a candidate needs', () => {
    const about = 'About Acme. Acme builds payment tools used by millions of businesses around the world, and our mission is to make money move as easily as information does. '.repeat(2)
    const out = blurbOf(`${about}What you bring: 5+ years of backend experience. Strong Go.`)
    expect(out).toBeTruthy()
    expect(out!.length).toBeLessThanOrEqual(600)
    expect(out).not.toMatch(/years|Strong Go/)
  })

  it('is null when the posting opens straight into requirements or is too short to be a blurb', () => {
    expect(blurbOf('Requirements: 3+ years of Go. We offer equity.')).toBeNull()
    expect(blurbOf('Join our team.')).toBeNull()
  })
})
