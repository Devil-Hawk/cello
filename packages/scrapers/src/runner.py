"""
Scout Agent Runner - Orchestrates job scraping across tracked companies.

This script is run by GitHub Actions on a schedule. It:
1. Fetches companies due for scraping from Supabase
2. Uses the intelligent scraper to extract jobs
3. Writes new jobs back to Supabase
4. Triggers notifications for high-match jobs
"""

import asyncio
import logging
import os
import sys
from datetime import datetime, timedelta

from supabase import Client, create_client

from .intelligent import AnthropicProvider, IntelligentScraper, OpenAIProvider, OpenRouterProvider

# A tick this early is still due: scrapes finish a little after they start, so
# last_scraped_at drifts late and a strict cutoff would skip every other tick.
# Same value as DUE_SLACK_MINUTES in scripts/ats-refresh.ts.
DUE_SLACK_MINUTES = 5


def get_supabase_client() -> Client:
    """Create Supabase client with service role key."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")

    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")

    return create_client(url, key)


def get_llm_provider():
    """Get the configured LLM provider."""
    # Prefer OpenRouter (cheapest with Gemini Flash)
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        return OpenRouterProvider(openrouter_key, model="google/gemini-2.0-flash-001")

    # Anthropic (Claude) as second choice
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        return AnthropicProvider(anthropic_key, model="claude-3-haiku-20240307")

    # OpenAI as fallback
    openai_key = os.environ.get("OPENAI_API_KEY")
    if openai_key:
        return OpenAIProvider(openai_key, model="gpt-4o-mini")

    raise ValueError("One of OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY must be set")


def is_due(company: dict, now: datetime) -> bool:
    """Whether a company's last scrape is old enough to scrape again."""
    last_scraped = company.get("last_scraped_at")
    if last_scraped is None:
        return True

    # Dream companies: 1 hour, Regular: 24 hours
    default_frequency = 60 if company.get("is_dream_company", False) else 1440
    frequency = max(default_frequency, company.get("scrape_frequency") or 0)

    last_scraped_dt = datetime.fromisoformat(last_scraped.replace("Z", "+00:00"))
    last_scraped_dt = last_scraped_dt.replace(tzinfo=None)
    return now - last_scraped_dt >= timedelta(minutes=frequency - DUE_SLACK_MINUTES)


async def get_companies_to_scrape(
    supabase: Client,
    specific_company_id: str | None = None,
) -> list[dict]:
    """
    Get companies that are due for scraping.

    Frequency based on company type:
    - Dream companies: every 1 hour (60 mins)
    - Regular companies: every 24 hours (1440 mins)

    A user-set scrape_frequency can stretch that but never go below it, the same
    rule as scripts/ats-refresh.ts.

    A company is due if:
    - It has never been scraped, OR
    - It was last scraped at least its frequency (less a 5 minute slack) ago
    """
    if specific_company_id:
        result = supabase.table("companies").select("*").eq("id", specific_company_id).execute()
        return result.data

    # Get all companies and filter by due time
    result = supabase.table("companies").select("*").execute()
    companies = result.data

    now = datetime.utcnow()
    due_companies = [c for c in companies if is_due(c, now)]

    # Prioritize dream companies first
    due_companies.sort(key=lambda c: (not c.get("is_dream_company", False), c.get("name", "")))

    return due_companies


async def scrape_company(
    company: dict,
    llm_provider,
    supabase: Client,
) -> dict:
    """
    Scrape a single company's career page.

    Returns a summary of the scrape results.
    """
    company_id = company["id"]
    career_url = company["career_url"]

    # Actions logs are public and companies are user-entered: log ids and
    # counts, never names, URLs, job titles or error text.
    print(f"Scraping company {company_id}...")

    async with IntelligentScraper(
        company_id=company_id,
        career_url=career_url,
        llm_provider=llm_provider,
        max_pages=5,  # Limit pages per company
    ) as scraper:
        result = await scraper.scrape()

    if not result.success:
        print("  Failed")
        return {
            "company": company_id,
            "success": False,
            "error": result.error,
        }

    # Insert new jobs (upsert by external_id)
    new_jobs_count = 0
    for job in result.jobs:
        job_data = {
            "company_id": company_id,
            "title": job.title,
            "description": job.description[:10000],  # Limit description size
            "url": str(job.url),
            "location": job.location,
            "salary_range": job.salary_range,
            "job_type": job.job_type,
            "posted_at": job.posted_at.isoformat() if job.posted_at else None,
            "external_id": job.external_id or str(job.url),  # Use URL as fallback ID
            "is_new": True,
        }

        # Insert new postings and leave known ones alone. Updating them on every
        # scrape rewrote each row (and its 10KB description) hourly, which is
        # what filled the first database's disk, and re-flagged seen jobs as new.
        try:
            supabase.table("jobs").upsert(
                job_data,
                on_conflict="company_id,external_id",
                ignore_duplicates=True,
            ).execute()
            new_jobs_count += 1
        except Exception as e:
            print(f"  Failed to insert a job ({type(e).__name__})")

    # Update last_scraped_at
    supabase.table("companies").update({"last_scraped_at": datetime.utcnow().isoformat()}).eq(
        "id", company_id
    ).execute()

    print(f"  Found {len(result.jobs)} jobs, inserted {new_jobs_count}")

    return {
        "company": company_id,
        "success": True,
        "jobs_found": len(result.jobs),
        "jobs_inserted": new_jobs_count,
        "duration_ms": result.duration_ms,
    }


async def main(specific_company_id: str | None = None):
    """Main entry point for the scraper runner."""
    # Scrapling logs "Fetched (200) <GET career-url>" at INFO on its own handler and
    # browser-use installs a root one, so per-logger levels do not hold. Scrapling also
    # logs "Failed after N attempts: <playwright error with the URL>" at ERROR. This
    # repo's Actions logs are public and the runner prints with print(), so disable()
    # everything: it survives any handler setup.
    logging.disable(logging.CRITICAL)

    print("=" * 60)
    print(f"Scout Agent starting at {datetime.utcnow().isoformat()}")
    print("=" * 60)

    supabase = get_supabase_client()
    llm_provider = get_llm_provider()

    companies = await get_companies_to_scrape(supabase, specific_company_id)
    print(f"\nFound {len(companies)} companies to scrape\n")

    if not companies:
        print("No companies due for scraping")
        return

    results = []
    for company in companies:
        try:
            result = await scrape_company(company, llm_provider, supabase)
        except Exception as e:  # noqa: BLE001 - a traceback can carry the career URL or row text
            print(f"  Company {company.get('id')} failed ({type(e).__name__})")
            result = {"company": company.get("id"), "success": False}
        results.append(result)
        # Small delay between companies to be nice to APIs
        await asyncio.sleep(1)

    # Summary
    print("\n" + "=" * 60)
    print("SCRAPING SUMMARY")
    print("=" * 60)

    success_count = sum(1 for r in results if r["success"])
    total_jobs = sum(r.get("jobs_found", 0) for r in results if r["success"])

    print(f"Companies scraped: {success_count}/{len(results)}")
    print(f"Total jobs found: {total_jobs}")

    for result in results:
        status = "OK" if result["success"] else "FAILED"
        print(f"  [{status}] {result['company']}")


if __name__ == "__main__":
    company_id = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    try:
        asyncio.run(main(company_id))
    except Exception as e:  # noqa: BLE001 - a traceback can carry the career URL or row text
        print(f"Scout Agent failed ({type(e).__name__})")
        sys.exit(1)
