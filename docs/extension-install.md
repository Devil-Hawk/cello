# Install the Cello extension by hand

Until the extension is in the Chrome Web Store, you load it yourself. It takes four steps and works in Chrome, Edge, Brave and other Chromium browsers.

1. Download the build. Open the latest run of CI on GitHub (you need to be signed in to GitHub to download), then Artifacts, then `cello-extension`, and unzip it once into a folder you will keep, for example `~/cello-extension`. That folder holds `manifest.json`. Do not delete it: the browser reads the extension from it. GitHub keeps artifacts for 90 days, so download again from a newer run if the link has gone.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on Developer mode, the switch at the top right.
4. Choose Load unpacked and pick the unzipped folder. The Cello icon appears in the toolbar.

Then connect it. In Cello, open Your search and choose Connect the extension. If that is not there yet, open the extension's options page, paste your token and save.

## Use it

Open an application on Greenhouse, Lever or Ashby. Click Fill with Cello in the corner of the page, or the toolbar icon and Fill this page. Cello fills what it knows, marks what it does not, and you press the employer's own Send button.

Pause Cello in the popup stops anything Cello is doing before its next step.

## Use a model on this computer (optional)

If you run Ollama or LM Studio, the extension can let Cello use it for work you set to run on this computer, at no cost. In Cello, open Settings, then Tokens, and make a token with the scope `relay`. Open the extension's options page, paste it under Relay token, choose Ollama or LM Studio, give the model name and save. It only ever talks to this computer, never to another address.

- Ollama: set `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama, so it accepts the extension.
- LM Studio: in the Developer tab start the local server and turn on Enable CORS.

The extension looks for waiting work about every five minutes.

## Update it

There is no automatic update yet. Download the new zip, unzip it over the same folder, then open `chrome://extensions` and press the reload arrow on the Cello card. If Cello says "Update the Cello extension", your build is older than the minimum it allows.

## Build it yourself

You need Node 22 and pnpm.

```
pnpm install
WXT_CELLO_ORIGIN=https://your-cello.example pnpm --filter @cello/extension build
```

The build is in `apps/extension/.output/chrome-mv3`. `WXT_CELLO_ORIGIN` is the address your Cello runs at; leave it out for the hosted Cello.
