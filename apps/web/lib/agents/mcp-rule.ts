// The rule for a person's own MCP tools. Pure, no imports: Settings, Chat and the Confirm call all read it.
// A tool runs freely only when its server says it only reads AND no input names who or where it goes.
// Anything else asks the person first; a tool they marked Never (or any tool for a demo) is left out.

export type McpTier = 'read' | 'confirm' | 'never'

const tokens = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** An input property that names who or where something goes: recipient_email, emailAddress, to_email, phone_number, mailto, chat_id... */
export function isRecipientKey(key: string): boolean {
  const lower = key.toLowerCase()
  if (/recipient|receiver|rcpt|mail|phone|mobile|sms|address|webhook|channel|contact|destination/.test(lower)) return true
  const words = tokens(key)
  return words.some((t) => ['to', 'cc', 'bcc', 'tel', 'url', 'uri', 'number', 'recip'].includes(t)) || /(^|_)(chat_id|user_ids?)(_|$)/.test(words.join('_'))
}

/** A tool whose name says it sends, posts, shares or writes is never a free read, whatever its server claims. */
export function sendsByName(name: string): boolean {
  return /send|mail|message|submit|publish|reply|notify|invite|share|write/i.test(name) || tokens(name).includes('post')
}

export interface McpToolFacts {
  name: string
  readOnlyHint?: boolean | null
  inputSchema?: unknown
}

const MAX_DEPTH = 8

type Node = Record<string, unknown>
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Every property name in a JSON schema that isRecipientKey, and whether the schema hides what the tool takes: an open object
 * (no declared properties, extras allowed; the adapter adds an empty `properties` to one), a $ref that cannot be resolved, or nesting past the depth limit. $ref is followed
 * through $defs and definitions; each ref is read once, so a cycle ends.
 */
export function scanInput(inputSchema: unknown): { keys: string[]; opaque: boolean } {
  const keys: string[] = []
  const seen = new Set<string>()
  let opaque = false
  const resolve = (ref: string): unknown => {
    if (!ref.startsWith('#/')) return undefined
    let at: unknown = inputSchema
    for (const part of ref.slice(2).split('/')) at = isNode(at) ? at[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
    return at
  }
  const walk = (node: unknown, depth: number) => {
    if (node === undefined || node === null || typeof node === 'boolean') return
    if (depth > MAX_DEPTH || !isNode(node)) {
      opaque = true
      return
    }
    if (typeof node.$ref === 'string') {
      if (seen.has(node.$ref)) return
      seen.add(node.$ref)
      const target = resolve(node.$ref)
      if (target === undefined) opaque = true
      else walk(target, depth + 1)
    }
    const type = node.type
    const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'))
    if (isObject && !(isNode(node.properties) && Object.keys(node.properties).length) && node.additionalProperties !== false) opaque = true
    for (const group of [node.properties, node.patternProperties]) {
      if (!isNode(group)) continue
      for (const [key, sub] of Object.entries(group)) {
        if (isRecipientKey(key)) keys.push(key)
        walk(sub, depth + 1)
      }
    }
    for (const word of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
      if (Array.isArray(node[word])) for (const sub of node[word]) walk(sub, depth + 1)
    }
    for (const word of ['items', 'additionalProperties', 'if', 'then', 'else', 'not']) {
      const sub = node[word]
      for (const one of Array.isArray(sub) ? sub : [sub]) walk(one, depth + 1)
    }
  }
  walk(inputSchema, 1)
  return { keys, opaque }
}

export const recipientKeys = (inputSchema: unknown): string[] => scanInput(inputSchema).keys

/** never: a demo, or a tool the person marked Never. read: readOnlyHint === true, nothing in its input names who or where, an input that is fully spelled out, no sending word in its name. Otherwise confirm. */
export function classifyMcpTool(tool: McpToolFacts, opts: { never: readonly string[]; isDemo: boolean }): McpTier {
  if (opts.isDemo || opts.never.includes(tool.name)) return 'never'
  if (tool.readOnlyHint !== true || sendsByName(tool.name)) return 'confirm'
  const { keys, opaque } = scanInput(tool.inputSchema)
  return keys.length === 0 && !opaque ? 'read' : 'confirm'
}
