// Wait for the page to show something, without polling: the check runs once now,
// once per burst of DOM changes, and once when the time is up.

export function watchPage<T>(check: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false
    let scheduled = false
    const finish = (v: T | null): void => {
      if (done) return
      done = true
      observer.disconnect()
      clearTimeout(timer)
      resolve(v)
    }
    const run = (): void => {
      scheduled = false
      if (done) return
      const v = check()
      if (v !== null) finish(v)
    }
    const observer = new MutationObserver(() => {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(run)
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true })
    const timer = setTimeout(() => finish(check()), timeoutMs)
    run()
  })
}
