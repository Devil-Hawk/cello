// The apply target for a confirmed outside tool call: the call runs as the person, from their Confirm, and what the
// server answered is stored as one code turn. The outside text sits in a fenced text block, so it reads as quoted
// text and never as a link or an image.

import { callUserMcpTool } from '@/lib/agents/user-mcp'
import { ApplyRefusal, type ApplyTargets } from './proposals'

const SHOWN = 1500

export function mcpTargets(input: { chatId: string; isDemo: boolean }): ApplyTargets {
  return {
    mcp: async (db, userId, payload, proposalId) => {
      const { server, tool, args } = payload as { server: string; tool: string; args: Record<string, unknown> }
      const result = await callUserMcpTool({ admin: db, userId, isDemo: input.isDemo }, server, tool, args)
      if (!result.ok) throw new ApplyRefusal(result.reason, result.fix)
      const head = result.isError ? `"${tool}" on ${server} answered with an error:` : `Ran "${tool}" on ${server}. It answered:`
      const quoted = result.text.slice(0, SHOWN).replace(/`/g, "'")
      // A failure to store the answer never throws: the call has run, and a reopened proposal would run it twice.
      const { data } = await db
        .from('chat_turns')
        .insert({ user_id: userId, chat_id: input.chatId, kind: 'cello', origin: 'code', parts: [], links: [], prov: { step: 'mcp', proposal_id: proposalId ?? null }, answer: `${head}\n\n\`\`\`text\n${quoted}\n\`\`\`` })
        .select('id')
        .single()
      if (data) await db.from('chats').update({ last_turn_at: new Date().toISOString() }).eq('id', input.chatId).eq('user_id', userId)
    },
  }
}
