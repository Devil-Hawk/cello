// POST /api/settings/learned { command, input }: What Cello learned. A door over learned.list, learned.search,
// learned.keep, learned.not_right, learned.off, learned.on, learned.edit and learned.delete (lib/commands/defs/people.ts).

import { learnedCommands } from '@/lib/commands/defs/people'
import { commandDoor } from '@/lib/network/door'

const door = commandDoor(learnedCommands)
export const dynamic = door.dynamic
export const POST = door.POST
