import type { StopCause } from '../lib/fill-contract'

/** What the page bar says when a send hands the application back, with the reason and the next step. */
export const CAUSE_LINES: Record<StopCause, string> = {
  sign_in: 'Cello stopped here: this page needs you to sign in. Finish this application yourself.',
  account: 'Cello stopped here: this page asks for a new account. Finish this application yourself.',
  site_check: 'Cello stopped here: the site is checking that you are a person. Finish this application yourself.',
  unknown_field: 'Cello stopped here: a required question has no saved answer. Finish this application yourself.',
  prefilled: 'Cello stopped here: the site filled in a field before Cello did. Finish this application yourself.',
  wrong_page: 'Cello stopped here: this is not the page for this application. Open the right one yourself.',
  upload: 'Cello stopped here: the resume upload needs you. Finish this application yourself.',
  form_changed: 'Cello stopped here: the form changed since Cello prepared it. Finish this application yourself.',
  no_submit: 'Cello stopped here: this page has no single Send button. Finish this application yourself.',
  form_error: 'Cello stopped here: the site showed an error after Send. Check your application on this page.',
  interrupted: 'Cello stopped here: it was interrupted before it could send. Finish this application yourself.',
}
