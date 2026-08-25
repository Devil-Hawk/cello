"""Type definitions for scrapers."""

from datetime import datetime

from pydantic import BaseModel, HttpUrl


class ScrapedJob(BaseModel):
    """A job listing scraped from a career page."""

    title: str
    description: str
    url: HttpUrl
    location: str | None = None
    salary_range: str | None = None
    job_type: str | None = None
    posted_at: datetime | None = None
    external_id: str | None = None  # ID from the source system


class ScrapeResult(BaseModel):
    """Result of a scraping operation."""

    company_id: str
    success: bool
    jobs: list[ScrapedJob] = []
    error: str | None = None
    scraped_at: datetime
    duration_ms: int
