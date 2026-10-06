import { browser } from 'wxt/browser'

// A send and a relay job never run together. One lock in session storage, with an
// age limit so a worker that died holding it cannot block everything forever.

export type Holder = 'send' | 'relay'
const KEY = 'run_lock'
const MAX_AGE_MS = 10 * 60_000

interface Lock {
  holder: Holder
  at: number
}

export async function acquireLock(holder: Holder): Promise<boolean> {
  const r = (await browser.storage.session.get(KEY)) as { [KEY]?: Lock }
  const held = r[KEY]
  if (held && Date.now() - held.at < MAX_AGE_MS) return false
  await browser.storage.session.set({ [KEY]: { holder, at: Date.now() } satisfies Lock })
  return true
}

export async function releaseLock(holder: Holder): Promise<void> {
  const r = (await browser.storage.session.get(KEY)) as { [KEY]?: Lock }
  if (r[KEY]?.holder === holder) await browser.storage.session.remove(KEY)
}

export async function lockHolder(): Promise<Holder | null> {
  const r = (await browser.storage.session.get(KEY)) as { [KEY]?: Lock }
  const held = r[KEY]
  return held && Date.now() - held.at < MAX_AGE_MS ? held.holder : null
}
