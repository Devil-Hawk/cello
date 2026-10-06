// Every routine the clock can run, by command. A routine row with a command that is not here is
// left alone by the runner (roles.render is a switch with no handler: the sweeper dispatches it).
// Later packages add their handlers here and their rows by insert, never a second sweeper.

import type { RoutineHandler } from '../routines'
import { demoExpire, harnessDigest, harnessLearn, harnessResume } from './harness'
import { directorySeed } from './directory-seed'
import { directorySweep } from './directory-sweep'
import { inboxSync } from './inbox-sync'
import { clockMeter } from './meter'
import { ownerHealth } from './owner-health'
import { clockPrune } from './prune'
import { rolesCheck } from './roles-check'
import { postingsBackfill } from './postings-backfill'
import { rolesRetype } from './roles-retype'
import { storageAlert } from './storage-alert'
import { suggestionsRefresh } from './suggestions-refresh'

export const HANDLERS: Record<string, RoutineHandler> = {
  'roles.check': (ctx) => rolesCheck(ctx),
  'roles.retype': rolesRetype,
  'postings.backfill': postingsBackfill,
  'storage.alert': storageAlert,
  'directory.sweep': directorySweep,
  'directory.seed': directorySeed,
  'suggestions.refresh': suggestionsRefresh,
  'inbox.sync': inboxSync,
  'owner.health': ownerHealth,
  'clock.meter': clockMeter,
  'clock.prune': clockPrune,
  'harness.resume': harnessResume,
  'demo.expire': demoExpire,
  'harness.digest': harnessDigest,
  'harness.learn': harnessLearn,
}
