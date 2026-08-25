'use client'

// The formatted half of the resume studio: the Markdown the user is editing,
// rendered the way the chosen template will export it.
//
// UNTRUSTED INPUT, RENDERED AS HTML
//   Resume text arrives from an uploaded file and from an LLM rewrite. Neither
//   is trustworthy, and this component turns it into DOM. rehype-sanitize
//   (GitHub's default schema) is therefore load-bearing, not polish: it strips
//   raw HTML, scripts and javascript: URLs while leaving the markup
//   react-markdown itself emits. Do not remove it, and do not add
//   `rehype-raw`/`allowDangerousHtml` next to it — that combination is exactly
//   the hole sanitisation is here to close. (lib/resume/markdown.ts drops raw
//   HTML from the export for the same reason, so keeping it out of the preview
//   also keeps the two in agreement.)
//
// IT MUST NOT LIE ABOUT STRUCTURE
//   Every rule below mirrors a lowering rule in lib/resume/markdown.ts, so what
//   is on screen is what the PDF/DOCX will contain:
//     h4-h6      -> rendered as h3 (the model clamps)
//     blockquote -> children spliced in as ordinary blocks (no quote styling)
//     image      -> alt text only
//     ~~struck~~ -> words kept, mark dropped
//     GFM table  -> ONE LINE PER ROW, cells joined by " — ", never a grid
//   The table rule is the one worth stating out loud: a real <table> here would
//   promise a layout the exporter deliberately refuses to produce, because a
//   table in a resume PDF is the single most reliable way to get mangled by an
//   ATS.
//
// The sheet is white in both themes on purpose — it is a preview of a printed
// page, not a panel of the app. Template colours are print colours and are all
// high-contrast on white.

import { useMemo, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { getTemplate, type TemplateSpec } from '@/lib/resume/templates'
import { cn } from '@/lib/utils'
import { resumePreviewStyles, splitResumeHeader, type ResumePreviewStyles } from './template-preview-style'

const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeSanitize]

/**
 * The parts that cannot be expressed as inline styles: pseudo-element bullet
 * glyphs, the em-dash between table cells, and hanging indents. Every value it
 * reads is a custom property set from the TemplateSpec (see
 * template-preview-style.ts) — no user text ever reaches this stylesheet.
 */
const SHEET_CSS = `
.rp-sheet, .rp-sheet * { box-sizing: border-box; }
.rp-sheet p { margin: 0 0 var(--rp-para-gap) 0; }
.rp-sheet p:last-child { margin-bottom: 0; }
.rp-sheet ul, .rp-sheet ol { list-style: none; margin: 0 0 var(--rp-para-gap) 0; padding: 0; }
.rp-sheet li { position: relative; padding-left: var(--rp-hang); margin-bottom: var(--rp-item-gap); }
.rp-sheet li:last-child { margin-bottom: 0; }
.rp-sheet li > p { margin: 0; }
.rp-sheet li::before { position: absolute; left: 0; top: 0; }
.rp-sheet ul > li::before { content: var(--rp-bullet-0); }
.rp-sheet ul ul > li::before { content: var(--rp-bullet-1); }
.rp-sheet ul ul ul > li::before { content: var(--rp-bullet-2); }
.rp-sheet ol { counter-reset: rp-ol; }
.rp-sheet ol > li { counter-increment: rp-ol; }
.rp-sheet ol > li::before { content: counter(rp-ol) "."; }
.rp-sheet li > ul, .rp-sheet li > ol { margin: var(--rp-item-gap) 0 0 var(--rp-indent); }
.rp-sheet a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.rp-sheet code { font-family: var(--rp-mono); font-size: 0.95em; }
.rp-sheet strong { font-weight: 700; }
.rp-sheet em { font-style: italic; }
.rp-sheet table, .rp-sheet thead, .rp-sheet tbody, .rp-sheet tr { display: block; width: 100%; }
.rp-sheet tr { margin-bottom: var(--rp-para-gap); }
.rp-sheet th, .rp-sheet td { display: inline; padding: 0; text-align: left; font-weight: inherit; }
.rp-sheet th + th::before, .rp-sheet td + td::before { content: " — "; }
`

/** Heading renderers: h1-h3 styled from the spec, h4-h6 clamped to h3. */
function headingComponents(styles: ResumePreviewStyles): Partial<Components> {
  return {
    h1: ({ children }) => <h1 style={styles.headings[1]}>{children}</h1>,
    h2: ({ children }) => <h2 style={styles.headings[2]}>{children}</h2>,
    h3: ({ children }) => <h3 style={styles.headings[3]}>{children}</h3>,
    h4: ({ children }) => <h3 style={styles.headings[3]}>{children}</h3>,
    h5: ({ children }) => <h3 style={styles.headings[3]}>{children}</h3>,
    h6: ({ children }) => <h3 style={styles.headings[3]}>{children}</h3>,
  }
}

/**
 * The leaf-level lowering rules, shared by the body AND the name/contact header.
 * They live in one place because the header is rendered through its own
 * component map: when these were only on the body map, a `~~struck~~` name kept
 * its <del> and an image on the first line rendered as an <img> — the export
 * would have shown neither. Anything that lowers a NODE (rather than styling a
 * block) belongs here.
 */
function leafComponents(): Components {
  return {
    // Strikethrough keeps the words and drops the mark, as the export does.
    del: ({ children }) => <>{children}</>,
    // Images contribute their alt text and nothing else.
    img: ({ alt }) => <>{alt ?? ''}</>,
    a: ({ children, href }) => (
      <a href={href} rel="noreferrer noopener" target="_blank">
        {children}
      </a>
    ),
  }
}

function bodyComponents(styles: ResumePreviewStyles): Components {
  return {
    ...headingComponents(styles),
    ...leafComponents(),
    p: ({ children }) => <p>{children}</p>,
    // role="list" keeps list semantics in Safari, which drops them when
    // list-style is none — and it is none here so the template's own bullet
    // glyph can be drawn.
    ul: ({ children }) => <ul role="list" style={styles.list}>{children}</ul>,
    // `start` is carried through deliberately: lib/resume/markdown.ts numbers an
    // ordered list from the source's own `start`, so a list authored as "5." must
    // read 5. here too. The counter is seeded to start-1 because the ::before
    // rule increments before it prints. Without this the preview renumbers from
    // 1 and silently disagrees with the exported document.
    ol: ({ children, start }) => (
      <ol
        role="list"
        style={{ ...styles.list, counterReset: `rp-ol ${(typeof start === 'number' ? start : 1) - 1}` }}
      >
        {children}
      </ol>
    ),
    hr: () => <hr style={styles.rule} />,
    // The block model splices a blockquote's children in as ordinary blocks.
    blockquote: ({ children }) => <div>{children}</div>,
    // Fenced code lowers to a paragraph of mono runs, not a code card.
    pre: ({ children }) => <div style={{ fontFamily: 'var(--rp-mono)' }}>{children}</div>,
  }
}

/**
 * The name/contact header. Whatever block the source used (an `# h1`, or a bare
 * line of plain text) collapses to one styled block — the template's nameBlock
 * decides how it looks, not the author's choice of marker.
 */
function headerComponents(style: CSSProperties): Components {
  const flat = ({ children }: { children?: ReactNode }) => (
    <span style={{ display: 'block', ...style }}>{children}</span>
  )
  return {
    ...leafComponents(),
    p: flat,
    h1: flat,
    h2: flat,
    h3: flat,
    h4: flat,
    h5: flat,
    h6: flat,
  }
}

export interface ResumePreviewProps {
  /** The authored Markdown. */
  markdown: string
  /** Stored template id; anything unknown degrades to the default via getTemplate(). */
  templateId?: string | null
  /** Pass a spec directly (the picker's thumbnails do) instead of an id. */
  spec?: TemplateSpec
  className?: string
  'aria-label'?: string
}

export function ResumePreview({
  markdown,
  templateId,
  spec,
  className,
  'aria-label': ariaLabel = 'Formatted resume preview',
}: ResumePreviewProps) {
  const template = spec ?? getTemplate(templateId)
  const styles = useMemo(() => resumePreviewStyles(template), [template])
  const components = useMemo(() => bodyComponents(styles), [styles])
  const nameComponents = useMemo(() => headerComponents(styles.name), [styles.name])
  const contactComponents = useMemo(() => headerComponents(styles.contact), [styles.contact])
  const { name, contact, body } = useMemo(() => splitResumeHeader(markdown), [markdown])

  const isEmpty = !name && body.trim().length === 0

  return (
    <div
      // A scrollable region needs to be reachable by keyboard, or a keyboard-only
      // user cannot read a resume longer than the pane (axe: scrollable-region-focusable).
      tabIndex={0}
      role="region"
      aria-label={ariaLabel}
      className={cn(
        'min-h-0 flex-1 overflow-auto rounded-control border bg-sunken/60 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      {/*
        dangerouslySetInnerHTML, and it is the SAFE option here rather than the
        risky one. React escapes a text child of <style> (`>` becomes `&gt;`,
        `"` becomes `&quot;`), but <style> is a raw-text element in HTML, so
        those entities are never decoded back — the child combinators and the
        quoted `content:` values below arrive at the CSS parser as literal
        `&gt;`/`&quot;` and the whole rule is dropped. That silently costs the
        preview its bullet glyphs and its list numbers. SHEET_CSS is a module
        constant with no interpolation; no user text can reach it.
      */}
      <style dangerouslySetInnerHTML={{ __html: SHEET_CSS }} />
      <div
        className="rp-sheet mx-auto w-full bg-white shadow-card"
        style={{ ...styles.vars, ...styles.page }}
      >
        {isEmpty ? (
          <p style={{ color: styles.page.color, opacity: 0.6 }}>
            Nothing to preview yet — type on the Edit tab.
          </p>
        ) : (
          <>
            {name && (
              <div style={styles.header}>
                <ReactMarkdown
                  remarkPlugins={remarkPlugins}
                  rehypePlugins={rehypePlugins}
                  components={nameComponents}
                >
                  {name}
                </ReactMarkdown>
                {contact && (
                  <ReactMarkdown
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={rehypePlugins}
                    components={contactComponents}
                  >
                    {contact}
                  </ReactMarkdown>
                )}
              </div>
            )}
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
            >
              {body}
            </ReactMarkdown>
          </>
        )}
      </div>
    </div>
  )
}
