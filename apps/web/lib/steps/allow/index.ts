// The per-lane allowlists of raw model calls, as one list. The source test reads
// this; each lane edits only its own file.

import { allow as clockRelevance } from './clock-relevance'
import { allow as chat } from './chat'
import { allow as learningWriter } from './learning-writer'
import { allow as extensionModels } from './extension-models'
import { allow as resume } from './resume'
import { allow as registryModels } from './registry-models'
import { allow as shellPages } from './shell-pages'
import { allow as pipeline } from './pipeline'
import { allow as network } from './network'
import { allow as companies } from './companies'
import type { AllowEntry } from './types'

export type { AllowEntry }

export const ALLOWLIST: readonly AllowEntry[] = [
  ...clockRelevance,
  ...chat,
  ...learningWriter,
  ...extensionModels,
  ...resume,
  ...registryModels,
  ...shellPages,
  ...pipeline,
  ...network,
  ...companies,
]
