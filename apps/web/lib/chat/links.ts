// Where a named thing opens. An answer names a thing with a link `cello:<kind>/<id>`; code (answer.ts) keeps the link
// only for a thing the part is about or this turn returned, and this turns it into the page's own link.
// ponytail: a role opens PG3's record, which does not exist until PG3 ships; swap for lib/routes/roles.ts's recordHref then.

import { ATTACH_KINDS, type AttachKind } from './types'

const enc = encodeURIComponent

/** The page a thing opens, or null when it opens in the side panel or has no page of its own. */
export function chatHref(kind: AttachKind, id: string): string | null {
  switch (kind) {
    case 'role':
      return `/roles/${enc(id)}`
    case 'company':
      return `/companies/${enc(id)}`
    case 'application':
      return '/pipeline'
    case 'person':
      return '/contacts'
    case 'chat':
      return `/chat/${enc(id)}`
    default:
      return null
  }
}

/** [label](cello:kind/id) becomes [label](page link); a thing with no page of its own keeps its words and loses the link. */
export function rewriteCelloLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\(cello:([a-z]+)\/([^)\s]+)\)/gi, (_whole, label: string, kind: string, id: string) => {
    const known = ATTACH_KINDS.find((k) => k === kind.toLowerCase())
    const href = known ? chatHref(known, id) : null
    return href ? `[${label}](${href})` : label
  })
}
