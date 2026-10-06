import { defineContentScript } from 'wxt/utils/define-content-script'
import { ATS_MATCHES } from '../fill/hosts'

// Runs in the page's own world, before its scripts. form.submit() and requestSubmit()
// raise no submit event, so the capture-phase listener cannot stop them: while Cello
// holds submits (the attribute below), these two do nothing.
export default defineContentScript({
  matches: ATS_MATCHES,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const HOLD = 'data-cello-hold'
    const held = (): boolean => document.documentElement.hasAttribute(HOLD)
    const proto = HTMLFormElement.prototype
    const submit = proto.submit
    const requestSubmit = proto.requestSubmit
    proto.submit = function (this: HTMLFormElement) {
      if (held()) return
      return submit.call(this)
    }
    proto.requestSubmit = function (this: HTMLFormElement, ...args: Parameters<HTMLFormElement['requestSubmit']>) {
      if (held()) return
      return requestSubmit.apply(this, args)
    }
  },
})
