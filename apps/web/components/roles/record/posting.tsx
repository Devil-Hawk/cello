import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { Key } from '@/components/ui/key'
import { isPartial, needsFold, sourceLine } from './logic'

export interface PostingProps {
  /** The posting as the employer wrote it. */
  text: string
  company: string
  /** The employer's own page for it. */
  url: string | null
  tier: string | null
  closed: boolean
  checkedAt: string | null
}

// The whole posting, headings and lists kept, as the employer wrote it. It goes
// through react-markdown with GFM and rehype-sanitize and never through raw HTML,
// so a script tag in a posting shows as text. A long one is folded after 12 lines
// by CSS (the checkbox is the whole mechanism, so it works with no script).
export function Posting({ text, company, url, tier, closed, checkedAt }: PostingProps) {
  const read = sourceLine(company, tier, closed, checkedAt)
  const body = (
    <div className="r-body r-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  )
  return (
    <div className="space-y-4">
      {isPartial(text) && <p className="r-body">Cello has only part of this posting.</p>}
      {text.trim() &&
        (needsFold(text) ? (
          <div className="r-fold">
            <input id="posting-fold" type="checkbox" className="r-fold-input sr-only" />
            <div className="r-fold-body">
              {body}
              <span className="r-fold-fade" aria-hidden />
            </div>
            <label htmlFor="posting-fold" className="r-fold-label r-key r-key-raised mt-3 min-h-11 cursor-pointer font-r">
              Read the whole posting
            </label>
          </div>
        ) : (
          body
        ))}
      {read && <p className="r-meta">{read}</p>}
      {url && (
        <Key asChild variant="raised">
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open on {company}&apos;s site
          </a>
        </Key>
      )}
    </div>
  )
}
