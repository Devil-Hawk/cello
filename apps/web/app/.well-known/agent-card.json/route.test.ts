// GET /.well-known/agent-card.json — public discovery, no auth, no
// secrets. Also pins that the served card is the exact shape
// @a2a-js/sdk/compat/v0_3's LegacyRestTransportHandler / a real A2A client
// expects (protocolVersion, url, preferredTransport, a bearer
// securityScheme with no credential value inside it).

import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

describe('GET /.well-known/agent-card.json', () => {
  it('serves the classic v0.3 wire-shaped card with no auth required', async () => {
    const res = await GET(new NextRequest('http://localhost/.well-known/agent-card.json'))
    expect(res.status).toBe(200)
    const card = await res.json()
    expect(card.protocolVersion).toBe('0.3')
    expect(card.url).toBe('http://localhost/api/a2a')
    expect(card.preferredTransport).toBe('JSONRPC')
    expect(card.skills.map((s: { id: string }) => s.id).sort()).toEqual(['company_researcher', 'interview_prep', 'matcher'])
  })

  it('declares a bearer securityScheme and carries no secret', () => {
    return GET(new NextRequest('http://localhost/.well-known/agent-card.json')).then(async (res) => {
      const card = await res.json()
      expect(card.securitySchemes.bearer).toEqual({ type: 'http', scheme: 'bearer', description: expect.any(String) })
      expect(JSON.stringify(card)).not.toMatch(/cello_pat_/)
    })
  })

  it('derives the url from the request origin, not a hardcoded host', async () => {
    const res = await GET(new NextRequest('https://cello.example.com/.well-known/agent-card.json'))
    const card = await res.json()
    expect(card.url).toBe('https://cello.example.com/api/a2a')
  })
})
