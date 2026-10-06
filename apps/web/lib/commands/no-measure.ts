// The only commands that may say `measure: 'none'` (blueprint 5.1): plain record
// edits whose result is the person's own entry, and the owner commands whose
// output is the measures themselves. The registry test fails on any other none.

export const NO_MEASURE_COMMANDS: readonly string[] = [
  // notes, instructions, interview dates
  'applications.note',
  'applications.set_instruction',
  'applications.set_interview_date',
  'applications.add',
  'applications.import',
  'applications.export',
  'applications.correct_attempt',
  'instructions.create',
  'instructions.edit',
  'instructions.pause',
  'instructions.run_now',
  // people and what Cello remembers about them
  'people.edit',
  'people.import',
  'people.add',
  'people.delete',
  'people.mark_contacted',
  'people.forget',
  'people.edit_memory',
  // material and learnings
  'material.add',
  'material.edit',
  'material.remove',
  'material.set_use',
  'material.add_to_resume',
  'learned.keep',
  'learned.not_right',
  'learned.off',
  'learned.on',
  'learned.edit',
  'learned.delete',
  // documents, tools, chats, companies
  'documents.delete',
  'tools.list',
  'tools.add',
  'tools.tick',
  'tools.remove',
  'chat.earlier',
  'chat.archive',
  'chat.pin',
  'chat.rename',
  'companies.fix_names',
  'companies.remove',
]

/** Whole families: settings.*, accounts.* and owner.* are all record edits or
 *  the measures themselves. */
export const NO_MEASURE_PREFIXES: readonly string[] = ['settings.', 'accounts.', 'owner.']

export function allowsNoMeasure(id: string): boolean {
  return NO_MEASURE_COMMANDS.includes(id) || NO_MEASURE_PREFIXES.some((p) => id.startsWith(p))
}
