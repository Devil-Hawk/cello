// The words of Landing (blueprint 4.1 and section 1). Kept apart from the
// layout so the copy scan and the test read one place. Nothing here claims a
// count, a user, an outcome or anything that has not shipped; later sentences
// of "what it does" arrive with their releases.

export const PROMISE = 'Roles that actually fit you, for people tired of applying into silence.'

export const WHAT_IT_DOES =
  "Cello reads employers' own job sites, keeps only roles inside what you want, and checks for new ones every 6 hours."

export const REFUSALS: Array<{ heading: string; sentence: string }> = [
  {
    heading: 'Nothing sent without your click',
    sentence:
      'Cello never sends an email to anyone but you without your click, and never submits an application unless you click the employer’s button or turned on Send for me.',
  },
  {
    heading: 'No invented facts',
    sentence: 'Cello never invents a fact about you. Every line it writes is checked against your resume and your notes.',
  },
  {
    heading: 'It says what it cannot do',
    sentence: 'Cello says what it cannot do instead of guessing: "cannot read this site", "not sure", "needs a model".',
  },
  {
    heading: 'No surprise spending',
    sentence: 'Cello never spends your money unless you added a key and a cap, and never above the cap.',
  },
  {
    heading: 'No getting past a login',
    sentence:
      'Cello never gets past a login or a human check for you, and never creates an account or reads a code from your email.',
  },
  {
    heading: 'Not from the cloud, not LinkedIn',
    sentence: 'Cello does not apply from the cloud and does not automate LinkedIn.',
  },
]

export const COST = 'Free and open source. Works with no AI model at all. Free models or your own key make it smarter.'

export const NEEDS_A_COMPUTER = 'Sending an application needs a computer.'

export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Does Cello apply for me?',
    a: 'Cello does not apply from the cloud. It prepares each application, and you send it from your computer: open the employer’s page, click Fill, check it, click their button. If you turn on Send for me, your own browser sends the ones your rule allows while your computer is on, up to your daily limit.',
  },
  {
    q: 'What about logins and human checks?',
    a: 'Cello does not create employer accounts or read your verification codes. When a site asks you to sign in or prove you are a person, that step is yours, and Cello tells you before you open the site.',
  },
  {
    q: 'What does it cost?',
    a: 'Cello is free and open source. It works with no AI model. Free models, a model on your computer or your own key make it smarter. There are no credits.',
  },
  {
    q: 'Where do the roles come from?',
    a: 'Cello reads employers’ own job sites, for employers you follow and other employers Cello has verified. It shows fewer roles than sites that copy millions of postings, on purpose.',
  },
  {
    q: 'Is there a phone app?',
    a: 'No phone app. The website works on your phone; sending an application needs a computer.',
  },
]

/** The repository, for "built in the open". */
export const REPO_URL = 'https://github.com/Devil-Hawk/cello'
