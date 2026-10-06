"""Cello Scrapers: fetching careers pages, checking postings, filling applications."""

from .base import BaseScraper
from .types import ScrapedJob, ScrapeResult
from .verification import (
    VerificationResult,
    VerificationStatus,
    quick_verify,
    verify_company,
)

__all__ = [
    "BaseScraper",
    "ScrapedJob",
    "ScrapeResult",
    "verify_company",
    "quick_verify",
    "VerificationResult",
    "VerificationStatus",
]
