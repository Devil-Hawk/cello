import { describe, expect, it } from 'vitest'
import { isCrossSiteRequest, isSameOriginRequest } from './same-origin'

const h = (init: Record<string, string>) => new Headers(init)

describe('isSameOriginRequest', () => {
  it('allows a same-origin fetch', () => {
    expect(isSameOriginRequest(h({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
  })

  it('refuses cross-site, same-site and user-navigation fetches', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(isSameOriginRequest(h({ 'sec-fetch-site': site, origin: 'https://cello.app', host: 'cello.app' }))).toBe(false)
    }
  })

  it('without Sec-Fetch-Site, compares the Origin host with the host asked for', () => {
    expect(isSameOriginRequest(h({ origin: 'https://cello.app', host: 'cello.app' }))).toBe(true)
    expect(isSameOriginRequest(h({ origin: 'https://evil.example', host: 'cello.app' }))).toBe(false)
    expect(isSameOriginRequest(h({ origin: 'https://cello.app.evil.example', host: 'cello.app' }))).toBe(false)
    expect(isSameOriginRequest(h({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true)
    expect(isSameOriginRequest(h({ origin: 'http://localhost:3001', host: 'localhost:3000' }))).toBe(false)
  })

  it('trusts x-forwarded-host over host when a proxy set it', () => {
    expect(isSameOriginRequest(h({ origin: 'https://cello.app', host: 'internal:8080', 'x-forwarded-host': 'cello.app' }))).toBe(true)
    expect(isSameOriginRequest(h({ origin: 'https://cello.app', host: 'cello.app', 'x-forwarded-host': 'other.example' }))).toBe(false)
  })

  it('refuses a request with no origin signal at all, and a malformed Origin', () => {
    expect(isSameOriginRequest(h({}))).toBe(false)
    expect(isSameOriginRequest(h({ host: 'cello.app' }))).toBe(false)
    expect(isSameOriginRequest(h({ origin: 'not a url', host: 'cello.app' }))).toBe(false)
    expect(isSameOriginRequest(h({ origin: 'null', host: 'cello.app' }))).toBe(false)
  })
})

describe('isCrossSiteRequest', () => {
  it('is true for any Sec-Fetch-Site other than same-origin and none', () => {
    for (const site of ['cross-site', 'same-site']) expect(isCrossSiteRequest(h({ 'sec-fetch-site': site }))).toBe(true)
    for (const site of ['same-origin', 'none']) expect(isCrossSiteRequest(h({ 'sec-fetch-site': site }))).toBe(false)
  })

  it('without Sec-Fetch-Site, is true only for an Origin on another host', () => {
    expect(isCrossSiteRequest(h({ origin: 'https://evil.example', host: 'cello.app' }))).toBe(true)
    expect(isCrossSiteRequest(h({ origin: 'https://cello.app', host: 'cello.app' }))).toBe(false)
    expect(isCrossSiteRequest(h({ origin: 'not a url', host: 'cello.app' }))).toBe(true)
  })

  it('passes a request with neither header, so non-browser clients keep working', () => {
    expect(isCrossSiteRequest(h({}))).toBe(false)
  })
})
