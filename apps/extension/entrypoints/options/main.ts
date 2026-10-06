import { browser } from 'wxt/browser'
import { DEFAULT_ORIGIN, getLocal, setLocal } from '../../lib/storage'

const origin = document.getElementById('origin') as HTMLInputElement
const token = document.getElementById('token') as HTMLInputElement
const status = document.getElementById('status') as HTMLElement
const relayToken = document.getElementById('relay-token') as HTMLInputElement
const runtime = document.getElementById('runtime') as HTMLSelectElement
const model = document.getElementById('model') as HTMLInputElement
const browserModel = document.getElementById('browser-model') as HTMLInputElement
const save = document.getElementById('save') as HTMLButtonElement

async function load(): Promise<void> {
  origin.value = (await getLocal('origin')) || DEFAULT_ORIGIN
  token.value = (await getLocal('token')) || ''
  relayToken.value = (await getLocal('relayToken')) || ''
  const local = await getLocal('relayLocal')
  runtime.value = local?.runtime ?? 'ollama'
  model.value = local?.model ?? ''
  browserModel.checked = (await getLocal('relayBrowser')) === true
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
    await setLocal({ origin: url.origin, token: token.value.trim(), relayToken: relayToken.value.trim(), relayBrowser: browserModel.checked })
    const name = model.value.trim()
    if (name) {
      const kind = runtime.value === 'lmstudio' ? 'lmstudio' : 'ollama'
      await setLocal({ relayLocal: { runtime: kind, baseUrl: kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234', model: name } })
    } else await browser.storage.local.remove('relayLocal')
    status.textContent = token.value.trim() ? 'Saved. Cello will check this browser in a minute.' : 'Saved. No token is set.'
  })()
})

void load()
