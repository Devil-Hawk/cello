import { describe, expect, it } from 'vitest'
import { locationVerdict, prefsFromProfile, type LocationPrefs } from './location'

const US: LocationPrefs = { countries: ['US'], remoteOnly: false, remoteAllowed: true, cities: [] }
const REMOTE_ONLY: LocationPrefs = { countries: [], remoteOnly: true, remoteAllowed: true, cities: [] }
const AUSTIN_ONSITE: LocationPrefs = { countries: [], remoteOnly: false, remoteAllowed: false, cities: ['austin'] }
const NONE: LocationPrefs = { countries: [], remoteOnly: false, remoteAllowed: true, cities: [] }

describe('locationVerdict', () => {
  const table: { name: string; prefs: LocationPrefs; place: { location?: string | null; regions?: string[] }; kept: boolean }[] = [
    { name: 'US vs Remote - Europe', prefs: US, place: { location: 'Remote - Europe' }, kept: false },
    { name: 'US vs Remote, Worldwide', prefs: US, place: { location: 'Remote, Worldwide' }, kept: true },
    { name: 'US vs Remote', prefs: US, place: { location: 'Remote' }, kept: true },
    { name: 'US vs Berlin', prefs: US, place: { location: 'Berlin' }, kept: false },
    { name: 'US vs New York, NY', prefs: US, place: { location: 'New York, NY' }, kept: true },
    { name: 'US vs empty, not remote', prefs: US, place: { location: '' }, kept: false },
    { name: 'US vs null', prefs: US, place: { location: null }, kept: false },
    { name: 'remote only vs San Francisco', prefs: REMOTE_ONLY, place: { location: 'San Francisco' }, kept: false },
    { name: 'remote only vs Remote', prefs: REMOTE_ONLY, place: { location: 'Remote' }, kept: true },
    { name: "cities ['austin'], remote not allowed vs Remote", prefs: AUSTIN_ONSITE, place: { location: 'Remote' }, kept: false },
    { name: "cities ['austin'] vs Austin, TX", prefs: AUSTIN_ONSITE, place: { location: 'Austin, TX' }, kept: true },
    { name: "cities ['austin'] vs Dallas, TX", prefs: AUSTIN_ONSITE, place: { location: 'Dallas, TX' }, kept: false },
    { name: 'none vs anything', prefs: NONE, place: { location: 'Ulaanbaatar' }, kept: true },
    { name: 'none vs nothing at all', prefs: NONE, place: {}, kept: true },
    { name: 'US vs YC regions United States of America + Remote', prefs: US, place: { regions: ['United States of America', 'Remote'] }, kept: true },
    { name: 'US vs YC regions Europe + Remote', prefs: US, place: { regions: ['Europe', 'United Kingdom', 'Remote'] }, kept: false },
    { name: 'US vs YC offices, one in the US', prefs: US, place: { location: 'London, England, United Kingdom; San Francisco, CA, USA' }, kept: true },
    { name: 'US vs YC offices, none in the US', prefs: US, place: { location: 'London, England, United Kingdom; Berlin, Germany' }, kept: false },
    { name: 'US vs Remote (US or Canada)', prefs: US, place: { location: 'Remote (US or Canada)' }, kept: true },
    { name: 'US vs Remote - North America', prefs: US, place: { location: 'Remote - North America' }, kept: true },
    { name: 'US vs Remote - EMEA', prefs: US, place: { location: 'Remote - EMEA' }, kept: false },
    { name: 'US vs Remote - India', prefs: US, place: { location: 'Remote, India' }, kept: false },
    { name: 'DE vs Remote - Europe', prefs: { ...US, countries: ['DE'] }, place: { location: 'Remote - Europe' }, kept: true },
    { name: 'US vs a remote role with an unreadable limit', prefs: US, place: { location: 'Remote - Acme Dojo' }, kept: false },
    { name: 'US vs on-site role, partly remote YC region only', prefs: US, place: { location: 'Paris, France', regions: ['Partly Remote'] }, kept: false },
  ]
  for (const row of table) {
    it(`${row.name} -> ${row.kept ? 'kept' : 'dropped'}`, () => {
      const v = locationVerdict(row.place, row.prefs)
      expect(v.ok, v.why).toBe(row.kept)
    })
  }
})

describe('prefsFromProfile', () => {
  it('reads countries and remoteOnly from targeting, and the on-site and remote preferences', () => {
    expect(prefsFromProfile({ targeting: { countries: ['us'], remoteOnly: true } })).toEqual({
      countries: ['US'], remoteOnly: true, remoteAllowed: true, cities: [],
    })
    expect(prefsFromProfile({ remotePreference: 'remote' })).toMatchObject({ remoteOnly: true, remoteAllowed: true })
    expect(prefsFromProfile({ remotePreference: 'onsite', preferredLocations: ['Austin', 'Remote', ' New York '] })).toEqual({
      countries: [], remoteOnly: false, remoteAllowed: false, cities: ['austin', 'new york'],
    })
  })

  it('tolerates junk and means no preference for an empty profile', () => {
    expect(prefsFromProfile(null)).toEqual({ countries: [], remoteOnly: false, remoteAllowed: true, cities: [] })
    expect(prefsFromProfile({ preferredLocations: 'austin', targeting: 7 })).toEqual({ countries: [], remoteOnly: false, remoteAllowed: true, cities: [] })
  })
})
