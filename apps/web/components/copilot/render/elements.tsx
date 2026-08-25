'use client'

// The react-markdown -> DOM tag mapping. One rule per component: style it to
// match the product's existing type scale and accent ramp (see
// tailwind.config.ts / app/globals.css), never reshape what the model wrote.
//
// Fenced code is special-cased at the `pre` level (not `code`) because that
// is the only place react-markdown reliably distinguishes "this is a code
// block" from "this is an inline code span" — CommonMark always wraps block
// code in <pre><code>, and never wraps inline code in <pre>. Reading the
// language out of `pre`'s child `<code className="language-xxx">` and
// handing it to <CodeBlock> means we never touch `code` twice.

import * as React from 'react'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'
import { CodeBlock } from './code-block'

function getPlainText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getPlainText).join('')
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode }
    return getPlainText(props.children)
  }
  return ''
}

export const mdComponents: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children
    const className =
      React.isValidElement(child) && typeof (child.props as { className?: string }).className === 'string'
        ? (child.props as { className?: string }).className!
        : ''
    const match = /language-([\w-]+)/.exec(className)
    const code = getPlainText(children).replace(/\n$/, '')
    return <CodeBlock language={match?.[1]} code={code} />
  },

  code({ className, children, ...props }) {
    // Only inline code spans reach here — block code is fully handled by
    // the `pre` override above and never recurses into this renderer.
    return (
      <code
        className={cn('rounded-sm bg-sunken px-1 py-0.5 font-readout text-[0.85em] text-foreground', className)}
        {...props}
      >
        {children}
      </code>
    )
  },

  h1: ({ children }) => <p className="pt-1 text-title font-semibold text-foreground first:pt-0">{children}</p>,
  h2: ({ children }) => <p className="pt-1 text-section font-semibold text-foreground first:pt-0">{children}</p>,
  h3: ({ children }) => <p className="pt-1 text-body font-semibold text-foreground first:pt-0">{children}</p>,
  h4: ({ children }) => <p className="pt-1 text-body font-semibold text-foreground first:pt-0">{children}</p>,
  h5: ({ children }) => <p className="pt-1 text-body font-semibold text-foreground first:pt-0">{children}</p>,
  h6: ({ children }) => <p className="pt-1 text-body font-semibold text-foreground first:pt-0">{children}</p>,

  p: ({ children }) => <p className="text-body leading-relaxed text-foreground">{children}</p>,

  ul: ({ children, className }) => (
    <ul className={cn('ml-5 list-disc space-y-1 text-body leading-relaxed text-foreground', className)}>
      {children}
    </ul>
  ),
  ol: ({ children, className }) => (
    <ol className={cn('ml-5 list-decimal space-y-1 text-body leading-relaxed text-foreground', className)}>
      {children}
    </ol>
  ),
  li: ({ children, className }) => <li className={cn('pl-0.5 marker:text-muted-foreground', className)}>{children}</li>,

  input: (props) => {
    if (props.type !== 'checkbox') return null
    return (
      <input
        type="checkbox"
        checked={!!props.checked}
        disabled
        readOnly
        // accent-color deliberately NOT the --accent token: this box is
        // `disabled readOnly`, a settled fact in rendered prose, and --accent
        // means "live" everywhere in this product.
        className="mr-1.5 h-3.5 w-3.5 -translate-y-px align-middle accent-muted-foreground"
      />
    )
  },

  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border py-1 pl-3 text-body text-muted-foreground">
      {children}
    </blockquote>
  ),

  hr: () => <hr className="my-4 border-border" />,

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline underline-offset-2 hover:text-accent-deep"
    >
      {children}
    </a>
  ),

  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,

  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-control border border-border">
      <table className="w-full border-collapse text-body">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-sunken/70">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold text-foreground">
      {children}
    </th>
  ),
  tr: ({ children }) => <tr className="border-b border-border/60 last:border-b-0">{children}</tr>,
  td: ({ children, style }) => (
    <td style={style} className="px-3 py-2 align-top text-foreground">
      {children}
    </td>
  ),
}
