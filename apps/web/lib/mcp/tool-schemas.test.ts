// Pins TOOL_SCHEMAS (lib/mcp/tool-schemas.ts) exactly to COPILOT_TOOLS (the
// registry app/api/mcp/route.ts enumerates for MCP's tools/list). A tool
// added to the catalog and forgotten here would otherwise ship an MCP tool
// list one short — this is what fails instead. Set equality both directions:
// a name added to one list but not the other is caught either way (a stray
// schema entry for a retired tool is exactly as much drift as a missing one).

import { describe, expect, it } from 'vitest'
import { TOOL_SCHEMAS, TOOL_SCHEMA_NAMES, COPILOT_TOOL_NAMES } from './tool-schemas'
import { COPILOT_TOOLS, MCP_TOOL_PREFIX } from '../harness/copilot-tool-catalog'

describe('TOOL_SCHEMAS stays in lockstep with COPILOT_TOOLS', () => {
  it('finds tools to check (guards against an accidentally empty catalog)', () => {
    expect(COPILOT_TOOLS.length).toBeGreaterThan(10)
  })

  it('has exactly the 19 first-party tool names, no more, no fewer', () => {
    expect(new Set(TOOL_SCHEMA_NAMES)).toEqual(new Set(COPILOT_TOOL_NAMES))
  })

  it('never carries an mcp:<server>:<tool> passthrough name — those are excluded by construction', () => {
    for (const name of TOOL_SCHEMA_NAMES) {
      expect(name.startsWith(MCP_TOOL_PREFIX)).toBe(false)
    }
  })

  it('every schema is a plain object (a ZodRawShape), never a z.object() wrapper', () => {
    // registerTool's inputSchema wants the raw shape, not a wrapped schema —
    // a z.object() here would still "work" by duck-typing until the SDK
    // tried to read a field off it, so this pins the shape directly.
    for (const [name, shape] of Object.entries(TOOL_SCHEMAS)) {
      expect(typeof shape, `${name}'s schema`).toBe('object')
      expect(shape, `${name}'s schema`).not.toHaveProperty('_zod')
    }
  })
})
