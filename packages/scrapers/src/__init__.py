"""Cello Scrapers - Intelligent job board scraping utilities."""

from .base import BaseScraper
from .fallback import (
    FALLBACK_SELECTORS,
    ExtractionStrategy,
    FallbackExtractor,
    FallbackResult,
    detect_ats_type,
    extract_with_fallback,
    extract_with_selectors,
)
from .intelligent import (
    AnthropicProvider,
    IntelligentScraper,
    LLMProvider,
    OpenAIProvider,
    PageContent,
)
from .types import ScrapedJob, ScrapeResult
from .verification import (
    VerificationResult,
    VerificationStatus,
    quick_verify,
    verify_company,
)

__all__ = [
    # Core
    "BaseScraper",
    "ScrapedJob",
    "ScrapeResult",
    # Intelligent scraping
    "IntelligentScraper",
    "LLMProvider",
    "OpenAIProvider",
    "AnthropicProvider",
    "PageContent",
    # Verification
    "verify_company",
    "quick_verify",
    "VerificationResult",
    "VerificationStatus",
    # Fallback
    "FallbackExtractor",
    "FallbackResult",
    "ExtractionStrategy",
    "extract_with_fallback",
    "extract_with_selectors",
    "detect_ats_type",
    "FALLBACK_SELECTORS",
]
