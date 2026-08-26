"""
Intelligent Job Scraper - AI-powered career page parsing.

Instead of fragile CSS selectors, this scraper uses:
1. LLM to understand page structure and extract job listings
2. Semantic chunking to handle pagination and dynamic content
3. Self-healing patterns that adapt to site changes
"""

import asyncio
import json
import logging
import re
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any

import httpx
from bs4 import BeautifulSoup
from pydantic import BaseModel

from .browser_tier import fetch_with_browser_fallback
from .fallback import FallbackExtractor
from .render import fetch_with_render_fallback
from .types import ScrapedJob, ScrapeResult

# Default retry configuration
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_DELAY = 1.0  # seconds
DEFAULT_RATE_LIMIT_DELAY = 0.5  # seconds between requests


class PageContent(BaseModel):
    """Cleaned page content for LLM processing."""

    url: str
    text: str
    links: list[dict[str, str]]  # [{"text": "...", "href": "..."}]
    metadata: dict[str, Any]


class LLMProvider(ABC):
    """Abstract base for LLM providers."""

    @abstractmethod
    async def extract_jobs(self, content: PageContent) -> list[dict[str, Any]]:
        """Use LLM to extract job listings from page content."""
        ...


class IntelligentScraper:
    """
    AI-powered scraper that understands career pages semantically.

    Key features:
    - Uses LLM to parse any career page format (no selectors needed)
    - Handles pagination automatically by following "next" links
    - Extracts structured data even from unstructured pages
    - Self-heals when site structure changes
    """

    def __init__(
        self,
        company_id: str,
        career_url: str,
        llm_provider: LLMProvider,
        timeout: float = 30.0,
        max_pages: int = 10,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_delay: float = DEFAULT_RETRY_DELAY,
        rate_limit_delay: float = DEFAULT_RATE_LIMIT_DELAY,
    ) -> None:
        self.company_id = company_id
        self.career_url = career_url
        self.llm = llm_provider
        self.timeout = timeout
        self.max_pages = max_pages
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.rate_limit_delay = rate_limit_delay
        self._client: httpx.AsyncClient | None = None
        self._last_request_time: float = 0

    async def __aenter__(self) -> "IntelligentScraper":
        self._client = httpx.AsyncClient(
            timeout=self.timeout,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
        )
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self._client:
            await self._client.aclose()

    def _clean_html(self, html: str) -> PageContent:
        """
        Clean HTML and extract meaningful content for LLM processing.

        Removes scripts, styles, and noise. Preserves structure hints.
        """
        soup = BeautifulSoup(html, "lxml")

        # Remove noise
        for tag in soup.find_all(["script", "style", "noscript", "svg", "iframe"]):
            tag.decompose()

        # Extract links (important for job detail pages)
        links = []
        for a in soup.find_all("a", href=True):
            text = a.get_text(strip=True)
            href = a["href"]
            if text and len(text) < 200:  # Reasonable link text
                links.append({"text": text, "href": href})

        # Get clean text with some structure
        text = soup.get_text(separator="\n", strip=True)

        # Remove excessive whitespace while preserving structure
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r" {2,}", " ", text)

        # Truncate if too long (LLM context limits)
        if len(text) > 50000:
            text = text[:50000] + "\n[TRUNCATED]"

        return PageContent(
            url=self.career_url,
            text=text,
            links=links[:500],  # Limit links
            metadata={
                "title": soup.title.string if soup.title else None,
                "scraped_at": datetime.utcnow().isoformat(),
            },
        )

    def _find_pagination_links(self, links: list[dict[str, str]]) -> list[str]:
        """
        Find pagination links (next page, page numbers, load more).
        """
        pagination_patterns = [
            r"page[=/]?\d+",
            r"next",
            r"load.?more",
            r"show.?more",
            r"view.?all",
            r"offset[=/]\d+",
        ]

        pagination_links = []
        for link in links:
            text_lower = link["text"].lower()
            href_lower = link["href"].lower()

            for pattern in pagination_patterns:
                if re.search(pattern, text_lower) or re.search(pattern, href_lower):
                    pagination_links.append(link["href"])
                    break

        return list(set(pagination_links))[:5]  # Max 5 pagination links

    async def _fetch_page(self, url: str) -> str:
        """
        Fetch a page with retry logic and rate limiting.

        Implements:
        - Rate limiting between requests
        - Exponential backoff for retries
        - Special handling for 429 (rate limited) responses
        """
        import time

        if not self._client:
            raise RuntimeError("Scraper must be used as async context manager")

        # Rate limiting: ensure minimum delay between requests
        current_time = time.time()
        time_since_last = current_time - self._last_request_time
        if time_since_last < self.rate_limit_delay:
            await asyncio.sleep(self.rate_limit_delay - time_since_last)

        last_exception = None

        for attempt in range(self.max_retries):
            try:
                self._last_request_time = time.time()
                response = await self._client.get(url)

                # Handle rate limiting (429)
                if response.status_code == 429:
                    # Check for Retry-After header
                    retry_after = response.headers.get("Retry-After")
                    if retry_after:
                        try:
                            wait_time = int(retry_after)
                        except ValueError:
                            wait_time = self.retry_delay * (2**attempt)
                    else:
                        wait_time = self.retry_delay * (2**attempt)

                    if attempt < self.max_retries - 1:
                        await asyncio.sleep(min(wait_time, 60))  # Cap at 60 seconds
                        continue
                    else:
                        raise httpx.HTTPStatusError(
                            "Rate limited after max retries",
                            request=response.request,
                            response=response,
                        )

                response.raise_for_status()
                return response.text

            except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.ConnectError) as e:
                last_exception = e
                if attempt < self.max_retries - 1:
                    # Exponential backoff
                    wait_time = self.retry_delay * (2**attempt)
                    await asyncio.sleep(wait_time)
                    continue
                raise

            except httpx.HTTPStatusError as e:
                # For 5xx errors, retry with backoff
                if 500 <= e.response.status_code < 600:
                    last_exception = e
                    if attempt < self.max_retries - 1:
                        wait_time = self.retry_delay * (2**attempt)
                        await asyncio.sleep(wait_time)
                        continue
                raise

        # Should not reach here, but just in case
        if last_exception:
            raise last_exception
        raise RuntimeError("Fetch failed for unknown reason")

    async def scrape(self) -> ScrapeResult:
        """
        Scrape jobs using AI-powered extraction.

        1. Fetches career page
        2. Cleans HTML for LLM processing
        3. Uses LLM to extract job listings
        4. Follows pagination if found
        5. Deduplicates results
        """
        start_time = datetime.utcnow()
        all_jobs: list[ScrapedJob] = []
        visited_urls: set[str] = set()
        urls_to_visit = [self.career_url]

        try:
            while urls_to_visit and len(visited_urls) < self.max_pages:
                url = urls_to_visit.pop(0)
                if url in visited_urls:
                    continue

                visited_urls.add(url)

                # Fetch and clean page.
                #
                # httpx returns only what the server sent, so a career page that
                # renders its listings client-side arrives as an empty shell and
                # every extractor below finds nothing — the company is then
                # silently recorded as having no openings. That is not a rare
                # edge: for one user, 303 of 436 watched companies have no
                # detectable Greenhouse/Lever/Ashby board and depend entirely on
                # this generic path, which had produced 3 stored jobs in total.
                #
                # So a shell is escalated to a real browser. Pages that already
                # carry their postings skip this untouched, keeping the cheap
                # path cheap. Scrapling's fetch is synchronous, hence to_thread:
                # calling it directly would stall the event loop for every other
                # company in the run. See src/render.py.
                static_html = await self._fetch_page(url)
                html, was_rendered = await asyncio.to_thread(
                    fetch_with_render_fallback, url, static_html
                )
                if was_rendered:
                    logging.getLogger(__name__).info(
                        "rendered %s in a browser to reach its listings", url
                    )

                # Scrapling's single rendered fetch of THIS url still misses
                # boards that sit behind a click (a "Careers" nav link, a
                # "View all openings" button) rather than behind the shell
                # itself. Tier 3 escalates further only when Tier 2's result
                # still verdicts as a shell — see src/browser_tier.py for the
                # deterministic-click-before-LLM ladder within this tier.
                html, was_browser_assisted = await asyncio.to_thread(
                    fetch_with_browser_fallback, url, html
                )
                if was_browser_assisted:
                    logging.getLogger(__name__).info(
                        "navigated %s in a real browser to reach its listings", url
                    )
                content = self._clean_html(html)

                # Try AI extraction first, fallback to heuristics if it fails
                ai_jobs = []
                try:
                    extracted = await self.llm.extract_jobs(content)
                    for job_data in extracted:
                        try:
                            job = ScrapedJob(
                                title=job_data.get("title", "Unknown"),
                                description=job_data.get("description", ""),
                                url=job_data.get("url", url),
                                location=job_data.get("location"),
                                salary_range=job_data.get("salary"),
                                job_type=job_data.get("type"),
                                posted_at=self._parse_date(job_data.get("posted_at")),
                                external_id=job_data.get("id"),
                            )
                            ai_jobs.append(job)
                        except Exception:
                            continue
                except Exception:
                    # LLM failed - will use fallback
                    pass

                # If AI extraction got results, use them
                # Otherwise, try fallback extraction strategies
                if ai_jobs:
                    all_jobs.extend(ai_jobs)
                else:
                    # Fallback: try structured data, heuristics, link extraction
                    fallback = FallbackExtractor(url)
                    fallback_result = fallback.extract(html)
                    if fallback_result.jobs:
                        all_jobs.extend(fallback_result.jobs)

                # Find pagination for next iteration
                pagination = self._find_pagination_links(content.links)
                for link in pagination:
                    # Make absolute URL
                    if link.startswith("/"):
                        from urllib.parse import urljoin

                        link = urljoin(url, link)
                    if link not in visited_urls:
                        urls_to_visit.append(link)

            # Deduplicate by URL
            seen_urls = set()
            unique_jobs = []
            for job in all_jobs:
                if str(job.url) not in seen_urls:
                    seen_urls.add(str(job.url))
                    unique_jobs.append(job)

            end_time = datetime.utcnow()
            return ScrapeResult(
                company_id=self.company_id,
                success=True,
                jobs=unique_jobs,
                scraped_at=end_time,
                duration_ms=int((end_time - start_time).total_seconds() * 1000),
            )

        except Exception as e:
            end_time = datetime.utcnow()
            return ScrapeResult(
                company_id=self.company_id,
                success=False,
                error=str(e),
                scraped_at=end_time,
                duration_ms=int((end_time - start_time).total_seconds() * 1000),
            )

    def _parse_date(self, date_str: str | None) -> datetime | None:
        """Try to parse various date formats."""
        if not date_str:
            return None

        # Common patterns
        patterns = [
            "%Y-%m-%d",
            "%m/%d/%Y",
            "%d/%m/%Y",
            "%B %d, %Y",
            "%b %d, %Y",
        ]

        for pattern in patterns:
            try:
                return datetime.strptime(date_str, pattern)
            except ValueError:
                continue

        # Handle relative dates like "2 days ago"
        relative_match = re.match(r"(\d+)\s*(day|week|month)s?\s*ago", date_str.lower())
        if relative_match:
            from datetime import timedelta

            num = int(relative_match.group(1))
            unit = relative_match.group(2)
            if unit == "day":
                return datetime.utcnow() - timedelta(days=num)
            elif unit == "week":
                return datetime.utcnow() - timedelta(weeks=num)
            elif unit == "month":
                return datetime.utcnow() - timedelta(days=num * 30)

        return None


class OpenAIProvider(LLMProvider):
    """
    OpenAI-based job extraction.

    Uses structured output with function calling for reliable extraction.
    """

    def __init__(self, api_key: str, model: str = "gpt-4o-mini") -> None:
        self.api_key = api_key
        self.model = model

    async def extract_jobs(self, content: PageContent) -> list[dict[str, Any]]:
        """Extract jobs using OpenAI function calling."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {
                            "role": "system",
                            "content": """\
# Role: Expert Job Listing Extractor

You are a world-class web scraping specialist with deep expertise in:
- HTML/DOM structure analysis
- Applicant Tracking System (ATS) patterns
- Career page layouts across thousands of companies
- Data extraction and normalization

## Your Mission

Extract EVERY job listing from career pages with 100% accuracy. Missing a \
job means a candidate might miss their dream opportunity. False positives \
waste people's time. Your work directly impacts job seekers' lives.

---

## Chain-of-Thought Analysis Framework

Before extracting, you MUST think through these steps systematically:

### Step 1: Page Classification (CRITICAL)

Determine the page type - this affects your entire strategy:

| Page Type | Characteristics | Strategy |
|-----------|-----------------|----------|
| Job Board | Multiple listings, filters, pagination | Extract all visible jobs |
| Single Job | One detailed posting | Extract that one job fully |
| Department Page | "Engineering", "Sales" sections | Extract jobs within sections |
| Landing Page | "Join Us" hero, few featured jobs | Only extract actual listings |
| Search Results | Query-based, may be empty | Handle zero results gracefully |

### Step 2: ATS Detection

Identify the Applicant Tracking System for pattern recognition:

**Greenhouse**:
- URLs contain `boards.greenhouse.io` or `/jobs?`
- Job cards have `opening` class
- Department groupings common

**Lever**:
- URLs contain `jobs.lever.co`
- Clean card-based layout
- Categories on left sidebar

**Workday**:
- URLs contain `myworkdayjobs.com`
- Complex nested structure
- Heavy JavaScript rendering

**Ashby**:
- URLs contain `jobs.ashbyhq.com`
- Modern card layout
- Good structured data

**Custom/Unknown**:
- Analyze DOM patterns
- Look for repeated structures
- Check for JSON-LD data

### Step 3: Pattern Recognition

Look for these signals to identify job listings:

**Strong Signals (High Confidence):**
- Links containing `/jobs/`, `/careers/`, `/positions/`
- Elements with classes: `job`, `position`, `opening`, `listing`, `vacancy`
- Structured data (JSON-LD with `@type: JobPosting`)
- Repeating card/list structures with titles + locations

**Weak Signals (Verify Carefully):**
- Generic link text that could be job titles
- Department headers (not jobs themselves)
- "View All" or "See More" links

**Red Flags (NOT Jobs):**
- Navigation elements: Home, About, Contact, Blog
- Call-to-action buttons: Apply Now, Learn More, Subscribe
- Footer links: Privacy, Terms, Social media
- Category headers: Engineering, Design, Marketing (without actual jobs)

### Step 4: Data Extraction Protocol

For EACH identified job, extract:

```
title:       EXACT job title as displayed (no modifications)
url:         ABSOLUTE URL (prepend base domain if relative path)
location:    City, State/Country or "Remote" or "Hybrid"
description: First 200 chars of job summary if visible
salary:      Pay range if displayed (preserve format)
type:        Full-time | Part-time | Contract | Internship
posted_at:   Date string if visible (any format)
id:          External job ID if visible in URL or page
```

**URL Handling Rules:**
- `/jobs/123` → `https://company.com/jobs/123`
- `?gh_jid=456` → Include full query string
- Relative paths MUST become absolute
- Preserve all URL parameters

### Step 5: Validation Checklist

Before returning, verify EACH job:

✓ Is the title a real job? (not "Apply Now", not a department name)
✓ Does the URL look like a job page? (not /about, /contact, /blog)
✓ Is this a duplicate? (same title + same URL = duplicate)
✓ Is this actually from this company? (not an ad or external link)

---

## Edge Cases & Error Handling

**Empty Pages:**
- Page says "No open positions" → Return empty array
- Page is loading/JS required → Extract what's visible

**Pagination:**
- Only extract jobs visible on current page
- Don't follow "Next" or "Load More" links

**Internationalization:**
- Preserve non-English job titles exactly
- Location may be in local language

**Malformed Data:**
- Missing URL? Skip that job
- Missing title? Skip that job
- Missing location? Include with null location

---

## Output Quality Standards

Your extraction will be evaluated on:

1. **Recall**: Did you find ALL jobs? (Target: 100%)
2. **Precision**: Are all results actual jobs? (Target: 100%)
3. **Data Quality**: Are URLs correct? Titles exact? (Target: 100%)

A single missed job or false positive is a failure. Be thorough.""",
                        },
                        {
                            "role": "user",
                            "content": f"""Extract all job listings from this career page.

## INPUT DATA

**URL:** {content.url}

### Page Content (cleaned):
{content.text[:30000]}

### Links Found (may contain job URLs):
{json.dumps(content.links[:100], indent=2)}

---

## YOUR ANALYSIS PROCESS

<think>
Step 1: IDENTIFY PAGE TYPE
- Is this a job listing page (many jobs) or single job page?
- What ATS or format is used? (Greenhouse, Lever, Workday, custom)

Step 2: LOCATE JOB ENTRIES
- Find repeating patterns (cards, list items, etc.)
- Identify job-related links vs navigation links

Step 3: EXTRACT FOR EACH JOB
- title: Exact job title
- url: Full absolute URL to the job posting
- location: City/State/Remote if mentioned
- description: Brief summary if visible
- salary: Pay range if mentioned
- type: Full-time/Part-time/Contract
- posted_at: Date if visible
- id: Job ID if visible

Step 4: VALIDATE
- Are these real job titles or navigation elements?
- Are URLs pointing to actual job pages?
- Remove duplicates
</think>

---

## EXTRACTION RULES

INCLUDE: Real job titles (e.g., "Senior Engineer", "Product Manager")
EXCLUDE: Navigation ("Home", "About"), CTAs ("Apply Now", "Learn More")

Use the extract_jobs function to return your findings.""",
                        },
                    ],
                    "functions": [
                        {
                            "name": "extract_jobs",
                            "description": "Extract job listings from career page",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "jobs": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "title": {"type": "string"},
                                                "description": {"type": "string"},
                                                "url": {"type": "string"},
                                                "location": {"type": "string"},
                                                "salary": {"type": "string"},
                                                "type": {"type": "string"},
                                                "posted_at": {"type": "string"},
                                                "id": {"type": "string"},
                                            },
                                            "required": ["title"],
                                        },
                                    }
                                },
                                "required": ["jobs"],
                            },
                        }
                    ],
                    "function_call": {"name": "extract_jobs"},
                },
                timeout=60.0,
            )

            data = response.json()

            if "choices" in data and data["choices"]:
                function_call = data["choices"][0]["message"].get("function_call", {})
                if function_call.get("arguments"):
                    result = json.loads(function_call["arguments"])
                    return result.get("jobs", [])

            return []


class AnthropicProvider(LLMProvider):
    """
    Anthropic Claude-based job extraction.

    Uses tool_use for structured output.
    """

    def __init__(self, api_key: str, model: str = "claude-3-haiku-20240307") -> None:
        self.api_key = api_key
        self.model = model

    async def extract_jobs(self, content: PageContent) -> list[dict[str, Any]]:
        """Extract jobs using Claude tool use."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "max_tokens": 4096,
                    "tools": [
                        {
                            "name": "extract_jobs",
                            "description": "Extract job listings from career page content",
                            "input_schema": {
                                "type": "object",
                                "properties": {
                                    "jobs": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "title": {"type": "string"},
                                                "description": {"type": "string"},
                                                "url": {"type": "string"},
                                                "location": {"type": "string"},
                                                "salary": {"type": "string"},
                                                "type": {"type": "string"},
                                                "posted_at": {"type": "string"},
                                                "id": {"type": "string"},
                                            },
                                            "required": ["title"],
                                        },
                                    }
                                },
                                "required": ["jobs"],
                            },
                        }
                    ],
                    "tool_choice": {"type": "tool", "name": "extract_jobs"},
                    "messages": [
                        {
                            "role": "user",
                            "content": f"""\
Extract all job listings from this career page.

## INPUT DATA

**URL:** {content.url}

### Page Content:
{content.text[:30000]}

### Links Found:
{json.dumps(content.links[:100], indent=2)}

---

## YOUR ANALYSIS PROCESS

Think through this step by step:

1. **IDENTIFY** - What type of page is this? Job listing or single job?
2. **LOCATE** - Find the job entries (look for repeating patterns)
3. **EXTRACT** - For each job, get: title, url (absolute), location,
   description, salary, type, posted_at, id
4. **VALIDATE** - Are these real jobs? (not navigation, not CTAs)

**Rules:**
- INCLUDE: Actual job titles ("Senior Engineer", "Data Analyst")
- EXCLUDE: Navigation links, generic buttons, category headers
- Make all URLs absolute (prepend the base domain if needed)

Use the extract_jobs tool with your findings.""",
                        }
                    ],
                },
                timeout=60.0,
            )

            data = response.json()

            if "content" in data:
                for block in data["content"]:
                    if block.get("type") == "tool_use" and block.get("name") == "extract_jobs":
                        return block.get("input", {}).get("jobs", [])

            return []


class OpenRouterProvider(LLMProvider):
    """
    OpenRouter-based job extraction.

    Uses OpenAI-compatible API to access various models (Gemini, Claude, etc.)
    """

    def __init__(self, api_key: str, model: str = "google/gemini-2.0-flash-001") -> None:
        self.api_key = api_key
        self.model = model

    async def extract_jobs(self, content: PageContent) -> list[dict[str, Any]]:
        """Extract jobs using OpenRouter API."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://cello.app",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {
                            "role": "user",
                            "content": f"""\
You are an expert job listing extractor. Extract ALL job listings.

## INPUT DATA

**URL:** {content.url}

### Page Content (cleaned):
{content.text[:30000]}

### Links Found (may contain job URLs):
{json.dumps(content.links[:100], indent=2)}

---

## YOUR ANALYSIS PROCESS

<think>
Step 1: IDENTIFY PAGE TYPE
- Is this a job listing page (many jobs) or single job page?
- What ATS or format is used? (Greenhouse, Lever, Workday, custom)

Step 2: LOCATE JOB ENTRIES
- Find repeating patterns (cards, list items, etc.)
- Identify job-related links vs navigation links

Step 3: EXTRACT FOR EACH JOB
- title: Exact job title
- url: Full absolute URL to the job posting
- location: City/State/Remote if mentioned
- description: Brief summary if visible
- salary: Pay range if mentioned
- type: Full-time/Part-time/Contract
- posted_at: Date if visible
- id: Job ID if visible

Step 4: VALIDATE
- Are these real job titles or navigation elements?
- Are URLs pointing to actual job pages?
- Remove duplicates
</think>

---

## EXTRACTION RULES

INCLUDE: Real job titles (e.g., "Senior Engineer", "Product Manager")
EXCLUDE: Navigation ("Home", "About"), CTAs ("Apply Now", "Learn More")

Return ONLY a valid JSON array of job objects. No markdown, no explanation:

[
  {{
    "title": "Job Title",
    "url": "https://...",
    "location": "City, State",
    "description": "...",
    "salary": "...",
    "type": "Full-time",
    "posted_at": "...",
    "id": "..."
  }}
]

If no jobs found, return: []""",
                        },
                    ],
                    "max_tokens": 4096,
                },
                timeout=60.0,
            )

            data = response.json()

            if "choices" in data and data["choices"]:
                content_text = data["choices"][0]["message"].get("content", "")
                # Parse JSON from response
                json_match = re.search(r"\[[\s\S]*\]", content_text)
                if json_match:
                    try:
                        return json.loads(json_match.group())
                    except json.JSONDecodeError:
                        pass

            return []
