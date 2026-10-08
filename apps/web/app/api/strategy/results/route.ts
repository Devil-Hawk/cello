// POST /api/strategy/results { command, input }: What is working. A door over results.get, proposals.confirm and
// proposals.dismiss (lib/commands/defs/people.ts).

import { resultsCommands } from '@/lib/commands/defs/people'
import { sessionDoor } from '@/lib/commands/doors'
import { commandDoor } from '@/lib/network/door'

const door = commandDoor(resultsCommands, sessionDoor)
export const dynamic = door.dynamic
export const POST = door.POST
