"""The pull worker, against a fake server that answers claim and result."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src import worker  # noqa: E402

SECRET = "k" * 32
# The signature the app computes for the body {"exp":1792000000} under SECRET, taken from
# apps/web/lib/clock/sign.ts signContinue (createHmac('sha256', key).update(raw, 'utf8').digest('hex')):
#   node -e "console.log(require('crypto').createHmac('sha256','k'.repeat(32)).update('{\"exp\":1792000000}').digest('hex'))"
KNOWN_BODY = b'{"exp":1792000000}'
KNOWN_SIGNATURE = "ceb179b6c8416b7b1fbef5e0ef4edfdb536502beeb3e4ee2528d32c5d9557dc2"

JOB = {"id": "11111111-1111-4111-8111-111111111111", "kind": "careers_page", "url": "https://acme.example/careers"}
SEARCH_JOB = {"id": "22222222-2222-4222-8222-222222222222", "kind": "web_search", "query": "Retell AI"}


class Server:
    """Answers each claim from `claims` (None is a 204) and every result with 200."""

    def __init__(self, claims: list):
        self.claims, self.requests = list(claims), []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers["content-length"]))
                outer.requests.append((self.path, self.headers.get("x-cello-signature"), body))
                job = outer.claims.pop(0) if self.path.endswith("/claim") and outer.claims else None
                if self.path.endswith("/claim") and job is None:
                    self.send_response(204)
                    self.end_headers()
                    return
                reply = json.dumps(job or {"ok": True}).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *args):
                pass

        self.http = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.http.server_port}"

    def close(self):
        self.http.shutdown()

    @property
    def claim_count(self):
        return sum(1 for p, _, _ in self.requests if p.endswith("/claim"))

    @property
    def results(self):
        return [(p, s, b) for p, s, b in self.requests if not p.endswith("/claim")]


@pytest.fixture
def serve(monkeypatch):
    servers = []

    def start(claims):
        server = Server(claims)
        servers.append(server)
        monkeypatch.setenv("CELLO_URL", server.url)
        monkeypatch.setenv("CELLO_CONTINUE_SECRET", SECRET)
        return server

    yield start
    for server in servers:
        server.close()


def test_the_signature_is_the_one_sign_ts_computes():
    assert worker.sign(KNOWN_BODY, SECRET) == KNOWN_SIGNATURE


def test_once_does_one_job_and_posts_the_page_signed(serve, monkeypatch, capsys):
    server = serve([JOB, JOB])
    page = {"ok": True, "html": "<p>roles</p>", "final_url": "https://acme.example/careers/", "rendered": True, "rung": "stealth"}
    seen = []
    monkeypatch.setattr(worker, "fetch_page", lambda url, render: seen.append((url, render)) or page)
    assert worker.main(["--once"]) == 0
    assert seen == [(JOB["url"], True)]  # the browser rungs are allowed
    assert server.claim_count == 1  # --once takes one job unless --max says more
    (path, signature, body), = server.results
    assert path == f"/api/directory/jobs/{JOB['id']}"
    assert signature == worker.sign(body, SECRET)
    sent = json.loads(body)
    assert {k: sent[k] for k in ("ok", "html", "final_url", "rung")} == {
        "ok": True, "html": "<p>roles</p>", "final_url": "https://acme.example/careers/", "rung": "stealth",
    }
    assert "rendered" not in sent
    assert 0 < sent["exp"] - time.time() <= 61
    claim = next(r for r in server.requests if r[0].endswith("/claim"))
    assert claim[1] == worker.sign(claim[2], SECRET) and json.loads(claim[2]).keys() == {"exp"}
    logged = capsys.readouterr().err
    assert "acme.example" not in logged and "1 job(s) done" in logged


def test_a_browser_that_failed_posts_its_class_not_the_empty_shell(serve, monkeypatch):
    server = serve([JOB])
    shell = {"ok": True, "html": "<div id=root></div>", "final_url": "https://acme.example/careers", "rung": "http", "render_error": "TimeoutError"}
    monkeypatch.setattr(worker, "fetch_page", lambda url, render: shell)
    worker.main(["--once"])
    sent = json.loads(server.results[0][2])
    assert (sent["ok"], sent["error"]) == (False, "TimeoutError")
    assert "html" not in sent


def test_an_empty_queue_ends_the_once_run_with_nothing_posted(serve):
    server = serve([])
    assert worker.main(["--once", "--max", "50"]) == 0
    assert server.claim_count == 1 and server.results == []


def test_max_takes_that_many_jobs_and_stops_early_on_an_empty_queue(serve, monkeypatch):
    server = serve([JOB, SEARCH_JOB])
    monkeypatch.setattr(worker, "fetch_page", lambda url, render: {"ok": True, "html": "<p>x</p>", "final_url": url, "rung": "http"})
    monkeypatch.setattr(worker, "search_domains", lambda query: [])
    assert worker.main(["--once", "--max", "5"]) == 0
    assert server.claim_count == 3 and len(server.results) == 2


def test_a_page_that_could_not_be_read_posts_the_class_only(serve, monkeypatch, capsys):
    server = serve([JOB])
    monkeypatch.setattr(worker, "fetch_page", lambda url, render: {"ok": False, "error": "SignInWall", "rung": "http"})
    worker.main(["--once"])
    sent = json.loads(server.results[0][2])
    assert (sent["ok"], sent["error"], sent["rung"]) == (False, "SignInWall", "http")
    assert "html" not in sent


def test_a_crash_while_reading_posts_its_class_never_its_message(serve, monkeypatch, capsys):
    server = serve([JOB])

    def boom(url, render):
        raise OSError(f"could not reach {url}")

    monkeypatch.setattr(worker, "fetch_page", boom)
    worker.main(["--once"])
    body = server.results[0][2].decode()
    assert json.loads(body)["error"] == "OSError" and "acme.example" not in body
    assert "acme.example" not in capsys.readouterr().err


def test_a_long_page_is_cut_to_fit_the_hosts_body_limit(serve, monkeypatch):
    server = serve([JOB])
    monkeypatch.setattr(worker, "fetch_page", lambda url, render: {"ok": True, "html": "a" * 4_000_000, "final_url": url, "rung": "http"})
    worker.main(["--once"])
    assert len(json.loads(server.results[0][2])["html"]) == 3_000_000


def test_a_web_search_posts_the_domains_and_never_logs_the_query(serve, monkeypatch, capsys):
    server = serve([SEARCH_JOB])
    monkeypatch.setattr(worker, "search_domains", lambda query: [{"domain": "retellai.com", "title": "Retell AI"}])
    worker.main(["--once"])
    sent = json.loads(server.results[0][2])
    assert sent["ok"] is True and sent["domains"] == [{"domain": "retellai.com", "title": "Retell AI"}]
    assert "Retell" not in capsys.readouterr().err


def test_a_server_that_is_down_ends_the_once_run_with_status_1(monkeypatch):
    monkeypatch.setenv("CELLO_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("CELLO_CONTINUE_SECRET", SECRET)
    assert worker.main(["--once"]) == 1


def test_the_worker_needs_both_env_names(monkeypatch, capsys):
    monkeypatch.delenv("CELLO_URL", raising=False)
    monkeypatch.setenv("CELLO_CONTINUE_SECRET", SECRET)
    assert worker.main(["--once"]) == 2
    assert SECRET not in capsys.readouterr().err


# --- web search -------------------------------------------------------------------


def _result(href: str, title: str) -> str:
    return f'<div class="result"><a class="result__a" href="{href}">{title}</a></div>'


def _wrapped(url: str) -> str:
    from urllib.parse import quote

    return f"//duckduckgo.com/l/?uddg={quote(url, safe='')}&rut=abc"


RESULTS = (
    "<html><body><div id='links'>"
    + _result(_wrapped("https://www.linkedin.com/company/retell-ai/jobs"), "Retell AI jobs | LinkedIn")
    + _result(_wrapped("https://boards.greenhouse.io/retell"), "Jobs at Retell")
    + _result(_wrapped("https://www.retellai.com/careers"), "Careers at <b>Retell</b> AI")
    + _result(_wrapped("https://blog.retellai.com/hiring"), "Hiring")
    + _result("https://www.example.co.uk/jobs", "Example careers")
    + _result(_wrapped("https://www.nytimes.com/jobs"), "NYT jobs")
    + _result(_wrapped("https://acme.example/careers"), "Acme")
    + "</div></body></html>"
)


@pytest.fixture
def searching(monkeypatch):
    monkeypatch.setattr(worker, "is_public", lambda url: True)
    monkeypatch.setattr(worker, "robots_allowed", lambda url: True)
    asked = []

    def stealth(url, solve):
        asked.append((url, solve))
        return page["html"], url

    page = {"html": RESULTS}
    monkeypatch.setattr(worker, "browser_get", stealth)
    return page, asked


def test_search_keeps_three_distinct_employer_domains_and_drops_job_sites_and_providers(searching):
    _, asked = searching
    assert worker.search_domains("Retell AI") == [
        {"domain": "retellai.com", "title": "Careers at Retell AI"},
        {"domain": "example.co.uk", "title": "Example careers"},
        {"domain": "nytimes.com", "title": "NYT jobs"},
    ]
    url, solve = asked[0]
    assert url == "https://html.duckduckgo.com/html/?q=Retell+AI+careers" and solve is True


def test_search_with_no_results_is_an_empty_list_but_a_challenge_page_is_an_error(searching):
    page, _ = searching
    page["html"] = "<html><body><div class='no-results'>No results.</div></body></html>"
    assert worker.search_domains("zzzz") == []
    page["html"] = "<html><body><form>Unfortunately, bots use DuckDuckGo too.</form></body></html>"
    with pytest.raises(worker.UnreadableResults):
        worker.search_domains("zzzz")


def test_search_obeys_robots(searching, monkeypatch):
    monkeypatch.setattr(worker, "robots_allowed", lambda url: False)
    with pytest.raises(worker.RobotsDisallowed):
        worker.search_domains("Retell AI")
