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
      // Only a call that never left may reopen the card. One that was sent and got no answer may have run: it stays confirmed.
      if (!result.ok && !result.unsure) throw new ApplyRefusal(result.reason, result.fix)
      let answer = `Asked "${tool}" on ${server}. No answer came back, so the call may or may not have gone through. Check on the server before you try again.`
      if (result.ok) {
        const head = result.isError ? `"${tool}" on ${server} answered with an error:` : `Ran "${tool}" on ${server}. It answered:`
        const quoted = result.text.slice(0, SHOWN).replace(/`/g, "'")
        answer = `${head}\n\n\`\`\`text\n${quoted}\n\`\`\``
      }
      // A failure to store the turn never throws: the call may have run, and a reopened proposal would run it twice.
      const { data } = await db
        .from('chat_turns')
        .insert({ user_id: userId, chat_id: input.chatId, kind: 'cello', origin: 'code', parts: [], links: [], prov: { step: 'mcp', proposal_id: proposalId ?? null }, answer })
        .select('id')
        .single()
      if (data) await db.from('chats').update({ last_turn_at: new Date().toISOString() }).eq('id', input.chatId).eq('user_id', userId)
    },
  }
}
