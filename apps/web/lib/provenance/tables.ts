import { tables as registryModels } from './tables/registry-models'
import { tables as clockRelevance } from './tables/clock-relevance'
import { tables as shellPages } from './tables/shell-pages'
import { tables as chat } from './tables/chat'
import { tables as pipeline } from './tables/pipeline'
import { tables as learningWriter } from './tables/learning-writer'
import { tables as network } from './tables/network'
import { tables as extensionModels } from './tables/extension-models'
import { tables as resume } from './tables/resume'
import { tables as companies } from './tables/companies'
import type { ProvenanceTable } from './tables/types'

export type { ProvenanceTable }

// Every table that holds a person's rows by user_id, and how it says where its values
// come from. provenance.test.ts reads supabase/migrations and fails on a user_id table
// that is not listed here, or listed as `origin` without the column. One file per lane
// under ./tables; each lane edits only its own.
export const PROVENANCE_TABLES: readonly ProvenanceTable[] = [
  ...registryModels,
  ...clockRelevance,
  ...shellPages,
  ...chat,
  ...pipeline,
  ...learningWriter,
  ...network,
  ...extensionModels,
  ...resume,
  ...companies,
]
