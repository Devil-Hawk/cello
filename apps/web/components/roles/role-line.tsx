'use client'

import type { Dispatch } from 'react'
import { ChangeType, type ChangeTypeProps } from './change-type'
import { chanceWord, metaLine } from './logic'
import { ReadMark } from './read-mark'
import type { ReactionAction, ReactionState } from './reactions'
import { RoleRow } from './role-row'
import type { TypeChange } from './type-change'
import type { RoleItem } from './types'
import { useRoleReactions } from './use-role-reactions'

/** What a row needs to offer Change type: the choices, the change it holds and how to make or take one back. */
export type TypeControls = Pick<ChangeTypeProps, 'options' | 'now' | 'onChange' | 'onUndo' | 'onReset'> & { changes: Readonly<Record<string, TypeChange>> }

export interface RoleLineProps {
  item: RoleItem
  state: ReactionState
  dispatch: Dispatch<ReactionAction>
  /** The page's clock, so Undo closes on its own. */
  now: number
  pickKind?: 'top' | 'explore'
  /** One sentence under the facts: a pick's explanation, or Cello's read. */
  sentence?: string | null
  /** Change type under the row; absent where it is not offered. */
  types?: TypeControls
}

// One role on Roles: the shared row (logo, title and company at one weight, the
// facts), then Interested and Not for me as 44px keys. The reactions are held by
// the page above the rows, so an Undo outlives a regroup.
export function RoleLine({ item, state, dispatch, now, pickKind, sentence, types }: RoleLineProps) {
  const { keys, panel } = useRoleReactions({ id: item.id, reaction: item.reaction?.reaction ?? null, state, dispatch, now, pickKind })
  const chance = chanceWord(item.chance)
  const says = sentence ?? item.read
  return (
    <div>
      <RoleRow
        id={item.id}
        title={item.title}
        company={item.company}
        companyId={item.companyId}
        domain={item.domain}
        logoUrl={item.logoUrl}
        state={item.closed ? 'flat' : 'default'}
        meta={
          <>
            {metaLine(item, now) || null}
            {item.type?.origin === 'model' && <ReadMark className="ml-2" />}
            {chance && <span className="ml-2 text-r-ink-2">{chance}</span>}
            {item.closed && <span className="ml-2 text-r-ink-2">Closed</span>}
            {says && <span className="mt-1 block">{says}</span>}
          </>
        }
        actions={keys}
      />
      {panel}
      {types && <ChangeType item={item} options={types.options} change={types.changes[item.id]} now={types.now} onChange={types.onChange} onUndo={types.onUndo} onReset={types.onReset} />}
    </div>
  )
}
