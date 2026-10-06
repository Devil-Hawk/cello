// A same-origin check for cookie-authenticated state changes.
//
// The session is a cookie, so a hostile page can make a signed-in owner's browser
// POST to us. SameSite cookies stop most of that; this closes the rest on the
// routes that mint or revoke access (and the anonymous redeem endpoint, which a
// hostile page could otherwise use to burn someone's attempts or sign their
// browser into a demo).
//
// Rules, in order:
//   1. Sec-Fetch-Site, when the browser sends it, must be 'same-origin'.
//      ('none' means a user-typed navigation, which is not a fetch to a POST
//      route and is refused too.)
//   2. Otherwise the Origin header's host must equal the host the request was
//      addressed to (x-forwarded-host when a proxy set it, else host).
//   3. Neither header present means refuse. Every browser sends at least one of
//      them on a cross-site POST; a request carrying neither is not a browser
//      acting for a signed-in person.

export function isSameOriginRequest(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'

  const origin = headers.get('origin')
  if (!origin) return false

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0].trim()
  return host !== '' && originHost.toLowerCase() === host.toLowerCase()
}

/** True when the browser says another site made this request. The softer
 *  sibling of isSameOriginRequest, for routes a non-browser client also calls:
 *  a request with neither header is not a browser acting across sites, so it
 *  passes. Browsers always send Sec-Fetch-Site, so a hostile page cannot hide.
 *
 *  'same-site' counts as cross-site on purpose: a sibling subdomain is not us. */
export function isCrossSiteRequest(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site')
  if (site !== null) return site !== 'same-origin' && site !== 'none'

  const origin = headers.get('origin')
  if (!origin) return false

  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }
  const host = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '').split(',')[0].trim()
  return host === '' ? false : originHost.toLowerCase() !== host.toLowerCase()
}
