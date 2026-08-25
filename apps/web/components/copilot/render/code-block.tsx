'use client'

// Fenced code rendering: a small language/copy header over a highlighted
// body. Syntax colour comes from react-syntax-highlighter's "Light" build
// (see markdown.tsx's doc comment for why — the short version: it lets us
// register only the languages we actually see instead of shipping Prism's
// full ~300-grammar catalogue).

import { memo, useState } from 'react'
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

// Deliberately small: this is every language we've registered, nothing
// more. An unregistered language name (or none at all) still renders —
// react-syntax-highlighter catches the lookup failure internally and falls
// back to plain, unhighlighted text (see its highlight.js: the refractor
// path wraps `astGenerator.highlight` in try/catch) — so "unknown language"
// degrades to readable code, never a crash or blank block.
PrismLight.registerLanguage('typescript', typescript)
PrismLight.registerLanguage('tsx', tsx)
PrismLight.registerLanguage('javascript', javascript)
PrismLight.registerLanguage('jsx', jsx)
PrismLight.registerLanguage('json', json)
PrismLight.registerLanguage('bash', bash)
PrismLight.registerLanguage('python', python)
PrismLight.registerLanguage('css', css)
PrismLight.registerLanguage('yaml', yaml)
PrismLight.registerLanguage('markdown', markdown)
PrismLight.registerLanguage('sql', sql)

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  text: '',
  plaintext: '',
  plain: '',
}

function normalizeLanguage(raw: string | undefined): string {
  if (!raw) return ''
  const lower = raw.trim().toLowerCase()
  return LANGUAGE_ALIASES[lower] ?? lower
}

// Token colours. Two are fixed, code-only hues (not reused as app-wide
// semantic colour — see tailwind.config.ts's `pipeline` comment for the
// precedent of "fixed, desaturated instrument tones" this follows); the
// rest reuse existing design tokens so code blocks stay in register with
// the rest of the product and invert correctly for dark mode with zero
// extra work.
const CODE_STRING = '#5E7FA0' // fixed slate blue — string/attr literals
const CODE_FUNC = '#7A6BA6' // fixed muted violet — function/class names

const codeStyle: Record<string, React.CSSProperties> = {
  'pre[class*="language-"]': { background: 'transparent', margin: 0 },
  'code[class*="language-"]': {
    color: 'hsl(var(--foreground))',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  comment: { color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  prolog: { color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  doctype: { color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  cdata: { color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  punctuation: { color: 'hsl(var(--muted-foreground))' },
  operator: { color: 'hsl(var(--muted-foreground))' },
  keyword: { color: 'hsl(var(--accent-deep))', fontWeight: 500 },
  tag: { color: 'hsl(var(--accent-deep))', fontWeight: 500 },
  selector: { color: 'hsl(var(--accent-deep))', fontWeight: 500 },
  important: { color: 'hsl(var(--accent-deep))', fontWeight: 500 },
  atrule: { color: 'hsl(var(--accent-deep))', fontWeight: 500 },
  builtin: { color: 'hsl(var(--accent-deep))' },
  boolean: { color: 'hsl(var(--accent-deep))' },
  number: { color: 'hsl(var(--accent-deep))' },
  constant: { color: 'hsl(var(--accent-deep))' },
  symbol: { color: 'hsl(var(--accent-deep))' },
  string: { color: CODE_STRING },
  char: { color: CODE_STRING },
  'attr-value': { color: CODE_STRING },
  regex: { color: CODE_STRING },
  url: { color: CODE_STRING },
  variable: { color: CODE_STRING },
  inserted: { color: CODE_STRING },
  function: { color: CODE_FUNC },
  'class-name': { color: CODE_FUNC },
  property: { color: CODE_FUNC },
  'attr-name': { color: CODE_FUNC },
  deleted: { color: 'hsl(var(--destructive))' },
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-label uppercase tracking-wide text-muted-foreground',
        'transition-colors hover:bg-sunken hover:text-foreground'
      )}
      aria-label="Copy code"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

interface CodeBlockProps {
  language?: string
  code: string
}

/** Memoized on (language, code) — an unrelated re-render of the surrounding
 *  message (or even a sibling block) never re-runs Prism's tokenizer. */
export const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps) {
  const lang = normalizeLanguage(language)
  const label = lang || 'text'
  return (
    <div className="my-2 overflow-hidden rounded-control border border-border bg-sunken/60">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-label uppercase tracking-wide text-muted-foreground">{label}</span>
        <CopyButton text={code} />
      </div>
      <div className="overflow-x-auto">
        {lang ? (
          <PrismLight
            language={lang}
            style={codeStyle}
            PreTag="div"
            customStyle={{ margin: 0, padding: '0.75rem 1rem', background: 'transparent' }}
            codeTagProps={{ className: 'font-readout text-[0.8125rem] leading-relaxed' }}
          >
            {code}
          </PrismLight>
        ) : (
          <pre className="px-4 py-3">
            <code className="font-readout text-[0.8125rem] leading-relaxed text-foreground">{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
})
