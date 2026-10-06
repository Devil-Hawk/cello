// The owned-tables list: every public table that holds a person's rows by
// user_id, as the union of one file per lane. owned.test.ts parses the
// migrations and fails when a user_id table is missing from it, so demo wipe
// and account deletion cannot silently skip a new table.

import { owned as registryModels } from './registry-models'
import { owned as clockRelevance } from './clock-relevance'
import { owned as shellPages } from './shell-pages'
import { owned as chat } from './chat'
import { owned as integrate } from './integrate'
import { owned as pipeline } from './pipeline'
import { owned as learningWriter } from './learning-writer'
import { owned as network } from './network'
import { owned as extensionModels } from './extension-models'
import { owned as resume } from './resume'
import { owned as companies } from './companies'
import type { OwnedTable } from './types'

export type { OwnedTable }

export const OWNED_TABLES: readonly OwnedTable[] = [
  ...registryModels,
  ...clockRelevance,
  ...shellPages,
  ...chat,
  ...integrate,
  ...pipeline,
  ...learningWriter,
  ...network,
  ...extensionModels,
  ...resume,
  ...companies,
]

/** The tables the expired-demo sweep deletes from, in list order. */
export function demoWipeTables(): string[] {
  return OWNED_TABLES.filter((t) => t.demoWipe).map((t) => t.table)
}
