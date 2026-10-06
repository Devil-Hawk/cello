// POST /api/network { command, input }: the people.* and network.* commands (lib/commands/defs/people.ts) as the
// signed-in person. A door and nothing else; runCommand holds every check.

import { peopleCommands } from '@/lib/commands/defs/people'
import { commandDoor } from '@/lib/network/door'

const door = commandDoor(peopleCommands.filter((c) => c.id.startsWith('people.') || c.id.startsWith('network.')))
export const dynamic = door.dynamic
export const POST = door.POST
