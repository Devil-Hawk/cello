"""Tests for the render-escalation heuristic.

The decision this module makes is a cost/coverage tradeoff, so it is worth
pinning precisely: escalating too eagerly launches a browser per company per
hour, escalating too rarely leaves ~70% of a user's watchlist invisible.

Nothing here touches the network or launches a browser — the heuristic is pure.
"""

from scrapling.fetchers import StealthyFetcher

from src import render
from src.render import ShellVerdict, count_job_links, looks_like_unrendered_shell

# A real-shaped SPA shell: the jobs arrive later, over XHR.
SPA_SHELL = """
<!doctype html><html><head><title>Careers</title>
<script src="/static/bundle.js"></script></head>
<body><div id="root"></div></body></html>
"""

# A static board that already carries its postings.
STATIC_BOARD = """
<!doctype html><html><body>
<h1>Open roles at Example</h1>
<p>We are hiring across engineering, design and operations. Come build with us.</p>
<ul>
  <li><a href="/careers/senior-engineer-123">Senior Engineer</a></li>
  <li><a href="/careers/product-designer-456">Product Designer</a></li>
  <li><a href="/jobs/data-analyst-789">Data Analyst</a></li>
</ul>
</body></html>
"""


class TestCountJobLinks:
    def test_counts_posting_shaped_hrefs(self):
        assert count_job_links(STATIC_BOARD) == 3

    def test_ignores_unrelated_links(self):
        html = '<a href="/about">About</a><a href="/blog/post">Blog</a><a href="/pricing">Pricing</a>'
        assert count_job_links(html) == 0

    def test_matches_several_posting_vocabularies(self):
        html = (
            '<a href="/positions/42">a</a>'
            '<a href="/opening/7">b</a>'
            '<a href="/vacancies/9">c</a>'
            '<a href="/opportunities/3">d</a>'
        )
        # "opening" (singular, no s) is intentionally not matched; the others are.
        assert count_job_links(html) >= 3


class TestLooksLikeUnrenderedShell:
    def test_spa_shell_escalates(self):
        v = looks_like_unrendered_shell(SPA_SHELL)
        assert v.is_shell is True
        assert "shell" in v.reason or "text" in v.reason

    def test_static_board_does_not_escalate(self):
        v = looks_like_unrendered_shell(STATIC_BOARD)
        assert v.is_shell is False
        assert v.job_links == 3

    def test_empty_body_escalates(self):
        assert looks_like_unrendered_shell("").is_shell is True
        assert looks_like_unrendered_shell(None).is_shell is True
        assert looks_like_unrendered_shell("   ").is_shell is True

    def test_plenty_of_job_links_beats_a_short_page(self):
        # Some real boards are a terse list of links and nothing else. Those
        # must NOT be escalated just for being short.
        terse = "<html><body>" + "".join(
            f'<a href="/jobs/{i}">Role {i}</a>' for i in range(5)
        ) + "</body></html>"
        v = looks_like_unrendered_shell(terse)
        assert v.is_shell is False

    def test_prose_page_with_no_jobs_escalates(self):
        # Long enough to pass the text threshold, but nothing job-shaped: worth
        # a render, because the listings may be client-side.
        html = "<html><body><p>" + ("about our company " * 100) + "</p></body></html>"
        v = looks_like_unrendered_shell(html)
        assert v.is_shell is True
        assert v.job_links == 0

    def test_script_and_style_do_not_count_as_visible_text(self):
        # A shell padded with a big inline bundle must still read as a shell,
        # otherwise every SPA slips past the text-length check.
        html = (
            "<html><head><style>"
            + ("a{color:red}" * 200)
            + "</style><script>"
            + ("var x=1;" * 200)
            + '</script></head><body><div id="app"></div></body></html>'
        )
        v = looks_like_unrendered_shell(html)
        assert v.is_shell is True
        assert v.text_chars < 600


class FakePage:
    def __init__(self):
        self.moves = []
        self.mouse = self
        self.waits = 0

    def wheel(self, x, y):
        self.moves.append(y)

    def wait_for_timeout(self, ms):
        self.waits += 1


class TestFetchRendered:
    def test_returns_the_html_and_the_final_url_and_scrolls_the_page(self, monkeypatch):
        seen = {}

        def fetch(url, **kwargs):
            seen.update(kwargs)
            kwargs["page_action"](page := FakePage())
            seen["page"] = page
            return type("R", (), {"body": b"<html>roles</html>", "encoding": "utf-8", "url": url + "/all"})()

        monkeypatch.setattr(StealthyFetcher, "fetch", staticmethod(fetch))
        got = render.fetch_rendered("https://example.com/careers")
        assert got == ("<html>roles</html>", "https://example.com/careers/all")
        assert render.last_error is None
        assert seen["solve_cloudflare"] is False and seen["network_idle"] is True and seen["retries"] == 1
        assert len(seen["page"].moves) == 5

    def test_a_browser_that_cannot_run_is_none_with_the_class(self, monkeypatch):
        def broken(url, **kwargs):
            raise ImportError("no browser here")

        monkeypatch.setattr(StealthyFetcher, "fetch", staticmethod(broken))
        assert render.fetch_rendered("https://example.com/careers") is None
        assert render.last_error == "ImportError"

    def test_an_empty_page_is_none(self, monkeypatch):
        empty = type("R", (), {"body": b"", "encoding": "utf-8", "url": "https://example.com/"})()
        monkeypatch.setattr(StealthyFetcher, "fetch", staticmethod(lambda url, **kw: empty))
        assert render.fetch_rendered("https://example.com/careers") is None
        assert render.last_error == "EmptyPage"


class TestShellVerdict:
    def test_verdict_carries_its_reasoning(self):
        v = looks_like_unrendered_shell(STATIC_BOARD)
        assert isinstance(v, ShellVerdict)
        assert v.reason
        assert v.text_chars > 0
