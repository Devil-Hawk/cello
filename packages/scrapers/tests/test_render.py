"""Tests for the render-escalation heuristic.

The decision this module makes is a cost/coverage tradeoff, so it is worth
pinning precisely: escalating too eagerly launches a browser per company per
hour, escalating too rarely leaves ~70% of a user's watchlist invisible.

Nothing here touches the network or launches a browser — the heuristic is pure.
"""

from src.render import (
    ShellVerdict,
    count_job_links,
    fetch_with_render_fallback,
    looks_like_unrendered_shell,
)

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


class TestFetchWithRenderFallback:
    def test_static_html_with_jobs_is_returned_untouched(self):
        html, rendered = fetch_with_render_fallback("https://example.com/careers", STATIC_BOARD)
        assert rendered is False
        assert html == STATIC_BOARD

    def test_shell_without_scrapling_degrades_to_static(self, monkeypatch):
        # Scrapling absent must NEVER raise: the run continues on the httpx path.
        monkeypatch.setattr("src.render.scrapling_available", lambda: False)
        html, rendered = fetch_with_render_fallback("https://example.com/careers", SPA_SHELL)
        assert rendered is False
        assert html == SPA_SHELL

    def test_rendered_html_is_used_when_it_adds_postings(self, monkeypatch):
        monkeypatch.setattr("src.render.fetch_rendered", lambda url, **kw: STATIC_BOARD)
        html, rendered = fetch_with_render_fallback("https://example.com/careers", SPA_SHELL)
        assert rendered is True
        assert html == STATIC_BOARD

    def test_rendered_html_is_discarded_when_it_adds_nothing(self, monkeypatch):
        # A site that serves a bot wall to headless Chromium would otherwise
        # replace usable static HTML with something worse.
        monkeypatch.setattr(
            "src.render.fetch_rendered", lambda url, **kw: "<html><body>Access denied</body></html>"
        )
        html, rendered = fetch_with_render_fallback("https://example.com/careers", SPA_SHELL)
        assert rendered is False
        assert html == SPA_SHELL

    def test_failed_render_degrades_to_static(self, monkeypatch):
        monkeypatch.setattr("src.render.fetch_rendered", lambda url, **kw: None)
        html, rendered = fetch_with_render_fallback("https://example.com/careers", SPA_SHELL)
        assert rendered is False
        assert html == SPA_SHELL


class TestShellVerdict:
    def test_verdict_carries_its_reasoning(self):
        v = looks_like_unrendered_shell(STATIC_BOARD)
        assert isinstance(v, ShellVerdict)
        assert v.reason
        assert v.text_chars > 0
