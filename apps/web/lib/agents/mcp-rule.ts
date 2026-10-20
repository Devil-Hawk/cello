// The rule for a person's own MCP tools. Pure, no imports: Settings, Chat and the Confirm call all read it.
// A tool runs freely only when its server says it only reads AND no input names who or where it goes.
// Anything else asks the person first; a tool they marked Never (or any tool for a demo) is left out.

export type McpTier = 'read' | 'confirm' | 'never'

/** An input property that names who or where something goes. */
export const RECIPIENT_KEY = /^(to|cc|bcc|recipients?|emails?|phone|number|channel|chat_id|user_?ids?|address|webhook|url)$/i

export interface McpToolFacts {
  name: string
  readOnlyHint?: boolean | null
  inputSchema?: unknown
}

const MAX_DEPTH = 4

/** Every property name in a JSON schema that matches RECIPIENT_KEY, walking `properties` and `items` up to depth 4. */
export function recipientKeys(inputSchema: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') return
    const { properties, items } = node as { properties?: unknown; items?: unknown }
    if (properties && typeof properties === 'object') {
      for (const [key, sub] of Object.entries(properties)) {
        if (RECIPIENT_KEY.test(key)) out.push(key)
        walk(sub, depth + 1)
      }
    }
    for (const item of Array.isArray(items) ? items : [items]) walk(item, depth + 1)
  }
  walk(inputSchema, 1)
  return out
}

/** never: a demo, or a tool the person marked Never. read: readOnlyHint === true and no recipient key. Otherwise confirm. */
export function classifyMcpTool(tool: McpToolFacts, opts: { never: readonly string[]; isDemo: boolean }): McpTier {
  if (opts.isDemo || opts.never.includes(tool.name)) return 'never'
  return tool.readOnlyHint === true && recipientKeys(tool.inputSchema).length === 0 ? 'read' : 'confirm'
}
