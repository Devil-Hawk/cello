import { defineContentScript } from 'wxt/utils/define-content-script'
import { ATS_MATCHES } from '../fill/hosts'
import { boot } from '../fill/page'

// The in-page Fill button and the send tab's runner, on the three hosted-form hosts only.
export default defineContentScript({
  matches: ATS_MATCHES,
  runAt: 'document_idle',
  main() {
    void boot()
  },
})
