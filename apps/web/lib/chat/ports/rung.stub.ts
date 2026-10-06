// lane-stub: K14 pickRung. What the picker may offer this person: until the ladder is on main, Free models only.
// Deleted when K14 lands; chatLimits then comes from the ladder and the person's highest.

import { freeFallbackModels } from '@/lib/agents/model'
import type { ChoiceLimits } from '@/lib/models/choice'

export function chatLimits(): ChoiceLimits {
  return { ceiling: 'R3', available: ['R3'], route: () => freeFallbackModels()[0] ?? 'qwen/qwen3.8-27b:free', effort: 'low' }
}
