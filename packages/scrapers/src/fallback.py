"""
Fallback Scraping Strategies - Graceful degradation when intelligent scraping fails.

The scraper attempts strategies in order:
1. AI-powered extraction (best quality)
2. Structured data extraction (JSON-LD, microdata)
3. Heuristic extraction (pattern matching)
4. Link extraction (minimal, just job URLs)

Each level provides progressively less data but more reliability.
"""

import contextlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from bs4 import BeautifulSoup

from .types import ScrapedJob

# ATS-specific CSS selectors for reliable extraction
FALLBACK_SELECTORS = {
    "greenhouse": {
        "job_container": ".opening",
        "title": ".opening a",
        "location": ".location",
        "department": ".department",
        "url": ".opening a",
    },
    "lever": {
        "job_container": ".posting",
        "title": ".posting-title h5",
        "location": ".posting-categories .location",
        "department": ".posting-categories .team",
        "url": ".posting-title a, .posting-btn-submit",
    },
    "workday": {
        "job_container": '[data-automation-id="jobItem"], .WGDC-job-item',
        "title": '[data-automation-id="jobTitle"], .WGDC-job-item-title',
        "location": '[data-automation-id="locations"], .WGDC-job-item-location',
        "department": '[data-automation-id="department"]',
        "url": '[data-automation-id="jobTitle"] a, .WGDC-job-item-title a',
    },
    "ashby": {
        "job_container": "[data-ashby-job-posting-id], .ashby-job-posting-brief-list-item",
        "title": "h3, .ashby-job-posting-brief-title",
        "location": ".location, .ashby-job-posting-brief-location",
        "department": ".ashby-job-posting-brief-team",
        "url": 'a[href*="/jobs/"]',
    },
    "bamboohr": {
        "job_container": ".BambooHR-ATS-board__item, .resJobListing",
        "title": ".BambooHR-ATS-board__item-title, .resJobListing a",
        "location": ".BambooHR-ATS-board__item-location, .resJobLocation",
        "department": ".BambooHR-ATS-board__item-department",
        "url": ".BambooHR-ATS-board__item-title a, .resJobListing a",
    },
    "smartrecruiters": {
        "job_container": ".js-job-list-row, .opening-job",
        "title": ".js-job-list-row-title, .opening-job-title",
        "location": ".js-job-list-row-location, .opening-job-location",
        "department": ".js-job-list-row-department, .opening-job-department",
        "url": ".js-job-list-row-title a, .opening-job-title a",
    },
}

# URL patterns to detect ATS type
ATS_URL_PATTERNS = {
    "greenhouse": [
        r"boards\.greenhouse\.io",
        r"\.greenhouse\.io",
        r"greenhouse\.io/[^/]+/jobs",
    ],
    "lever": [
        r"jobs\.lever\.co",
        r"lever\.co/",
    ],
    "workday": [
        r"\.myworkdayjobs\.com",
        r"workday\.com/[^/]+/d/jobs",
        r"wd\d+\.myworkdayjobs\.com",
    ],
    "ashby": [
        r"jobs\.ashbyhq\.com",
        r"ashbyhq\.com/",
    ],
    "bamboohr": [
        r"\.bamboohr\.com/jobs",
        r"bamboohr\.com/careers",
    ],
    "smartrecruiters": [
        r"jobs\.smartrecruiters\.com",
        r"smartrecruiters\.com/",
    ],
}


def detect_ats_type(url: str) -> str | None:
    """
    Detect the ATS (Applicant Tracking System) type from a URL.

    Returns the ATS type string (e.g., 'greenhouse', 'lever') or None if unknown.
    """
    url_lower = url.lower()

    for ats_type, patterns in ATS_URL_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, url_lower):
                return ats_type

    return None


class ExtractionStrategy(str, Enum):
    AI_POWERED = "ai_powered"
    STRUCTURED_DATA = "structured_data"
    ATS_SELECTORS = "ats_selectors"
    HEURISTIC = "heuristic"
    LINK_ONLY = "link_only"
    FAILED = "failed"


@dataclass
class FallbackResult:
    """Result of fallback extraction."""

    strategy_used: ExtractionStrategy
    jobs: list[ScrapedJob]
    confidence: float
    error: str | None = None


class FallbackExtractor:
    """
    Multi-strategy job extractor with graceful degradation.

    If one strategy fails, automatically tries the next one.
    """

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url

    def extract(self, html: str) -> FallbackResult:
        """
        Try extraction strategies in order of quality.
        """
        soup = BeautifulSoup(html, "lxml")

        # Strategy 1: Structured Data (JSON-LD)
        try:
            jobs = self._extract_structured_data(soup)
            if jobs:
                return FallbackResult(
                    strategy_used=ExtractionStrategy.STRUCTURED_DATA,
                    jobs=jobs,
                    confidence=0.9,
                )
        except Exception:
            pass  # Fall through to next strategy

        # Strategy 2: ATS-specific selector extraction
        try:
            ats_type = detect_ats_type(self.base_url)
            if ats_type:
                jobs = self._extract_with_ats_selectors(soup, ats_type)
                if jobs:
                    return FallbackResult(
                        strategy_used=ExtractionStrategy.ATS_SELECTORS,
                        jobs=jobs,
                        confidence=0.85,
                    )
        except Exception:
            pass  # Fall through to next strategy

        # Strategy 3: Heuristic Pattern Matching
        try:
            jobs = self._extract_heuristic(soup)
            if jobs:
                return FallbackResult(
                    strategy_used=ExtractionStrategy.HEURISTIC,
                    jobs=jobs,
                    confidence=0.7,
                )
        except Exception:
            pass

        # Strategy 4: Link-only extraction (minimal)
        try:
            jobs = self._extract_job_links(soup)
            if jobs:
                return FallbackResult(
                    strategy_used=ExtractionStrategy.LINK_ONLY,
                    jobs=jobs,
                    confidence=0.4,
                )
        except Exception:
            pass

        # All strategies failed
        return FallbackResult(
            strategy_used=ExtractionStrategy.FAILED,
            jobs=[],
            confidence=0.0,
            error="All extraction strategies failed",
        )

    def _extract_structured_data(self, soup: BeautifulSoup) -> list[ScrapedJob]:
        """
        Extract jobs from JSON-LD structured data.

        Many career pages include schema.org JobPosting markup.
        This is the most reliable extraction method.
        """
        jobs = []

        # Find all JSON-LD scripts
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string)

                # Handle both single objects and arrays
                if isinstance(data, list):
                    items = data
                elif isinstance(data, dict):
                    # Check for @graph pattern
                    items = data.get("@graph", [data])
                else:
                    continue

                for item in items:
                    if not isinstance(item, dict):
                        continue

                    item_type = item.get("@type", "")
                    if item_type == "JobPosting" or "JobPosting" in str(item_type):
                        job = self._parse_job_posting(item)
                        if job:
                            jobs.append(job)

            except (json.JSONDecodeError, AttributeError):
                continue

        return jobs

    def _extract_with_ats_selectors(self, soup: BeautifulSoup, ats_type: str) -> list[ScrapedJob]:
        """
        Extract jobs using ATS-specific CSS selectors.

        This provides reliable extraction for known ATS platforms.
        """
        jobs = []
        selectors = FALLBACK_SELECTORS.get(ats_type, {})

        if not selectors:
            return jobs

        container_selector = selectors.get("job_container", "")
        if not container_selector:
            return jobs

        # Find all job containers
        containers = soup.select(container_selector)

        for container in containers[:100]:  # Limit to 100 jobs
            try:
                # Extract title
                title = None
                title_selector = selectors.get("title", "")
                if title_selector:
                    title_elem = container.select_one(title_selector)
                    if title_elem:
                        title = title_elem.get_text(strip=True)

                if not title:
                    # Fallback: try to get title from any heading or first link
                    title_elem = container.find(["h1", "h2", "h3", "h4"]) or container.find("a")
                    if title_elem:
                        title = title_elem.get_text(strip=True)

                if not title or len(title) < 3:
                    continue

                # Extract URL
                url = None
                url_selector = selectors.get("url", "")
                if url_selector:
                    url_elem = container.select_one(url_selector)
                    if url_elem:
                        url = url_elem.get("href")

                if not url:
                    # Fallback: look for any link
                    link = container.find("a", href=True)
                    if link:
                        url = link.get("href")

                url = self._make_absolute_url(url) if url else self.base_url

                # Extract location
                location = None
                location_selector = selectors.get("location", "")
                if location_selector:
                    location_elem = container.select_one(location_selector)
                    if location_elem:
                        location = location_elem.get_text(strip=True)

                # Extract department
                department = None
                department_selector = selectors.get("department", "")
                if department_selector:
                    department_elem = container.select_one(department_selector)
                    if department_elem:
                        department = department_elem.get_text(strip=True)

                jobs.append(
                    ScrapedJob(
                        title=title,
                        description=f"Department: {department}" if department else "",
                        url=url,
                        location=location,
                    )
                )

            except Exception:
                continue

        return jobs

    def _parse_job_posting(self, data: dict) -> ScrapedJob | None:
        """Parse a schema.org JobPosting object."""
        title = data.get("title") or data.get("name")
        if not title:
            return None

        description = data.get("description", "")

        # Get URL
        url = data.get("url") or data.get("sameAs") or self.base_url

        # Get location
        location = None
        job_location = data.get("jobLocation")
        if isinstance(job_location, dict):
            address = job_location.get("address", {})
            if isinstance(address, dict):
                parts = [
                    address.get("addressLocality"),
                    address.get("addressRegion"),
                    address.get("addressCountry"),
                ]
                location = ", ".join(p for p in parts if p)
            elif isinstance(address, str):
                location = address

        # Get salary
        salary = None
        base_salary = data.get("baseSalary")
        if isinstance(base_salary, dict):
            value = base_salary.get("value", {})
            if isinstance(value, dict):
                min_val = value.get("minValue")
                max_val = value.get("maxValue")
                currency = base_salary.get("currency", "USD")
                if min_val and max_val:
                    salary = f"{currency} {min_val:,} - {max_val:,}"
                elif min_val:
                    salary = f"{currency} {min_val:,}+"

        # Get job type
        job_type = data.get("employmentType")
        if isinstance(job_type, list):
            job_type = job_type[0] if job_type else None

        # Get posted date
        posted_at = None
        date_posted = data.get("datePosted")
        if date_posted:
            with contextlib.suppress(ValueError):
                posted_at = datetime.fromisoformat(date_posted.replace("Z", "+00:00"))

        # Get ID
        external_id = data.get("identifier")
        if isinstance(external_id, dict):
            external_id = external_id.get("value")

        return ScrapedJob(
            title=title,
            description=description[:5000],  # Limit description
            url=url,
            location=location,
            salary_range=salary,
            job_type=job_type,
            posted_at=posted_at,
            external_id=str(external_id) if external_id else None,
        )

    def _extract_heuristic(self, soup: BeautifulSoup) -> list[ScrapedJob]:
        """
        Extract jobs using common HTML patterns.

        Looks for:
        - Lists of job cards
        - Tables with job listings
        - Repeated elements with job-like content
        """
        jobs = []
        seen_titles = set()

        # Pattern 1: Look for job card containers
        job_selectors = [
            "[class*='job-card']",
            "[class*='job-listing']",
            "[class*='job-item']",
            "[class*='position-card']",
            "[class*='career-item']",
            "[class*='opening']",
            "article[class*='job']",
            "li[class*='job']",
        ]

        for selector in job_selectors:
            cards = soup.select(selector)
            for card in cards[:50]:  # Limit per selector
                job = self._parse_job_card(card)
                if job and job.title not in seen_titles:
                    seen_titles.add(job.title)
                    jobs.append(job)

        # Pattern 2: Look for job links with common patterns
        if not jobs:
            job_links = soup.find_all(
                "a", href=re.compile(r"(job|position|career|opening|apply)[s]?[/-]", re.IGNORECASE)
            )
            for link in job_links[:30]:
                title = link.get_text(strip=True)
                href = link.get("href", "")

                if title and len(title) > 5 and len(title) < 100 and title not in seen_titles:
                    seen_titles.add(title)
                    jobs.append(
                        ScrapedJob(
                            title=title,
                            description="",
                            url=self._make_absolute_url(href),
                        )
                    )

        return jobs

    def _parse_job_card(self, card: BeautifulSoup) -> ScrapedJob | None:
        """Parse a job from a card-like HTML element."""
        # Find title (usually in h2, h3, or a link)
        title_elem = card.find(["h1", "h2", "h3", "h4"]) or card.find("a")
        if not title_elem:
            return None

        title = title_elem.get_text(strip=True)
        if not title or len(title) < 3:
            return None

        # Get URL from title link or card link
        url = None
        if title_elem.name == "a":
            url = title_elem.get("href")
        else:
            link = card.find("a")
            if link:
                url = link.get("href")

        url = self._make_absolute_url(url) if url else self.base_url

        # Get location
        location = None
        location_elem = card.find(class_=re.compile(r"location|city|place", re.I))
        if location_elem:
            location = location_elem.get_text(strip=True)

        # Get job type
        job_type = None
        type_elem = card.find(class_=re.compile(r"type|employment|full|part|remote", re.I))
        if type_elem:
            job_type = type_elem.get_text(strip=True)

        # Get description snippet
        desc_elem = card.find(class_=re.compile(r"desc|summary|excerpt", re.I))
        description = desc_elem.get_text(strip=True) if desc_elem else ""

        return ScrapedJob(
            title=title,
            description=description[:1000],
            url=url,
            location=location,
            job_type=job_type,
        )

    def _extract_job_links(self, soup: BeautifulSoup) -> list[ScrapedJob]:
        """
        Minimal extraction - just find links that look like job postings.

        This is the fallback of last resort.
        """
        jobs = []
        seen_urls = set()

        # Keywords that indicate job detail pages
        job_url_patterns = [
            r"/job[s]?/",
            r"/position[s]?/",
            r"/career[s]?/",
            r"/opening[s]?/",
            r"/apply/",
            r"/role[s]?/",
            r"job[_-]?id=",
            r"position[_-]?id=",
        ]

        pattern = re.compile("|".join(job_url_patterns), re.IGNORECASE)

        for link in soup.find_all("a", href=True):
            href = link.get("href", "")
            text = link.get_text(strip=True)

            if pattern.search(href) and text:
                url = self._make_absolute_url(href)
                if url not in seen_urls and len(text) > 3 and len(text) < 150:
                    seen_urls.add(url)
                    jobs.append(
                        ScrapedJob(
                            title=text,
                            description="",
                            url=url,
                        )
                    )

        return jobs[:50]  # Limit results

    def _make_absolute_url(self, url: str | None) -> str:
        """Convert relative URL to absolute."""
        if not url:
            return self.base_url

        if url.startswith("http"):
            return url

        from urllib.parse import urljoin

        return urljoin(self.base_url, url)


def extract_with_fallback(
    html: str,
    base_url: str,
    ai_jobs: list[ScrapedJob] | None = None,
) -> FallbackResult:
    """
    Combined extraction that uses AI results with fallback.

    If AI extraction succeeded, returns those results.
    Otherwise, tries fallback strategies.
    """
    # If AI provided results, use them
    if ai_jobs:
        return FallbackResult(
            strategy_used=ExtractionStrategy.AI_POWERED,
            jobs=ai_jobs,
            confidence=0.95,
        )

    # Otherwise, use fallback extractor
    extractor = FallbackExtractor(base_url)
    return extractor.extract(html)


def extract_with_selectors(html: str, ats_type: str, base_url: str) -> list[ScrapedJob]:
    """
    Extract jobs using ATS-specific selectors.

    Convenience function for direct ATS selector extraction.

    Args:
        html: The HTML content to parse
        ats_type: The ATS type (e.g., 'greenhouse', 'lever')
        base_url: The base URL for resolving relative links

    Returns:
        List of extracted jobs
    """
    extractor = FallbackExtractor(base_url)
    soup = BeautifulSoup(html, "lxml")
    return extractor._extract_with_ats_selectors(soup, ats_type)
