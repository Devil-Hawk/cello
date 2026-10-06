// Commands for this lane. The lane that owns this file registers its commands here
// with defineCommand once the registry is on main; lib/commands/index.ts imports the list.

import type { AnyCommand } from '../define'

export const pipelineCommands: AnyCommand[] = []
