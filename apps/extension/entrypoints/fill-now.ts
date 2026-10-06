import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script'
import { manualFill } from '../fill/manual'

// Injected by the popup's Fill button into the tab the person is looking at (activeTab).
// This is how a page outside the three hosted-form hosts, such as an employer's own
// portal, is filled: only on the person's click.
export default defineUnlistedScript(() => {
  void manualFill()
})
