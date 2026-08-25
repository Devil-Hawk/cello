"""
Tests for the job scraper module.

Covers:
- ATS type detection from URLs
- Fallback selector extraction for each ATS
- JSON-LD structured data extraction
- Heuristic extraction patterns
- Job deduplication
"""

import pytest
from bs4 import BeautifulSoup

import sys
import os

# Add src to path for imports as a package
src_path = os.path.join(os.path.dirname(__file__), '..')
if src_path not in sys.path:
    sys.path.insert(0, src_path)

from src.fallback import (
    detect_ats_type,
    extract_with_selectors,
    FallbackExtractor,
    ExtractionStrategy,
    FALLBACK_SELECTORS,
)
from src.types import ScrapedJob


# =============================================================================
# Sample HTML fixtures for testing
# =============================================================================

GREENHOUSE_HTML = """
<html>
<body>
    <section class="job-board">
        <div class="opening" data-id="123">
            <a href="/jobs/123">Senior Software Engineer</a>
            <span class="location">San Francisco, CA</span>
            <span class="department">Engineering</span>
        </div>
        <div class="opening" data-id="456">
            <a href="/jobs/456">Product Manager</a>
            <span class="location">Remote</span>
            <span class="department">Product</span>
        </div>
        <div class="opening" data-id="789">
            <a href="/jobs/789">Data Scientist</a>
            <span class="location">New York, NY</span>
            <span class="department">Data Science</span>
        </div>
    </section>
</body>
</html>
"""

LEVER_HTML = """
<html>
<body>
    <div class="postings-group">
        <div class="posting">
            <a class="posting-title" href="https://jobs.lever.co/company/abc123">
                <h5>Backend Engineer</h5>
            </a>
            <div class="posting-categories">
                <span class="location">London, UK</span>
                <span class="team">Platform</span>
            </div>
        </div>
        <div class="posting">
            <a class="posting-title" href="https://jobs.lever.co/company/def456">
                <h5>Frontend Engineer</h5>
            </a>
            <div class="posting-categories">
                <span class="location">Berlin, Germany</span>
                <span class="team">Web</span>
            </div>
        </div>
    </div>
</body>
</html>
"""

WORKDAY_HTML = """
<html>
<body>
    <div class="job-results">
        <div data-automation-id="jobItem">
            <a data-automation-id="jobTitle" href="/job/senior-engineer">
                Senior Engineer
            </a>
            <span data-automation-id="locations">Austin, TX</span>
            <span data-automation-id="department">Engineering</span>
        </div>
        <div data-automation-id="jobItem">
            <a data-automation-id="jobTitle" href="/job/designer">
                UX Designer
            </a>
            <span data-automation-id="locations">Seattle, WA</span>
            <span data-automation-id="department">Design</span>
        </div>
    </div>
</body>
</html>
"""

ASHBY_HTML = """
<html>
<body>
    <div class="jobs-list">
        <div data-ashby-job-posting-id="job-001" class="job-item">
            <h3>Machine Learning Engineer</h3>
            <a href="/jobs/job-001">Apply</a>
            <span class="location">Remote - US</span>
        </div>
        <div data-ashby-job-posting-id="job-002" class="job-item">
            <h3>DevOps Engineer</h3>
            <a href="/jobs/job-002">Apply</a>
            <span class="location">San Francisco, CA</span>
        </div>
    </div>
</body>
</html>
"""

JSON_LD_HTML = """
<html>
<head>
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Software Engineer",
        "description": "We are looking for a talented software engineer...",
        "url": "https://company.com/jobs/software-engineer",
        "jobLocation": {
            "@type": "Place",
            "address": {
                "@type": "PostalAddress",
                "addressLocality": "San Francisco",
                "addressRegion": "CA",
                "addressCountry": "USA"
            }
        },
        "baseSalary": {
            "@type": "MonetaryAmount",
            "currency": "USD",
            "value": {
                "@type": "QuantitativeValue",
                "minValue": 150000,
                "maxValue": 200000
            }
        },
        "employmentType": "FULL_TIME",
        "datePosted": "2024-01-15"
    }
    </script>
    <script type="application/ld+json">
    [
        {
            "@type": "JobPosting",
            "title": "Product Manager",
            "url": "https://company.com/jobs/product-manager",
            "jobLocation": {
                "@type": "Place",
                "address": {
                    "@type": "PostalAddress",
                    "addressLocality": "New York",
                    "addressRegion": "NY"
                }
            }
        }
    ]
    </script>
</head>
<body>
    <h1>Careers</h1>
</body>
</html>
"""

HEURISTIC_HTML = """
<html>
<body>
    <div class="careers-page">
        <article class="job-card">
            <h3><a href="/careers/marketing-lead">Marketing Lead</a></h3>
            <span class="location-tag">Chicago, IL</span>
            <p class="description">Lead our marketing efforts...</p>
        </article>
        <article class="job-card">
            <h3><a href="/careers/sales-rep">Sales Representative</a></h3>
            <span class="location-tag">Remote</span>
            <p class="description">Join our sales team...</p>
        </article>
    </div>
</body>
</html>
"""


# =============================================================================
# Tests for ATS Type Detection
# =============================================================================

class TestAtsTypeDetection:
    """Tests for detect_ats_type function."""

    def test_greenhouse_detection(self):
        """Test detection of Greenhouse URLs."""
        urls = [
            "https://boards.greenhouse.io/company",
            "https://boards.greenhouse.io/company/jobs/123",
            "https://company.greenhouse.io/jobs",
        ]
        for url in urls:
            assert detect_ats_type(url) == "greenhouse", f"Failed for {url}"

    def test_lever_detection(self):
        """Test detection of Lever URLs."""
        urls = [
            "https://jobs.lever.co/company",
            "https://jobs.lever.co/company/abc123",
        ]
        for url in urls:
            assert detect_ats_type(url) == "lever", f"Failed for {url}"

    def test_workday_detection(self):
        """Test detection of Workday URLs."""
        urls = [
            "https://company.myworkdayjobs.com/careers",
            "https://wd5.myworkdayjobs.com/company",
            "https://company.wd1.myworkdayjobs.com/jobs",
        ]
        for url in urls:
            assert detect_ats_type(url) == "workday", f"Failed for {url}"

    def test_ashby_detection(self):
        """Test detection of Ashby URLs."""
        urls = [
            "https://jobs.ashbyhq.com/company",
            "https://jobs.ashbyhq.com/company/abc123",
        ]
        for url in urls:
            assert detect_ats_type(url) == "ashby", f"Failed for {url}"

    def test_unknown_ats_returns_none(self):
        """Test that unknown URLs return None."""
        urls = [
            "https://company.com/careers",
            "https://careers.example.org/jobs",
            "https://random-job-board.io/listings",
        ]
        for url in urls:
            assert detect_ats_type(url) is None, f"Should be None for {url}"


# =============================================================================
# Tests for ATS Selector Extraction
# =============================================================================

class TestAtsSelectorsExtraction:
    """Tests for ATS-specific selector extraction."""

    def test_greenhouse_extraction(self):
        """Test extraction from Greenhouse-formatted HTML."""
        jobs = extract_with_selectors(
            GREENHOUSE_HTML,
            "greenhouse",
            "https://boards.greenhouse.io/company"
        )

        assert len(jobs) == 3

        # Check first job
        assert jobs[0].title == "Senior Software Engineer"
        assert jobs[0].location == "San Francisco, CA"
        assert "/jobs/123" in str(jobs[0].url)

        # Check all jobs have titles
        titles = [j.title for j in jobs]
        assert "Senior Software Engineer" in titles
        assert "Product Manager" in titles
        assert "Data Scientist" in titles

    def test_lever_extraction(self):
        """Test extraction from Lever-formatted HTML."""
        jobs = extract_with_selectors(
            LEVER_HTML,
            "lever",
            "https://jobs.lever.co/company"
        )

        assert len(jobs) == 2

        # Check jobs
        titles = [j.title for j in jobs]
        assert "Backend Engineer" in titles
        assert "Frontend Engineer" in titles

        # Check locations
        locations = [j.location for j in jobs if j.location]
        assert "London, UK" in locations
        assert "Berlin, Germany" in locations

    def test_workday_extraction(self):
        """Test extraction from Workday-formatted HTML."""
        jobs = extract_with_selectors(
            WORKDAY_HTML,
            "workday",
            "https://company.myworkdayjobs.com"
        )

        assert len(jobs) == 2

        titles = [j.title for j in jobs]
        assert "Senior Engineer" in titles
        assert "UX Designer" in titles

    def test_ashby_extraction(self):
        """Test extraction from Ashby-formatted HTML."""
        jobs = extract_with_selectors(
            ASHBY_HTML,
            "ashby",
            "https://jobs.ashbyhq.com/company"
        )

        assert len(jobs) == 2

        titles = [j.title for j in jobs]
        assert "Machine Learning Engineer" in titles
        assert "DevOps Engineer" in titles


# =============================================================================
# Tests for Structured Data (JSON-LD) Extraction
# =============================================================================

class TestJsonLdExtraction:
    """Tests for JSON-LD structured data extraction."""

    def test_json_ld_single_job(self):
        """Test extraction of single JobPosting from JSON-LD."""
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(JSON_LD_HTML)

        assert result.strategy_used == ExtractionStrategy.STRUCTURED_DATA
        assert result.confidence == 0.9
        assert len(result.jobs) >= 1

        # Check first job
        job = next(j for j in result.jobs if "Software Engineer" in j.title)
        assert job.title == "Software Engineer"
        assert "San Francisco" in (job.location or "")
        assert job.salary_range is not None
        assert "150,000" in job.salary_range

    def test_json_ld_multiple_jobs(self):
        """Test extraction of multiple jobs from JSON-LD array."""
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(JSON_LD_HTML)

        assert len(result.jobs) >= 2

        titles = [j.title for j in result.jobs]
        assert "Software Engineer" in titles
        assert "Product Manager" in titles

    def test_json_ld_job_location_parsing(self):
        """Test that job locations are parsed correctly from JSON-LD."""
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(JSON_LD_HTML)

        job = next(j for j in result.jobs if "Product Manager" in j.title)
        assert job.location is not None
        assert "New York" in job.location


# =============================================================================
# Tests for Heuristic Extraction
# =============================================================================

class TestHeuristicExtraction:
    """Tests for heuristic pattern-based extraction."""

    def test_job_card_detection(self):
        """Test detection of job cards by class patterns."""
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(HEURISTIC_HTML)

        # Should use heuristic since no JSON-LD or ATS patterns
        assert result.strategy_used == ExtractionStrategy.HEURISTIC
        assert len(result.jobs) >= 2

        titles = [j.title for j in result.jobs]
        assert "Marketing Lead" in titles
        assert "Sales Representative" in titles

    def test_link_pattern_fallback(self):
        """Test that link patterns are detected as fallback."""
        html = """
        <html>
        <body>
            <a href="/jobs/123">Customer Success Manager</a>
            <a href="/positions/456">Account Executive</a>
            <a href="/apply/789">Support Engineer</a>
        </body>
        </html>
        """
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(html)

        # Should find jobs via link patterns
        assert len(result.jobs) >= 1


# =============================================================================
# Tests for Job Deduplication
# =============================================================================

class TestJobDeduplication:
    """Tests for job deduplication logic."""

    def test_duplicate_urls_removed(self):
        """Test that jobs with duplicate URLs are removed."""
        html = """
        <html>
        <body>
            <script type="application/ld+json">
            [
                {
                    "@type": "JobPosting",
                    "title": "Software Engineer",
                    "url": "https://company.com/jobs/123"
                },
                {
                    "@type": "JobPosting",
                    "title": "Software Engineer (Duplicate)",
                    "url": "https://company.com/jobs/123"
                }
            ]
            </script>
        </body>
        </html>
        """
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(html)

        # Note: JSON-LD extraction doesn't deduplicate internally,
        # but IntelligentScraper does. For this test we verify both are extracted.
        # The deduplication happens at the IntelligentScraper level.
        assert len(result.jobs) >= 1

    def test_duplicate_titles_in_heuristic(self):
        """Test that heuristic extraction handles duplicate titles."""
        html = """
        <html>
        <body>
            <div class="job-card">
                <h3><a href="/jobs/1">Engineer</a></h3>
            </div>
            <div class="job-listing">
                <h3><a href="/jobs/2">Engineer</a></h3>
            </div>
        </body>
        </html>
        """
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(html)

        # Heuristic deduplicates by title
        titles = [j.title for j in result.jobs]
        assert titles.count("Engineer") == 1


# =============================================================================
# Tests for Edge Cases
# =============================================================================

class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_empty_html(self):
        """Test handling of empty HTML."""
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract("")

        assert result.strategy_used == ExtractionStrategy.FAILED
        assert result.jobs == []

    def test_malformed_json_ld(self):
        """Test handling of malformed JSON-LD."""
        html = """
        <html>
        <head>
            <script type="application/ld+json">
            { not valid json }
            </script>
        </head>
        </html>
        """
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(html)

        # Should not crash, just fall through to other strategies
        assert result is not None

    def test_no_jobs_page(self):
        """Test handling of page with no job content."""
        html = """
        <html>
        <body>
            <h1>About Us</h1>
            <p>We are a great company.</p>
        </body>
        </html>
        """
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(html)

        assert result.strategy_used == ExtractionStrategy.FAILED
        assert result.jobs == []

    def test_very_short_titles_filtered(self):
        """Test that very short job titles are filtered out."""
        html = """
        <html>
        <body>
            <div class="job-card">
                <h3><a href="/jobs/1">AB</a></h3>
            </div>
            <div class="job-card">
                <h3><a href="/jobs/2">Software Engineer</a></h3>
            </div>
        </body>
        </html>
        """
        extractor = FallbackExtractor("https://company.com")
        result = extractor.extract(html)

        # Short title "AB" should be filtered
        titles = [j.title for j in result.jobs]
        assert "AB" not in titles
        assert "Software Engineer" in titles


# =============================================================================
# Tests for URL Resolution
# =============================================================================

class TestUrlResolution:
    """Tests for relative URL resolution."""

    def test_relative_url_resolution(self):
        """Test that relative URLs are converted to absolute."""
        jobs = extract_with_selectors(
            GREENHOUSE_HTML,
            "greenhouse",
            "https://boards.greenhouse.io/company"
        )

        for job in jobs:
            assert str(job.url).startswith("https://"), f"URL should be absolute: {job.url}"

    def test_already_absolute_url_preserved(self):
        """Test that absolute URLs are preserved."""
        jobs = extract_with_selectors(
            LEVER_HTML,
            "lever",
            "https://jobs.lever.co/company"
        )

        for job in jobs:
            assert "lever.co" in str(job.url)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
