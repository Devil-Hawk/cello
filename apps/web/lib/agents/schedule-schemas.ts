// The request shapes for the Scheduled tasks API. Kept out of the route files, which may only
// export request handlers.

import { z } from 'zod'
import { EVERY, WEEKDAYS } from './schedules'

export const ScheduleSchema = z.object({
  every: z.enum(EVERY),
  at: z.string().max(5).optional(),
  weekday: z.enum(WEEKDAYS).optional(),
  hours: z.number().int().min(1).max(12).optional(),
  timezone: z.string().min(1).max(64),
})

export const RulesSchema = z.object({ allow_send_email: z.boolean().optional(), allow_submit: z.boolean().optional() })

export const CreateTaskBody = z.object({
  name: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(2000),
  schedule: ScheduleSchema,
  autonomy: z.enum(['ask', 'draft', 'act']).default('ask'),
  rules: RulesSchema.optional(),
})

export const PatchTaskBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    instruction: z.string().trim().min(1).max(2000).optional(),
    schedule: ScheduleSchema.optional(),
    autonomy: z.enum(['ask', 'draft', 'act']).optional(),
    rules: RulesSchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' })
