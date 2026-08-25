"""
Company Verification - Validates career page URLs before tracking.

Checks:
1. URL is reachable
2. Page contains job-related content
3. Page is not a generic error/redirect
4. Company domain is legitimate (optional Clearbit check)
"""

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

import httpx
from bs4 import BeautifulSoup


class VerificationStatus(str, Enum):
    VERIFIED = "verified"
    UNREACHABLE = "unreachable"
    NO_JOBS_FOUND = "no_jobs_found"
    REDIRECT_LOOP = "redirect_loop"
    INVALID_CONTENT = "invalid_content"
    RATE_LIMITED = "rate_limited"
    UNKNOWN_ERROR = "unknown_error"


@dataclass
class VerificationResult:
    """Result of company/career page verification."""

    status: VerificationStatus
    is_valid: bool
    career_url: str
    final_url: str | None  # After redirects
    company_name: str | None
    logo_url: str | None
    job_count_estimate: int
    confidence: float  # 0.0 to 1.0
    message: str
    verified_at: datetime
    checks_passed: list[str]
    checks_failed: list[str]


# Keywords that indicate job content
JOB_KEYWORDS = [
    "career",
    "careers",
    "job",
    "jobs",
    "position",
    "positions",
    "opening",
    "openings",
    "opportunity",
    "opportunities",
    "hiring",
    "join us",
    "work with us",
    "employment",
    "apply",
    "application",
    "applicant",
    "resume",
    "cv",
    "full-time",
    "full time",
    "part-time",
    "part time",
    "remote",
    "hybrid",
    "onsite",
    "on-site",
    "engineering",
    "design",
    "product",
    "marketing",
    "sales",
]

# Keywords that indicate NOT a valid job page
NEGATIVE_KEYWORDS = [
    "404",
    "not found",
    "page not found",
    "error",
    "access denied",
    "forbidden",
    "login required",
    "coming soon",
    "under construction",
]


async def verify_company(
    career_url: str,
    timeout: float = 15.0,
    check_clearbit: bool = True,
) -> VerificationResult:
    """
    Verify a company's career page is valid and contains job listings.

    This is called when a user adds a new company to track.
    """
    checks_passed = []
    checks_failed = []

    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            max_redirects=5,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
                ),
            },
        ) as client:
            # Step 1: Check URL is reachable
            try:
                response = await client.get(career_url)
                final_url = str(response.url)

                if response.status_code == 200:
                    checks_passed.append("url_reachable")
                elif response.status_code == 429:
                    return VerificationResult(
                        status=VerificationStatus.RATE_LIMITED,
                        is_valid=False,
                        career_url=career_url,
                        final_url=final_url,
                        company_name=None,
                        logo_url=None,
                        job_count_estimate=0,
                        confidence=0.0,
                        message="Rate limited by the server. Try again later.",
                        verified_at=datetime.utcnow(),
                        checks_passed=checks_passed,
                        checks_failed=["rate_limited"],
                    )
                else:
                    checks_failed.append(f"http_status_{response.status_code}")
                    return VerificationResult(
                        status=VerificationStatus.UNREACHABLE,
                        is_valid=False,
                        career_url=career_url,
                        final_url=final_url,
                        company_name=None,
                        logo_url=None,
                        job_count_estimate=0,
                        confidence=0.0,
                        message=f"URL returned status {response.status_code}",
                        verified_at=datetime.utcnow(),
                        checks_passed=checks_passed,
                        checks_failed=checks_failed,
                    )
            except httpx.TooManyRedirects:
                return VerificationResult(
                    status=VerificationStatus.REDIRECT_LOOP,
                    is_valid=False,
                    career_url=career_url,
                    final_url=None,
                    company_name=None,
                    logo_url=None,
                    job_count_estimate=0,
                    confidence=0.0,
                    message="Too many redirects. URL may be invalid.",
                    verified_at=datetime.utcnow(),
                    checks_passed=checks_passed,
                    checks_failed=["redirect_loop"],
                )
            except (httpx.ConnectError, httpx.ConnectTimeout):
                return VerificationResult(
                    status=VerificationStatus.UNREACHABLE,
                    is_valid=False,
                    career_url=career_url,
                    final_url=None,
                    company_name=None,
                    logo_url=None,
                    job_count_estimate=0,
                    confidence=0.0,
                    message="Could not connect to the URL. Check if it's correct.",
                    verified_at=datetime.utcnow(),
                    checks_passed=checks_passed,
                    checks_failed=["connection_failed"],
                )

            # Step 2: Parse content
            html = response.text
            soup = BeautifulSoup(html, "lxml")
            text = soup.get_text(separator=" ", strip=True).lower()

            # Check for negative keywords (error pages)
            for keyword in NEGATIVE_KEYWORDS:
                if keyword in text[:500]:  # Check beginning of page
                    checks_failed.append(f"negative_keyword_{keyword}")

            if not checks_failed:
                checks_passed.append("no_error_indicators")

            # Step 3: Check for job-related content
            job_keyword_matches = sum(1 for kw in JOB_KEYWORDS if kw in text)

            if job_keyword_matches >= 3:
                checks_passed.append("job_keywords_found")
            elif job_keyword_matches >= 1:
                checks_passed.append("some_job_keywords")
            else:
                checks_failed.append("no_job_keywords")

            # Step 4: Estimate job count (look for list patterns)
            job_count_estimate = _estimate_job_count(soup, text)

            if job_count_estimate > 0:
                checks_passed.append(f"jobs_detected_{job_count_estimate}")
            else:
                checks_failed.append("no_jobs_detected")

            # Step 5: Extract company info
            company_name = _extract_company_name(soup, career_url)
            logo_url = None

            # Google favicon service always serves an icon, no existence check needed
            if check_clearbit:
                domain = _extract_domain(career_url)
                if domain:
                    logo_url = f"https://www.google.com/s2/favicons?domain={domain}&sz=128"

            # Calculate confidence score
            confidence = _calculate_confidence(checks_passed, checks_failed, job_keyword_matches)

            # Determine final status
            if confidence >= 0.7:
                status = VerificationStatus.VERIFIED
                is_valid = True
                message = f"Verified career page with ~{job_count_estimate} jobs detected."
            elif confidence >= 0.4:
                status = VerificationStatus.VERIFIED
                is_valid = True
                message = "Career page looks valid but might not have structured job listings."
            elif job_keyword_matches == 0:
                status = VerificationStatus.NO_JOBS_FOUND
                is_valid = False
                message = "This doesn't look like a career page. Check the URL."
            else:
                status = VerificationStatus.INVALID_CONTENT
                is_valid = False
                message = "Page exists but doesn't appear to contain job listings."

            return VerificationResult(
                status=status,
                is_valid=is_valid,
                career_url=career_url,
                final_url=final_url,
                company_name=company_name,
                logo_url=logo_url,
                job_count_estimate=job_count_estimate,
                confidence=confidence,
                message=message,
                verified_at=datetime.utcnow(),
                checks_passed=checks_passed,
                checks_failed=checks_failed,
            )

    except Exception as e:
        return VerificationResult(
            status=VerificationStatus.UNKNOWN_ERROR,
            is_valid=False,
            career_url=career_url,
            final_url=None,
            company_name=None,
            logo_url=None,
            job_count_estimate=0,
            confidence=0.0,
            message=f"Verification failed: {str(e)}",
            verified_at=datetime.utcnow(),
            checks_passed=checks_passed,
            checks_failed=["exception_" + type(e).__name__],
        )


def _estimate_job_count(soup: BeautifulSoup, text: str) -> int:
    """Estimate number of jobs on the page."""
    count = 0

    # Look for common job listing patterns
    # Method 1: Count links with job-like text
    job_links = soup.find_all("a", href=True)
    for link in job_links:
        link_text = link.get_text(strip=True).lower()
        href = link.get("href", "").lower()
        if any(kw in link_text or kw in href for kw in ["job", "position", "apply", "role"]):
            count += 1

    # Method 2: Look for repeated list items (job cards)
    for tag in ["li", "article", "div"]:
        items = soup.find_all(
            tag,
            class_=lambda x: x
            and any(
                term in str(x).lower() for term in ["job", "position", "listing", "opening", "card"]
            ),
        )
        if len(items) > count:
            count = len(items)

    # Method 3: Count numbers mentioned near "jobs" or "positions"
    number_pattern = re.search(r"(\d+)\s*(?:jobs?|positions?|openings?|opportunities)", text)
    if number_pattern:
        mentioned_count = int(number_pattern.group(1))
        if mentioned_count > count:
            count = mentioned_count

    return min(count, 500)  # Cap at reasonable number


def _extract_company_name(soup: BeautifulSoup, url: str) -> str | None:
    """Try to extract company name from page."""
    # Method 1: og:site_name
    og_site = soup.find("meta", property="og:site_name")
    if og_site and og_site.get("content"):
        return og_site["content"]

    # Method 2: Title tag (often "Careers at Company" or "Company Careers")
    if soup.title:
        title = soup.title.string or ""
        # Remove common suffixes
        for suffix in [" Careers", " Jobs", " - Careers", " | Careers", " - Jobs", " | Jobs"]:
            if suffix.lower() in title.lower():
                name = title.lower().replace(suffix.lower(), "").strip()
                return name.title()

    # Method 3: From domain
    domain = _extract_domain(url)
    if domain:
        # Remove common TLDs and www
        name = domain.replace("www.", "").split(".")[0]
        return name.title()

    return None


def _extract_domain(url: str) -> str | None:
    """Extract domain from URL."""
    try:
        from urllib.parse import urlparse

        parsed = urlparse(url)
        domain = parsed.netloc
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return None


def _calculate_confidence(
    passed: list[str],
    failed: list[str],
    keyword_matches: int,
) -> float:
    """Calculate confidence score (0.0 to 1.0)."""
    score = 0.5  # Start at middle

    # Boost for passed checks
    if "url_reachable" in passed:
        score += 0.1
    if "job_keywords_found" in passed:
        score += 0.2
    elif "some_job_keywords" in passed:
        score += 0.1
    if "no_error_indicators" in passed:
        score += 0.1
    if any("jobs_detected" in p for p in passed):
        score += 0.2

    # Penalty for failed checks
    if "no_job_keywords" in failed:
        score -= 0.3
    if "no_jobs_detected" in failed:
        score -= 0.2
    for f in failed:
        if f.startswith("negative_keyword"):
            score -= 0.2
            break

    # Bonus for many keyword matches
    if keyword_matches >= 5:
        score += 0.1

    return max(0.0, min(1.0, score))


# Convenience function for API
async def quick_verify(url: str) -> dict[str, Any]:
    """Quick verification returning a simple dict (for API use)."""
    result = await verify_company(url)
    return {
        "is_valid": result.is_valid,
        "status": result.status.value,
        "message": result.message,
        "company_name": result.company_name,
        "logo_url": result.logo_url,
        "job_count": result.job_count_estimate,
        "confidence": round(result.confidence, 2),
    }
