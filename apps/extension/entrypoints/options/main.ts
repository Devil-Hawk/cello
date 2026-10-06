import { browser } from 'wxt/browser'
import { DEFAULT_ORIGIN, getLocal, setLocal } from '../../lib/storage'

const origin = document.getElementById('origin') as HTMLInputElement
const token = document.getElementById('token') as HTMLInputElement
const status = document.getElementById('status') as HTMLElement
const save = document.getElementById('save') as HTMLButtonElement

async function load(): Promise<void> {
  origin.value = (await getLocal('origin')) || DEFAULT_ORIGIN
  token.value = (await getLocal('token')) || ''
}

// This build can talk to the address it was built for, and to this computer. Any
// other address needs a build made for it, so the answer is a sentence, not a failure.
async function allowed(url: URL): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] })
  } catch {
    return false
  }
}

save.addEventListener('click', () => {
  void (async () => {
    let url: URL
    try {
      url = new URL(origin.value.trim())
    } catch {
      status.textContent = 'That is not an address. Use the one Cello runs at, like https://cello-two.vercel.app.'
      return
    }
    if (!(await allowed(url))) {
      status.textContent = `This build cannot talk to ${url.origin}. Build the extension for that address, as the install guide says.`
      return
    }
    await setLocal({ origin: url.origin, token: token.value.trim() })
    status.textContent = token.value.trim() ? 'Saved. Cello will check this browser in a minute.' : 'Saved. No token is set.'
  })()
})

void load()
