"""The pull worker: reads the pages Cello's own server could not, and posts what it saw.

    python -m src.worker --once [--max N]
    python -m src.worker --loop [--every SECONDS]

Env: CELLO_URL (the app's address) and CELLO_CONTINUE_SECRET (the same secret the
app signs its background requests with). The worker never holds a database key. It
claims one job from POST {CELLO_URL}/api/directory/jobs/claim, does it, and posts
the outcome to POST {CELLO_URL}/api/directory/jobs/{id}. Both bodies carry an `exp`
a minute ahead and are signed the way apps/web/lib/clock/sign.ts signs: HMAC-SHA256
over the exact bytes sent, hex, in the x-cello-signature header.

Two kinds of job:
    careers_page  run the page ladder (src/page.py) with the browser rungs allowed
    web_search    ask DuckDuckGo's HTML page for "<query> careers" with the stealth
                  rung and keep up to three employer domains

This repo is public and so are the Actions logs: nothing here logs an address or a
query, only counts, job ids and exception classes.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import logging
import os
import sys
import time
from typing import Any
from urllib.parse import parse_qs, quote_plus, urlsplit

import httpx

from .page import browser_get, fetch_page
from .polite import is_public, robots_allowed

# Hosts a search result must not be: job sites (apps/web/lib/ingest/reader/legit.ts
# REPOST_HOSTS), applicant-system hosts (apps/web/lib/companies/verify-directory.ts
# PROVIDER_HOSTS) and the search engine itself. Registrable domains.
NOT_AN_EMPLOYER = (
    "linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com", "dice.com",
    "simplify.jobs", "jobgether.com", "builtin.com", "wellfound.com", "monster.com",
    "jooble.org", "talent.com", "careerbuilder.com", "snagajob.com", "lensa.com",
    "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com",
    "recruitee.com", "personio.de", "personio.com", "myworkdayjobs.com", "eightfold.ai",
    "duckduckgo.com",
)  # fmt: skip

# ponytail: Vercel Functions refuse a request body over 4.5 MB, so a very long page is
# cut here. Listings come early in a page; raise this only with the host's limit.
_MAX_HTML = 3_000_000
_EXP_AHEAD_S = 60
_DOMAINS = 3


class RobotsDisallowed(Exception):  # noqa: N818 - the class name is the reason reported
    pass


class UnreadableResults(Exception):  # noqa: N818 - the class name is the reason reported
    pass


def sign(raw: bytes, secret: str) -> str:
    """apps/web/lib/clock/sign.ts signContinue: hex HMAC-SHA256 over the exact bytes."""
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def _post(base: str, path: str, secret: str, payload: dict[str, Any]) -> httpx.Response:
    body = json.dumps(
        {**payload, "exp": int(time.time()) + _EXP_AHEAD_S},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return httpx.post(
        base.rstrip("/") + path,
        content=body,
        headers={"content-type": "application/json", "x-cello-signature": sign(body, secret)},
        timeout=60,
    )


def _unwrap(href: str) -> str:
    """DuckDuckGo wraps each result in a redirect whose `uddg` parameter is the address."""
    parts = urlsplit(href)
    target = parse_qs(parts.query).get("uddg")
    return target[0] if target else href


def search_domains(query: str) -> list[dict[str, str]]:
    """Up to three distinct employer domains for "<query> careers", with their titles."""
    from scrapling.parser import Selector
    from tld import get_fld

    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query + ' careers')}"
    if not (is_public(url) and robots_allowed(url)):
        raise RobotsDisallowed
    html, _ = browser_get(url, True)
    page = Selector(html)
    results = page.css("a.result__a")
    if not results and not page.css(".no-results"):
        raise UnreadableResults  # a challenge page is not "nothing found"
    found: dict[str, str] = {}
    for link in results:
        domain = get_fld(_unwrap(link.attrib.get("href", "")), fail_silently=True)
        if not domain or domain in found:
            continue
        if any(domain == h or domain.endswith("." + h) for h in NOT_AN_EMPLOYER):
            continue
        found[domain] = " ".join(link.get_all_text().split())
        if len(found) == _DOMAINS:
            break
    return [{"domain": d, "title": t} for d, t in found.items()]


def do_job(job: dict[str, Any]) -> dict[str, Any]:
    """The result body for one claimed job. Never raises, never carries an address."""
    try:
        if job.get("kind") == "web_search":
            return {"ok": True, "domains": search_domains(str(job["query"]))}
        out = dict(fetch_page(str(job["url"]), True))
        if isinstance(out.get("html"), str):
            out["html"] = out["html"][:_MAX_HTML]
        return {k: out[k] for k in ("ok", "html", "final_url", "rung", "error") if k in out}
    except Exception as exc:  # noqa: BLE001 - reported by class name only
        return {"ok": False, "error": type(exc).__name__}


def work_one(base: str, secret: str) -> bool:
    """Claim one job and post its outcome. False when the queue was empty."""
    claim = _post(base, "/api/directory/jobs/claim", secret, {})
    if claim.status_code == 204:
        return False
    claim.raise_for_status()
    job = claim.json()
    result = do_job(job)
    how = result.get("rung") or result.get("error") or ""
    log(f"job {job['id']} {job.get('kind')} ok={result.get('ok')} {how}")
    for attempt in range(3):  # the server re-queues a claim left for 20 minutes
        try:
            _post(base, f"/api/directory/jobs/{job['id']}", secret, result).raise_for_status()
            return True
        except httpx.HTTPError:
            if attempt == 2:
                raise
            time.sleep(5)
    return True


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def main(argv: list[str]) -> int:
    # Libraries log the address they fetched on their own handlers; this output is public.
    logging.disable(logging.CRITICAL)
    ap = argparse.ArgumentParser(prog="python -m src.worker")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="work the queue, then exit")
    mode.add_argument("--loop", action="store_true", help="work the queue forever")
    ap.add_argument("--max", type=int, default=1, help="with --once: most jobs to take")
    ap.add_argument("--every", type=float, default=5.0, help="with --loop: seconds between polls")
    args = ap.parse_args(argv)
    base, secret = os.environ.get("CELLO_URL", ""), os.environ.get("CELLO_CONTINUE_SECRET", "")
    if not base or not secret:
        log("Set CELLO_URL and CELLO_CONTINUE_SECRET.")
        return 2
    done = 0
    try:
        while args.loop or done < args.max:
            try:
                took = work_one(base, secret)
            except httpx.HTTPError as exc:
                log(f"server error {type(exc).__name__}")
                if not args.loop:
                    return 1
                took = False
            if took:
                done += 1
            elif args.once:
                break
            else:
                time.sleep(args.every)
    except KeyboardInterrupt:
        pass
    log(f"{done} job(s) done")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
