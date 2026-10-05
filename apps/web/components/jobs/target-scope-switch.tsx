'use client'

import { Segmented } from '@/components/ui/segmented'

export type TargetScope = 'matching' | 'all'

export interface TargetScopeSwitchProps {
  scope: TargetScope
  matchingCount: number
  allCount: number
  onScopeChange: (scope: TargetScope) => void
  className?: string
}

/**
 * "Matching your targets (N)" / "All roles (M)". Rendered only when the person
 * has role targets (see hasRoleTargets); the counts follow the roles in view.
 */
export function TargetScopeSwitch({ scope, matchingCount, allCount, onScopeChange, className }: TargetScopeSwitchProps) {
  return (
    <Segmented<TargetScope>
      aria-label="Which roles to show"
      className={className}
      value={scope}
      onValueChange={onScopeChange}
      options={[
        { value: 'matching', label: `Matching your targets (${matchingCount})` },
        { value: 'all', label: `All roles (${allCount})` },
      ]}
    />
  )
}
