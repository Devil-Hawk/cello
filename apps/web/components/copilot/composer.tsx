'use client'

// Composer: agent chips (which harness agents' tools are callable this turn),
// model selector (falls back to the account's Settings -> Model preference),
// thinking-mode toggle (auto vs. review-before-each-tool-call), the bypass-
// permissions toggle (with its boundary spelled out while it's on — see the
// banner below), and the send/stop control.

import { useState } from 'react'
import { ShieldAlert, Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AnimatePresence, motion, transitionFast } from '@/components/ui/motion'
import { cn } from '@/lib/utils'
import { AGENT_CATALOG_UI, type StepAgentType } from '@/lib/harness/copilot-tool-catalog'
import { MODELS } from '@/lib/models'

/** Sent-body sentinel meaning "no explicit model — use the account default". */
export const DEFAULT_MODEL_SENTINEL = 'default'

interface ComposerProps {
  enabledAgents: StepAgentType[]
  onAgentsChange: (ids: StepAgentType[]) => void
  model: string
  onModelChange: (model: string) => void
  defaultModelLabel: string
  thinkingMode: 'auto' | 'review'
  onThinkingModeChange: (mode: 'auto' | 'review') => void
  bypassMode: boolean
  onBypassModeChange: (on: boolean) => void
  onSend: (text: string) => void
  onStop: () => void
  streaming: boolean
}

export function Composer({
  enabledAgents,
  onAgentsChange,
  model,
  onModelChange,
  defaultModelLabel,
  thinkingMode,
  onThinkingModeChange,
  bypassMode,
  onBypassModeChange,
  onSend,
  onStop,
  streaming,
}: ComposerProps) {
  const [input, setInput] = useState('')

  function toggleAgent(id: StepAgentType) {
    if (enabledAgents.includes(id)) onAgentsChange(enabledAgents.filter((a) => a !== id))
    else onAgentsChange([...enabledAgents, id])
  }

  function submit() {
    const trimmed = input.trim()
    if (!trimmed || streaming) return
    onSend(trimmed)
    setInput('')
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="space-y-2.5 border-t pt-3">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide sm:flex-wrap sm:overflow-visible">
          {AGENT_CATALOG_UI.map((agent) => {
            const active = enabledAgents.includes(agent.id)
            return (
              <Tooltip key={agent.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleAgent(agent.id)}
                    className={cn(
                      'shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                      // Enabled-but-idle is the resting state for every agent
                      // chip (all nine start on) — a pressed/recessed key from
                      // the surface ladder, not the live accent, so "available"
                      // stops competing with anything actually running.
                      //
                      // On/off carries THREE cues, not just tint: border,
                      // surface step, and weight. With accent gone, tint alone
                      // left the two states nearly indistinguishable on the
                      // control that decides which agents run — and colour was
                      // the only differentiator, which a low-vision user cannot
                      // rely on.
                      active
                        ? 'border-foreground/25 bg-sunken font-semibold text-foreground'
                        : 'border-border bg-card font-medium text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {agent.label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[220px] font-normal">
                  {agent.description}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={model} onValueChange={onModelChange}>
            <SelectTrigger className="h-8 w-auto min-w-[170px] gap-1.5 text-caption">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL_SENTINEL}>Default — {defaultModelLabel}</SelectItem>
              {MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Segmented
                  aria-label="Thinking mode"
                  value={thinkingMode}
                  onValueChange={onThinkingModeChange}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'review', label: 'Review' },
                  ]}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[240px] font-normal">
              Auto runs every tool call immediately. Review pauses before each tool call so you can approve
              it or redirect the plan first.
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={bypassMode}
                onClick={() => onBypassModeChange(!bypassMode)}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-caption font-medium transition-colors',
                  // A permission-loosening control needs weight even at rest —
                  // unlike the model/thinking-mode pickers beside it, this one
                  // stays visibly flagged (the `destructive` token, not a raw
                  // amber/rose utility) whether it's on or off, just heavier
                  // once it actually is on.
                  bypassMode
                    ? 'border-destructive/50 bg-destructive/10 text-destructive'
                    : 'border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/10'
                )}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Bypass permissions
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] font-normal">
              Skips per-step approval for read/research/scoring/drafting/tailoring tool calls in this
              conversation. Submitting an application or sending outreach to a real person always still stops
              for your explicit confirmation, on or off.
            </TooltipContent>
          </Tooltip>
        </div>

        <AnimatePresence initial={false}>
          {bypassMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={transitionFast}
              className="overflow-hidden"
            >
              <div className="flex items-start gap-2 rounded-control border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] leading-relaxed text-destructive">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>
                  <span className="font-medium">Bypass permissions is on</span> for this conversation — research,
                  matching, scoring, drafting, and tailoring tool calls run without asking first. Submitting a job
                  application or sending outreach to a real person still always stops and asks for your explicit
                  confirmation.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Cello Copilot…"
            className="max-h-40 min-h-[52px] flex-1 resize-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            disabled={streaming}
          />
          <Button
            type="button"
            onClick={streaming ? onStop : submit}
            disabled={!streaming && !input.trim()}
            size="icon"
            variant={streaming ? 'outline' : 'default'}
            className="relative h-[52px] w-[52px] shrink-0 overflow-hidden"
            aria-label={streaming ? 'Stop' : 'Send'}
          >
            <AnimatePresence initial={false} mode="wait">
              {streaming ? (
                <motion.span
                  key="stop"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={transitionFast}
                  className="absolute inset-0 flex items-center justify-center"
                >
                  <Square className="h-4 w-4" />
                </motion.span>
              ) : (
                <motion.span
                  key="send"
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={transitionFast}
                  className="absolute inset-0 flex items-center justify-center"
                >
                  <Send className="h-4 w-4" />
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
        </div>
        <p className="text-center text-caption text-muted-foreground">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </TooltipProvider>
  )
}
