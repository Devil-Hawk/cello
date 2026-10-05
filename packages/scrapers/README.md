# Cello Scrapers

Python helpers for the parts of job ingestion that need a browser.

Job ingestion itself is `apps/web/scripts/ingest.ts`: it reads each company's
job board API first and falls back to the careers page. The only thing this
package does for it is fetch a page the way a browser shows it:

```bash
python -m src.page https://company.com/careers
```

That prints one JSON line, `{"ok": true, "html": "...", "final_url": "...", "rendered": false}`,
or `{"ok": false, "error": "<ExceptionClass>"}`. It tries a plain request, then a
rendered browser view when the page is an empty shell, then a Playwright click-through
to a "see open roles" page. Reading the HTML (job markup, the model, checking
what the model named) is TypeScript, so the scheduled check and the in-app
button read a page the same way.

The package also holds the posting verifier (`verification.py`) and the
browser application filler (`apply_*.py`).

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

ruff check src
pytest
```
