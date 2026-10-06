'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Key } from '@/components/ui/key'
import { checkAll, checkAllLine } from './check-all'
import { checkChance } from './record/fit-call'

// The Roles menu: Check chances for all. The loop lives in check-all.ts; this holds the
// progress line, Stop, and the page refresh once it ends.
export function CheckAllMenu({ ids }: { ids: readonly string[] }) {
  const router = useRouter()
  const stopped = useRef(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [line, setLine] = useState<string | null>(null)

  async function run() {
    stopped.current = false
    setLine(null)
    setProgress(0)
    setRunning(true)
    const result = await checkAll(ids, checkChance, { stopped: () => stopped.current, onProgress: setProgress })
    setRunning(false)
    setLine(checkAllLine(result))
    router.refresh()
  }

  return (
    <details className="relative">
      <summary className="r-key r-key-raised min-h-11 min-w-11 cursor-pointer list-none font-r">Menu</summary>
      <div className="r-sheet-lead absolute right-0 top-full z-30 mt-2 w-[min(92vw,320px)] space-y-2 p-3">
        {running ? (
          <div className="flex flex-wrap items-center gap-3">
            <span role="status" className="r-body">
              Checking {progress} of {ids.length}.
            </span>
            <Key variant="raised" onClick={() => (stopped.current = true)}>
              Stop
            </Key>
          </div>
        ) : (
          ids.length > 0 && (
            <Key variant="raised" onClick={run}>
              Check chances for all
            </Key>
          )
        )}
        {!running && ids.length === 0 && !line && <p className="r-meta">Every role you keep has been checked.</p>}
        {line && (
          <p role="status" className="r-meta">
            {line}
          </p>
        )}
      </div>
    </details>
  )
}
