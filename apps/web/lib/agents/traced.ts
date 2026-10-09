// One trace per request or scheduled occurrence. withTrace opens the root observation the
// agent's callback handler joins; its buffer's id is the id every score is attached to.

import { randomUUID } from 'node:crypto'
import { currentTraceContext, withTrace } from '@/lib/trace/spans'
import type { AdminClient } from '@/lib/harness/types'

export function traced<T>(admin: AdminClient, userId: string, spec: { name: string; sessionId?: string | null }, fn: (traceId: string) => Promise<T>): Promise<T> {
  return withTrace(admin, userId, { name: spec.name, ...(spec.sessionId ? { sessionId: spec.sessionId } : {}) }, () => fn(currentTraceContext()?.buffer.traceId ?? randomUUID()))
}
