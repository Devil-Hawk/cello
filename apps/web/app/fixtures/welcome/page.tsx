'use client'

import { useState } from 'react'
import { ConnectScreen } from '@/app/(app)/welcome/_parts/connect'
import { DemoScreen } from '@/app/(app)/welcome/_parts/demo-tour'
import { Progress } from '@/app/(app)/welcome/_parts/progress'
import { ResumeScreen } from '@/app/(app)/welcome/_parts/resume'
import { WantScreen } from '@/app/(app)/welcome/_parts/want'
import { YourRolesScreen } from '@/app/(app)/welcome/_parts/your-roles'
import type { Screen } from '@/app/(app)/welcome/_parts/logic'
import type { WelcomeRole, WelcomeTargets } from '@/lib/welcome/commands.stub'
import { COMPANIES } from '../_data'

// Every Welcome screen on made-up data. ?screen=resume | want | connect | roles | roles-empty | demo
const ROLES: WelcomeRole[] = COMPANIES.slice(0, 4).map((c, i) => ({
  id: `w${i}`,
  title: ['AI Engineer', 'Forward Deployed Engineer', 'Data Engineer', 'Platform Engineer'][i],
  company: c.name,
  companyId: `c${i}`,
  domain: null,
  logoUrl: null,
  location: 'Remote, US',
  postedAt: null,
}))

const TARGETS: WelcomeTargets = {
  roleTypeIds: ['ai-engineer'],
  levelIds: ['senior'],
  remoteOnly: true,
  countries: [],
  excludedCompanies: [],
  excludedWords: [],
}

export default function WelcomeFixture({ searchParams }: { searchParams: { screen?: string } }) {
  const which = searchParams.screen ?? 'resume'
  const [targets, setTargets] = useState(TARGETS)
  const screen: Screen = which.startsWith('roles') ? 'roles' : which === 'demo' ? 'resume' : (which as Screen)
  return (
    <div className="mx-auto max-w-[720px] px-4 py-10">
      {which !== 'demo' && (
        <div className="mb-8">
          <Progress screen={screen} />
        </div>
      )}
      <div className="r-sheet-lead">
        {which === 'resume' && <ResumeScreen initialName="Sam Rivera" hasResume={false} onDone={() => undefined} />}
        {which === 'want' && (
          <WantScreen value={targets} onChange={setTargets} fit={41} saving={false} error={null} onDone={() => undefined} />
        )}
        {which === 'connect' && <ConnectScreen onDone={() => undefined} />}
        {which === 'roles' && (
          <YourRolesScreen roles={ROLES} loading={false} finishing={false} error={null} onBack={() => undefined} onFinish={() => undefined} />
        )}
        {which === 'roles-empty' && (
          <YourRolesScreen roles={[]} loading={false} finishing={false} error={null} onBack={() => undefined} onFinish={() => undefined} />
        )}
        {which === 'demo' && <DemoScreen onFinish={() => undefined} finishing={false} />}
      </div>
    </div>
  )
}
