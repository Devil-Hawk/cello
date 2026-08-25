import { describe, expect, it } from 'vitest'
import {
  assertNoPrefixCollision,
  assertSsrfSafe,
  checkSsrf,
  DEFAULT_MAX_RESPONSE_BYTES,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  isNamespacedToolName,
  isValidProviderId,
  namespaceToolName,
  readLimitedBody,
  readLimitedText,
  UntrustedCallError,
  withTimeout,
} from './untrusted'

describe('isBlockedIpv4', () => {
  it('blocks loopback', () => {
    expect(isBlockedIpv4('127.0.0.1')).toBe(true)
    expect(isBlockedIpv4('127.255.255.255')).toBe(true)
  })

  it('blocks the cloud metadata endpoint and the rest of link-local space', () => {
    expect(isBlockedIpv4('169.254.169.254')).toBe(true)
    expect(isBlockedIpv4('169.254.0.1')).toBe(true)
  })

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedIpv4('10.0.0.5')).toBe(true)
    expect(isBlockedIpv4('172.16.0.1')).toBe(true)
    expect(isBlockedIpv4('172.31.255.255')).toBe(true)
    expect(isBlockedIpv4('192.168.1.1')).toBe(true)
  })

  it('does not block a 172.x address outside the RFC1918 /12 slice', () => {
    expect(isBlockedIpv4('172.32.0.1')).toBe(false)
    expect(isBlockedIpv4('172.15.255.255')).toBe(false)
  })

  it('allows an ordinary public address', () => {
    expect(isBlockedIpv4('8.8.8.8')).toBe(false)
    expect(isBlockedIpv4('93.184.216.34')).toBe(false)
  })
})

describe('isBlockedIpv6', () => {
  it('blocks loopback and unspecified', () => {
    expect(isBlockedIpv6('::1')).toBe(true)
    expect(isBlockedIpv6('::')).toBe(true)
  })

  it('blocks link-local (fe80::/10)', () => {
    expect(isBlockedIpv6('fe80::1')).toBe(true)
    expect(isBlockedIpv6('febf::1')).toBe(true)
  })

  it('blocks unique-local (fc00::/7)', () => {
    expect(isBlockedIpv6('fc00::1')).toBe(true)
    expect(isBlockedIpv6('fd12:3456::1')).toBe(true)
  })

  it('blocks an IPv4-mapped address whose embedded v4 is blocked, dotted form', () => {
    expect(isBlockedIpv6('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIpv6('::ffff:169.254.169.254')).toBe(true)
  })

  it('blocks an IPv4-mapped address whose embedded v4 is blocked, hex-group form', () => {
    // ::ffff:7f00:1 == ::ffff:127.0.0.1 (what Node's URL parser normalizes a
    // bracketed "[::ffff:127.0.0.1]" literal to — see module header).
    expect(isBlockedIpv6('::ffff:7f00:1')).toBe(true)
    // ::ffff:a9fe:a9fe == ::ffff:169.254.169.254
    expect(isBlockedIpv6('::ffff:a9fe:a9fe')).toBe(true)
  })

  it('allows a public IPv6 address, including a public IPv4-mapped one', () => {
    expect(isBlockedIpv6('2001:4860:4860::8888')).toBe(false)
    expect(isBlockedIpv6('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('isBlockedIp', () => {
  it('dispatches on address family', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('::1')).toBe(true)
    expect(isBlockedIp('8.8.8.8')).toBe(false)
  })

  it('is false (not "blocked") for a string that is not a valid IP at all', () => {
    expect(isBlockedIp('example.com')).toBe(false)
  })
})

describe('checkSsrf', () => {
  it('rejects a non-http(s) scheme', async () => {
    const result = await checkSsrf('file:///etc/passwd')
    expect(result).toMatchObject({ ok: false, reason: 'blocked_scheme' })
  })

  it('rejects ftp and data schemes too', async () => {
    expect((await checkSsrf('ftp://example.com/file')).ok).toBe(false)
    expect((await checkSsrf('data:text/plain,hello')).ok).toBe(false)
  })

  it('rejects a string that is not a URL at all', async () => {
    const result = await checkSsrf('not a url')
    expect(result).toMatchObject({ ok: false, reason: 'invalid_url' })
  })

  it('rejects a bare IPv4 loopback literal, no DNS involved', async () => {
    const result = await checkSsrf('http://127.0.0.1/', {
      resolveHostname: () => {
        throw new Error('should never be called for an IP literal')
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'blocked_address' })
  })

  it('rejects the cloud metadata IP literal', async () => {
    const result = await checkSsrf('http://169.254.169.254/latest/meta-data/')
    expect(result).toMatchObject({ ok: false, reason: 'blocked_address' })
  })

  it('rejects obfuscated-IPv4 forms (decimal/octal/hex) via Node\'s own URL normalization', async () => {
    // 2130706433 / 017700000001 / 0x7f000001 are all 127.0.0.1.
    expect((await checkSsrf('http://2130706433/')).ok).toBe(false)
    expect((await checkSsrf('http://017700000001/')).ok).toBe(false)
    expect((await checkSsrf('http://0x7f000001/')).ok).toBe(false)
  })

  it('rejects a bracketed IPv6 loopback literal', async () => {
    const result = await checkSsrf('http://[::1]/')
    expect(result).toMatchObject({ ok: false, reason: 'blocked_address' })
  })

  it('rejects a bracketed IPv6 literal wrapping the metadata IP', async () => {
    const result = await checkSsrf('http://[::ffff:169.254.169.254]/')
    expect(result).toMatchObject({ ok: false, reason: 'blocked_address' })
  })

  it('rejects a blocked literal hostname before any DNS lookup', async () => {
    const result = await checkSsrf('http://localhost:5432/', {
      resolveHostname: () => {
        throw new Error('should never be called for a blocked literal hostname')
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'blocked_hostname' })
  })

  it('rejects .local and .localhost suffixes, and a known metadata hostname', async () => {
    expect((await checkSsrf('http://printer.local/')).ok).toBe(false)
    expect((await checkSsrf('http://foo.localhost/')).ok).toBe(false)
    expect((await checkSsrf('http://metadata.google.internal/')).ok).toBe(false)
  })

  it('rejects a hostname whose DNS resolution includes a private address, even alongside a public one', async () => {
    const result = await checkSsrf('http://evil.example.com/', {
      resolveHostname: async () => [
        { address: '203.0.113.5', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    })
    expect(result).toMatchObject({ ok: false, reason: 'blocked_address' })
  })

  it('allows a hostname whose DNS resolution is entirely public', async () => {
    const result = await checkSsrf('https://example.com/api', {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    expect(result).toMatchObject({ ok: true, hostname: 'example.com', addresses: ['93.184.216.34'] })
  })

  it('surfaces a DNS lookup failure as its own reason rather than throwing', async () => {
    const result = await checkSsrf('http://does-not-resolve.example/', {
      resolveHostname: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'dns_lookup_failed' })
  })

  it('strips a trailing dot before the hostname/literal-blocklist check', async () => {
    const result = await checkSsrf('http://localhost./', {
      resolveHostname: () => {
        throw new Error('should never be called — "localhost." should hit the literal blocklist first')
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'blocked_hostname' })
  })
})

describe('assertSsrfSafe', () => {
  it('throws UntrustedCallError for a blocked target', async () => {
    await expect(assertSsrfSafe('http://127.0.0.1/')).rejects.toBeInstanceOf(UntrustedCallError)
    await expect(assertSsrfSafe('http://127.0.0.1/')).rejects.toMatchObject({ code: 'blocked' })
  })

  it('resolves for a safe target', async () => {
    await expect(
      assertSsrfSafe('https://example.com/', { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] })
    ).resolves.toBeUndefined()
  })
})

describe('withTimeout', () => {
  it('resolves with the value when the promise settles first', async () => {
    const result = await withTimeout(Promise.resolve('done'), 50, 'quick op')
    expect(result).toBe('done')
  })

  it('rejects with UntrustedCallError("timeout") when the timer wins', async () => {
    const neverResolves = new Promise<never>(() => {})
    await expect(withTimeout(neverResolves, 10, 'slow op')).rejects.toBeInstanceOf(UntrustedCallError)
    await expect(withTimeout(neverResolves, 10, 'slow op')).rejects.toMatchObject({ code: 'timeout' })
  })

  it('propagates the original rejection when the promise rejects before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom')
  })
})

describe('readLimitedBody / readLimitedText', () => {
  it('reads a body under the cap normally', async () => {
    const res = new Response('hello world')
    const text = await readLimitedText(res, 1000)
    expect(text).toBe('hello world')
  })

  it('throws too_large once streamed bytes exceed the cap, even with no content-length', async () => {
    const makeStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('a'.repeat(50)))
          controller.enqueue(new TextEncoder().encode('b'.repeat(50)))
          controller.close()
        },
      })
    await expect(readLimitedBody(new Response(makeStream()), 60)).rejects.toBeInstanceOf(UntrustedCallError)
    await expect(readLimitedBody(new Response(makeStream()), 60)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('fails fast on a declared content-length over the cap, without needing to read the body', async () => {
    const res = new Response('short body', { headers: { 'content-length': '999999999' } })
    await expect(readLimitedBody(res, 1000)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('does not trust a content-length that UNDERSTATES the real body — streaming check still catches it', async () => {
    const res = new Response('x'.repeat(200), { headers: { 'content-length': '5' } })
    await expect(readLimitedBody(res, 100)).rejects.toMatchObject({ code: 'too_large' })
  })

  it('the default cap is generous enough for an ordinary API response', () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBeGreaterThan(1_000_000)
  })
})

describe('tool-name namespacing', () => {
  it('namespaces a provider + raw tool name under a prefix', () => {
    expect(namespaceToolName('mcp:', 'my_server', 'list_jobs')).toBe('mcp:my_server:list_jobs')
  })

  it('a namespaced name can never equal a built-in name, even if the provider names its tool identically', () => {
    const builtins = ['list_jobs', 'score_jobs']
    const qualified = namespaceToolName('mcp:', 'attacker_server', 'list_jobs')
    expect(builtins.includes(qualified)).toBe(false)
  })

  it('rejects an invalid provider id', () => {
    expect(() => namespaceToolName('mcp:', 'has a space', 'tool')).toThrow()
    expect(() => namespaceToolName('mcp:', '', 'tool')).toThrow()
    expect(() => namespaceToolName('mcp:', 'server:with:colons', 'tool')).toThrow()
  })

  it('rejects an empty raw tool name', () => {
    expect(() => namespaceToolName('mcp:', 'server', '  ')).toThrow()
  })

  it('isValidProviderId matches the identifier shape used elsewhere for MCP server names', () => {
    expect(isValidProviderId('my-server_1')).toBe(true)
    expect(isValidProviderId('has space')).toBe(false)
    expect(isValidProviderId('')).toBe(false)
  })

  it('isNamespacedToolName recognizes the prefix and rejects the bare prefix alone', () => {
    expect(isNamespacedToolName('mcp:server:tool', 'mcp:')).toBe(true)
    expect(isNamespacedToolName('list_jobs', 'mcp:')).toBe(false)
    expect(isNamespacedToolName('mcp:', 'mcp:')).toBe(false)
  })

  it('assertNoPrefixCollision passes when no built-in starts with the prefix', () => {
    expect(() => assertNoPrefixCollision(['list_jobs', 'score_jobs'], 'mcp:')).not.toThrow()
  })

  it('assertNoPrefixCollision throws when a built-in name would collide with the reserved prefix', () => {
    expect(() => assertNoPrefixCollision(['list_jobs', 'mcp:oops'], 'mcp:')).toThrow(/mcp:oops/)
  })
})
