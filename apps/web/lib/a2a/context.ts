// The one place app/api/a2a/route.ts and lib/a2a/task-store.ts agree on how
// a Cello userId rides inside a ServerCallContext.
//
// WHY `state`, NOT `context.user.userName`
//   `@a2a-js/sdk`'s `User` interface exposes only `isAuthenticated` and
//   `userName` — no arbitrary field for "the id my own auth system uses."
//   `ServerCallContext.state` is exactly the escape hatch the SDK documents
//   for this ("equivalent to the state field on the Python A2A SDK's
//   ServerCallContext... carry custom data through the call pipeline").
//   `userName` is still set below (to the same id) purely so
//   `context.user.isAuthenticated`/`.userName` read sensibly for any SDK
//   internal that inspects them; nothing in this codebase READS userName.
//
// WHY A REAL `new ServerCallContext(...)`, NOT A BARE `{state:{}}` LITERAL
//   ServerCallContext's `tenant`/`user`/`state` are getters on the class
//   (see @a2a-js/sdk/server's d.ts) — a plain object literal has no
//   prototype chain to satisfy them. Per the A2A spike facts, this is
//   exactly the trap: construct the real class.

import { ServerCallContext } from '@a2a-js/sdk/server'
import type { User } from '@a2a-js/sdk/server'

export const STATE_USER_ID_KEY = 'cello:userId'

class CelloUser implements User {
  constructor(private readonly id: string) {}
  get isAuthenticated(): boolean {
    return true
  }
  get userName(): string {
    return this.id
  }
}

/** One ServerCallContext per validated request, carrying `userId` the only
 *  way the SDK lets custom data ride through to load()/save()/execute(). */
export function buildA2aServerCallContext(userId: string): ServerCallContext {
  return new ServerCallContext({
    user: new CelloUser(userId),
    requestedVersion: '0.3',
    state: new Map([[STATE_USER_ID_KEY, userId]]),
  })
}
