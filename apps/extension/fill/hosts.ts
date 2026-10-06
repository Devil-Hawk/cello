import type { AutoHost } from '../lib/fill-contract'

// The three hosted-form families the extension fills. Matches carry no port.
export const ATS_HOSTS = ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com'] as const
export const ATS_MATCHES: string[] = ATS_HOSTS.map((h) => `https://${h}/*`)

export function isAtsHost(host: string): boolean {
  return (ATS_HOSTS as readonly string[]).includes(host)
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export interface Posting {
  host: string
  board: string
  job: string
}

/** The posting a URL names under the server's host list, or null. */
export function postingOf(url: string, hosts: AutoHost[]): Posting | null {
  const u = parse(url)
  if (!u || u.protocol !== 'https:') return null
  for (const h of hosts) {
    if (h.host !== u.hostname) continue
    let g: Record<string, string> | undefined
    try {
      g = new RegExp(h.url_pattern).exec(u.href)?.groups
    } catch {
      continue
    }
    if (g?.board && g?.job) return { host: u.hostname, board: g.board, job: g.job }
  }
  return null
}

/** True when both URLs are on a listed host and name the same board and job. */
export function samePosting(a: string, b: string, hosts: AutoHost[]): boolean {
  const pa = postingOf(a, hosts)
  const pb = postingOf(b, hosts)
  return !!pa && !!pb && pa.board === pb.board && pa.job === pb.job && pa.host === pb.host
}

export function hostListed(url: string, hosts: AutoHost[]): boolean {
  const u = parse(url)
  return !!u && u.protocol === 'https:' && hosts.some((h) => h.host === u.hostname)
}
