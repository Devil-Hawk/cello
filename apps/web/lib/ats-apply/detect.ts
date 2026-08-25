// Detect the ATS + slug/jobId from a job posting (apply) URL.
//
// Ported from career-ops `prepare-application.mjs` (detectAts + SAFE_SLUG host
// allowlist). Extended to the region hosts Cello's read adapters recognize
// (boards.eu.greenhouse.io, job-boards.greenhouse.io, jobs.eu.lever.co).
//
// Portions adapted from career-ops, MIT License:
//   Copyright (c) 2026 Santiago Fernández de Valderrama
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction... (full text in career-ops/LICENSE).

import type { ApplyProviderId, DetectedApply } from './types'

/** Same character class career-ops uses to guard slugs before URL interpolation. */
const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/

const GREENHOUSE_HOSTS = new Set([
  'boards.greenhouse.io',
  'boards.eu.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
  'greenhouse.io',
])
const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co', 'lever.co'])
const ASHBY_HOSTS = new Set(['jobs.ashbyhq.com', 'ashbyhq.com'])

/**
 * Parse a posting/apply URL into { provider, slug, jobId }. Pure, never throws,
 * returns null when the URL is not a recognized Greenhouse/Lever/Ashby posting.
 */
export function detectApplyTarget(rawUrl: string | null | undefined): DetectedApply | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  const host = url.hostname
  const path = url.pathname
  const provider = providerForHost(host)
  if (!provider) return null

  if (provider === 'greenhouse') {
    // .../{board}/jobs/{numericId}  (also tolerate embed ?for=)
    const m = path.match(/^\/(?:embed\/job_app\/)?([^/]+)\/jobs\/(\d+)/)
    if (m) {
      const [, slug, jobId] = m
      if (!SAFE_SLUG.test(slug)) return null
      return { provider, slug, jobId, host }
    }
    const forToken = url.searchParams.get('for')
    if (forToken && SAFE_SLUG.test(forToken)) {
      return { provider, slug: forToken, jobId: null, host }
    }
    const seg = path.split('/').filter(Boolean)[0]
    return seg && SAFE_SLUG.test(seg) ? { provider, slug: seg, jobId: null, host } : null
  }

  // Lever + Ashby: /{slug}/{jobId}
  const seg = path.match(/^\/([^/]+)\/([^/?#]+)/)
  if (seg) {
    const [, slug, jobId] = seg
    if (!SAFE_SLUG.test(slug) || !SAFE_SLUG.test(jobId)) return null
    return { provider, slug, jobId, host }
  }
  // Company landing without a posting id (still useful for handoff).
  const only = path.split('/').filter(Boolean)[0]
  return only && SAFE_SLUG.test(only) ? { provider, slug: only, jobId: null, host } : null
}

function providerForHost(host: string): ApplyProviderId | null {
  if (GREENHOUSE_HOSTS.has(host)) return 'greenhouse'
  if (LEVER_HOSTS.has(host)) return 'lever'
  if (ASHBY_HOSTS.has(host)) return 'ashby'
  return null
}

/** Human-facing apply URL the candidate opens to finish a handoff. */
export function buildApplyUrl(target: DetectedApply, originalUrl: string): string {
  switch (target.provider) {
    case 'greenhouse':
      // Greenhouse posting pages render the application form inline at #app.
      return target.jobId
        ? `https://${normalizedGreenhouseHost(target.host)}/${target.slug}/jobs/${target.jobId}#app`
        : originalUrl
    case 'lever':
      return target.jobId
        ? `https://${target.host}/${target.slug}/${target.jobId}/apply`
        : originalUrl
    case 'ashby':
      return target.jobId
        ? `https://jobs.ashbyhq.com/${target.slug}/${target.jobId}/application`
        : originalUrl
    default:
      return originalUrl
  }
}

function normalizedGreenhouseHost(host: string): string {
  // Bare greenhouse.io isn't a board host; route through boards.greenhouse.io.
  return host === 'greenhouse.io' ? 'boards.greenhouse.io' : host
}
