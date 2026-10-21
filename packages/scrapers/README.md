# Cello Scrapers

Python helpers for the parts of job ingestion that need a browser.

Job ingestion itself is `apps/web/scripts/ingest.ts`: it reads each company's
job board API first and falls back to the careers page. The only thing this
package does for it is fetch a page the way a browser shows it:

```bash
python -m src.page https://company.com/careers
```

That prints one JSON line, `{"ok": true, "html": "...", "final_url": "...", "rendered": false, "rung": "http"}`,
or `{"ok": false, "error": "<ExceptionClass>"}`. It reads the site's robots.txt first and
obeys it. With `--render` it climbs a ladder, each rung only when the one before found
no job links: a plain request that looks like Chrome (`http`), a browser (`rendered`),
the same browser with Cloudflare's check solved (`stealth`), then a click-through to a
"see open roles" page (`click`). It never signs in and never submits a form. A sign-in
wall or a CAPTCHA that is not Cloudflare's ends the read with the reason. Reading the
HTML (job markup, board links, checking whose board it is) is TypeScript, so every read
treats a page the same way.

The package also holds the posting verifier (`verification.py`) and the
browser application filler (`apply_*.py`).

## Run the worker on your own machine

Pages the server could not read are queued. A worker takes them one at a time, reads
each in a browser and posts what it saw back to the app. It never holds a database
key. GitHub Actions runs it when jobs are waiting (`directory-read.yml`). Running it
at home works better for sites that distrust datacenter addresses.

```bash
cd packages/scrapers
python -m venv .venv && source .venv/bin/activate
pip install -e ".[render]"
scrapling install
export CELLO_URL=...              # the app's address
export CELLO_CONTINUE_SECRET=...  # the same value as AGENT_CONTINUE_SECRET on the app
python -m src.worker --loop       # or: python -m src.worker --once --max 10
```

`--loop` polls every 5 seconds (`--every SECONDS` changes that). `--once` takes up to
`--max` jobs and exits. The worker prints counts and error classes, never an address.

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

ruff check src
pytest
```
