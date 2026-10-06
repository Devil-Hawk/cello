// postingMarkdown: the employer's own HTML for one posting, cleaned and kept whole as Markdown
// (jobs.description_md, blueprint 6 "What the reader keeps"). One function for every tier: an applicant
// system's content field, a posting page's JSON-LD description, a detail page's main block, a site's search
// answer.
//
//   cheerio   drops what is not the posting: scripts, styles, forms, images, frames, svg, every attribute
//             but a link's href, and a link that does not lead somewhere safe (javascript:, data:, vbscript:);
//             tracking parameters leave the links that stay
//   turndown  keeps the structure: headings, paragraphs, lists, tables, emphasis, links
//
// Text the posting wrote that looks like HTML (a body that says "<img onerror=...>") is escaped, so no
// renderer takes it for markup. Paragraphs written with a bullet character become list items. The body is
// never cut to a summary: past MAX_MARKDOWN_CHARS it is still kept whole and the row is marked partial, so
// the record says it is long, not that it was cut.
//
// Pure: no I/O.

import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import TurndownService from 'turndown'
import type { AtsJob } from '../ats/types'
import type { PostingCapture } from '../jobs/relevance-types'

/** A body longer than this is marked partial (the guard), and kept whole up to HARD_LIMIT. */
export const MAX_MARKDOWN_CHARS = 200_000
/** ponytail: past 2 MB a body is cut and marked partial; a posting that long is a page that is not one. */
const HARD_LIMIT = 2_000_000

const REMOVE = 'script,style,noscript,template,form,input,button,select,textarea,label,img,picture,source,video,audio,canvas,iframe,frame,object,embed,svg,link,meta,head,title'
const UNSAFE_HREF = /^(javascript|data|vbscript|file):/
const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|gh_src|lever-source|lever-origin|trk)$/i
const BULLET_LINE = /^([ \t]*)[•●▪■◦‣⁃·]\s+/gm

export interface PostingMarkdown {
  md: string
  /** `partial` when the body passed the guard; a listing's snippet is marked partial by the caller. */
  state: 'full' | 'partial'
}

function safeHref(raw: string | undefined): string | null {
  if (!raw) return null
  // control characters and spaces hide a scheme ("java\tscript:"); judge the address without them
  const probe = raw.replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase()
  if (!probe || UNSAFE_HREF.test(probe)) return null
  try {
    const url = new URL(raw, 'https://placeholder.invalid')
    if (url.hostname !== 'placeholder.invalid') {
      for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
      return url.toString()
    }
  } catch {
    return null
  }
  // a relative address or a fragment stays as written
  return raw.trim()
}

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_' })
  const escape = td.escape.bind(td)
  td.escape = (s: string) => escape(s).replace(/</g, '\\<')
  return td
}

/** A body with no tags at all is text: blank lines separate paragraphs and a newline is a line break. */
function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<p>${escaped.split(/\n\s*\n/).map((p) => p.replace(/\n/g, '<br>')).join('</p><p>')}</p>`
}

/** Clean one posting's HTML to Markdown. Never throws: an HTML that cannot be parsed gives an empty body. */
export function postingMarkdown(html: string): PostingMarkdown {
  if (typeof html !== 'string' || !html.trim()) return { md: '', state: 'full' }
  const source = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/i.test(html) ? html : textToHtml(html)
  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(source.slice(0, HARD_LIMIT * 2), null, false)
  } catch {
    return { md: '', state: 'full' }
  }
  $(REMOVE).remove()
  $('*')
    .contents()
    .filter((_, node) => node.type === 'comment')
    .remove()
  $('*').each((_, el) => {
    if (el.type !== 'tag') return
    const href = el.name === 'a' ? $(el).attr('href') : undefined
    for (const name of Object.keys(el.attribs ?? {})) $(el).removeAttr(name)
    if (el.name !== 'a') return
    const safe = safeHref(href)
    // a link that goes nowhere safe keeps its words, not its target
    if (safe) $(el).attr('href', safe)
    else $(el).replaceWith($(el).contents())
  })

  let md = ''
  try {
    md = turndown().turndown($.root().html() ?? '')
  } catch {
    return { md: '', state: 'full' }
  }
  // two trailing spaces are Markdown's hard line break and stay; longer runs are noise
  md = md.replace(BULLET_LINE, '$1- ').replace(/[ \t]{3,}$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  if (md.length > HARD_LIMIT) return { md: md.slice(0, HARD_LIMIT), state: 'partial' }
  return { md, state: md.length > MAX_MARKDOWN_CHARS ? 'partial' : 'full' }
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex')

/**
 * What the reader stores of one posting's body. The employer's HTML becomes Markdown, whole (full, or partial past
 * the guard). A source that listed only a snippet keeps the snippet, marked partial. No body at all is `none`, with
 * no hash, so the next read of the employer captures it. The hash is the md5 of the Markdown, so an unchanged
 * posting hashes the same and is not re-extracted.
 */
export function postingCapture(job: Pick<AtsJob, 'url' | 'description' | 'descriptionHtml' | 'descriptionSource' | 'applyUrl'>): PostingCapture {
  const apply_url = job.applyUrl && job.applyUrl !== job.url ? job.applyUrl : null
  if (job.descriptionHtml) {
    const { md, state } = postingMarkdown(job.descriptionHtml)
    if (md) return { description_md: md, description_state: state, description_source: job.descriptionSource ?? 'api', apply_url, description_md5: md5(md) }
  }
  const snippet = job.description?.trim()
  if (snippet) return { description_md: snippet, description_state: 'partial', description_source: 'listing', apply_url, description_md5: md5(snippet) }
  return { description_md: null, description_state: 'none', description_source: null, apply_url, description_md5: null }
}
