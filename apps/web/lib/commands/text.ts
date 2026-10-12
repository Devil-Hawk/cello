// How a command's output says what its strings are (blueprint 5.1, registry rules).
//
// Every string a command returns is one of two kinds, and the kind rides on the
// schema where a test can read it:
//   codeText       text Cello's own code made: ids, enums, counts, sentences.
//   untrustedText  text a third party wrote: a posting, an email, a name from a
//                  web page. Views that reach a model frame it as data.
// A bare z.string() in an output fails lib/commands/registry.test.ts.

import { z } from 'zod'

export type TextKind = 'code' | 'untrusted'

export function codeText(max: number) {
  return z.string().max(max).meta({ text: 'code' satisfies TextKind })
}

export function untrustedText(max: number) {
  return z.string().max(max).meta({ text: 'untrusted' satisfies TextKind })
}

/** Structured third-party data. Allowed only on a command no view lists, because
 *  a model reading it could not tell which parts are data. */
export function untrustedJson() {
  return z.unknown().meta({ text: 'untrusted' satisfies TextKind })
}
