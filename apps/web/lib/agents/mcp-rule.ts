// The rule for a person's own MCP tools. Pure, no imports: Settings, Chat and the Confirm call all read it.
// A tool runs freely only when its server says it only reads AND no input names who or where it goes.
// Anything else asks the person first; a tool they marked Never (or any tool for a demo) is left out.

export type McpTier = 'read' | 'confirm' | 'never'

const tokens = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** An input property that names who or where something goes: recipient_email, emailAddress, to_email, phone_number, mailto... */
export function isRecipientKey(key: string): boolean {
  const lower = key.toLowerCase()
  return /recipient|mail|phone|address|webhook|channel/.test(lower) || /^(number|chat_id|user_?ids?)$/.test(lower) || tokens(key).some((t) => ['to', 'cc', 'bcc', 'tel', 'url', 'uri'].includes(t))
}

/** A tool whose name says it sends, posts, submits or publishes is never a free read, whatever its server claims. */
export function sendsByName(name: string): boolean {
  return /send|mail|message|submit|publish|reply/i.test(name) || tokens(name).includes('post')
}

export interface McpToolFacts {
  name: string
  readOnlyHint?: boolean | null
  inputSchema?: unknown
}

const MAX_DEPTH = 4

/** Every property name in a JSON schema that isRecipientKey, walking `properties` and `items` up to depth 4. */
export function recipientKeys(inputSchema: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') return
    const { properties, items } = node as { properties?: unknown; items?: unknown }
    if (properties && typeof properties === 'object') {
      for (const [key, sub] of Object.entries(properties)) {
        if (isRecipientKey(key)) out.push(key)
        walk(sub, depth + 1)
      }
    }
    for (const item of Array.isArray(items) ? items : [items]) walk(item, depth + 1)
  }
  walk(inputSchema, 1)
  return out
}

/** never: a demo, or a tool the person marked Never. read: readOnlyHint === true, no recipient key, no sending word in its name. Otherwise confirm. */
export function classifyMcpTool(tool: McpToolFacts, opts: { never: readonly string[]; isDemo: boolean }): McpTier {
  if (opts.isDemo || opts.never.includes(tool.name)) return 'never'
  return tool.readOnlyHint === true && !sendsByName(tool.name) && recipientKeys(tool.inputSchema).length === 0 ? 'read' : 'confirm'
}
