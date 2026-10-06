'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { hasRoleTargets } from '@/lib/targeting/roles'
import { today } from '@/lib/routes'
import {
  EMPTY_WELCOME_TARGETS,
  fitCount,
  onboardingFinish,
  rolesFind,
  searchUpdate,
  toTargeting,
  type WelcomeRole,
  type WelcomeTargets,
} from '@/lib/welcome/commands.stub'
import { ConnectScreen } from './_parts/connect'
import { DemoScreen } from './_parts/demo-tour'
import { nextScreen, type Screen } from './_parts/logic'
import { Progress } from './_parts/progress'
import { ResumeScreen } from './_parts/resume'
import { WantScreen } from './_parts/want'
import { YourRolesScreen } from './_parts/your-roles'

export interface WelcomeFlowProps {
  demo: boolean
  initialName: string
  hasResume: boolean
  start: Screen
}

// First run. A real account walks four screens; a demo sees one. The profile
// the flow makes is the resume, the name, the search and the Gmail grant, each
// stored where main keeps it.
export function WelcomeFlow({ demo, initialName, hasResume, start }: WelcomeFlowProps) {
  const router = useRouter()
  const supabase = createClient()
  const [screen, setScreen] = useState<Screen>(start)
  const [targets, setTargets] = useState<WelcomeTargets>(EMPTY_WELCOME_TARGETS)
  const [fit, setFit] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [roles, setRoles] = useState<WelcomeRole[] | null>(null)
  const [rolesLoading, setRolesLoading] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)

  // The live line: a count from the same code filter the Jobs list uses.
  useEffect(() => {
    if (screen !== 'want') return
    const t = toTargeting(targets)
    if (!hasRoleTargets(t)) {
      setFit(null)
      return
    }
    let live = true
    const id = setTimeout(() => {
      void fitCount(supabase, t).then((n) => live && setFit(n))
    }, 300)
    return () => {
      live = false
      clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, targets])

  async function saveWants() {
    setSaving(true)
    setSaveError(null)
    const { ok } = await searchUpdate(targets)
    setSaving(false)
    if (!ok) {
      setSaveError('Could not save what you want. Try again.')
      return
    }
    setScreen(nextScreen('want'))
  }

  useEffect(() => {
    if (screen !== 'roles') return
    let live = true
    setRolesLoading(true)
    void rolesFind(supabase, toTargeting(targets)).then((r) => {
      if (!live) return
      setRoles(r)
      setRolesLoading(false)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen])

  async function finish() {
    setFinishing(true)
    setFinishError(null)
    const { ok } = await onboardingFinish(supabase)
    // A demo's profile may refuse the write; its seeded workspace opens regardless.
    if (!ok && !demo) {
      setFinishError('Could not finish. Try again.')
      setFinishing(false)
      return
    }
    router.push(today.href)
  }

  return (
    <div className="mx-auto max-w-[720px] pb-16">
      <div className="mb-8 flex items-center justify-between gap-4">{!demo && <Progress screen={screen} />}</div>
      <div className="r-sheet-lead">
        {demo ? (
          <DemoScreen onFinish={finish} finishing={finishing} />
        ) : (
          <>
            {screen === 'resume' && (
              <ResumeScreen initialName={initialName} hasResume={hasResume} onDone={() => setScreen(nextScreen('resume'))} />
            )}
            {screen === 'want' && (
              <WantScreen value={targets} onChange={setTargets} fit={fit} saving={saving} error={saveError} onDone={saveWants} />
            )}
            {screen === 'connect' && <ConnectScreen onDone={() => setScreen(nextScreen('connect'))} />}
            {screen === 'roles' && (
              <YourRolesScreen
                roles={roles}
                loading={rolesLoading}
                finishing={finishing}
                error={finishError}
                onBack={() => setScreen('want')}
                onFinish={finish}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
