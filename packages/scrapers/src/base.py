"""Base scraper class for job boards."""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any

import httpx

from .types import ScrapedJob, ScrapeResult


class BaseScraper(ABC):
    """
    Base class for all job scrapers.

    Subclasses must implement the `parse_jobs` method to extract jobs
    from the career page HTML.
    """

    def __init__(
        self,
        company_id: str,
        career_url: str,
        timeout: float = 30.0,
    ) -> None:
        self.company_id = company_id
        self.career_url = career_url
        self.timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "BaseScraper":
        self._client = httpx.AsyncClient(
            timeout=self.timeout,
            follow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            },
        )
        return self

    async def __aexit__(self, *args: Any) -> None:
        if self._client:
            await self._client.aclose()

    @abstractmethod
    async def parse_jobs(self, html: str) -> list[ScrapedJob]:
        """
        Parse job listings from HTML content.

        Args:
            html: The HTML content of the career page.

        Returns:
            List of scraped job objects.
        """
        ...

    async def scrape(self) -> ScrapeResult:
        """
        Scrape jobs from the career page.

        Returns:
            ScrapeResult with the scraped jobs or error information.
        """
        start_time = datetime.utcnow()

        try:
            if not self._client:
                raise RuntimeError("Scraper must be used as async context manager")

            response = await self._client.get(self.career_url)
            response.raise_for_status()

            jobs = await self.parse_jobs(response.text)

            end_time = datetime.utcnow()
            duration_ms = int((end_time - start_time).total_seconds() * 1000)

            return ScrapeResult(
                company_id=self.company_id,
                success=True,
                jobs=jobs,
                scraped_at=end_time,
                duration_ms=duration_ms,
            )

        except Exception as e:
            end_time = datetime.utcnow()
            duration_ms = int((end_time - start_time).total_seconds() * 1000)

            return ScrapeResult(
                company_id=self.company_id,
                success=False,
                error=str(e),
                scraped_at=end_time,
                duration_ms=duration_ms,
            )
