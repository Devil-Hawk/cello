"""
Scout Agent Runner - Orchestrates job scraping across tracked companies.

This script is run by GitHub Actions on a schedule. It:
1. Fetches companies due for scraping from Supabase
2. Uses the intelligent scraper to extract jobs
3. Writes new jobs back to Supabase
4. Triggers notifications for high-match jobs
"""

import asyncio
import os
import sys
from datetime import datetime, timedelta

from supabase import Client, create_client

from .intelligent import AnthropicProvider, IntelligentScraper, OpenAIProvider, OpenRouterProvider


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


async def get_companies_to_scrape(
    supabase: Client,
    specific_company_id: str | None = None,
) -> list[dict]:
    """
    Get companies that are due for scraping.

    Frequency based on company type:
    - Dream companies: every 1 hour (60 mins)
    - Regular companies: every 24 hours (1440 mins)

    A company is due if:
    - It has never been scraped, OR
    - It was last scraped more than its frequency ago
    """
    if specific_company_id:
        result = supabase.table("companies").select("*").eq("id", specific_company_id).execute()
        return result.data

    # Get all companies and filter by due time
    result = supabase.table("companies").select("*").execute()
    companies = result.data

    now = datetime.utcnow()
    due_companies = []

    for company in companies:
        last_scraped = company.get("last_scraped_at")
        is_dream = company.get("is_dream_company", False)

        # Dream companies: 1 hour, Regular: 24 hours
        default_frequency = 60 if is_dream else 1440
        frequency = company.get("scrape_frequency") or default_frequency

        if last_scraped is None:
            due_companies.append(company)
        else:
            last_scraped_dt = datetime.fromisoformat(last_scraped.replace("Z", "+00:00"))
            if now - last_scraped_dt.replace(tzinfo=None) > timedelta(minutes=frequency):
                due_companies.append(company)

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
    company_name = company["name"]
    career_url = company["career_url"]

    print(f"Scraping {company_name} ({career_url})...")

    async with IntelligentScraper(
        company_id=company_id,
        career_url=career_url,
        llm_provider=llm_provider,
        max_pages=5,  # Limit pages per company
    ) as scraper:
        result = await scraper.scrape()

    if not result.success:
        print(f"  Failed: {result.error}")
        return {
            "company": company_name,
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

        # Upsert - update if external_id exists, insert if not
        try:
            supabase.table("jobs").upsert(
                job_data,
                on_conflict="company_id,external_id",
            ).execute()
            new_jobs_count += 1
        except Exception as e:
            print(f"  Failed to insert job '{job.title}': {e}")

    # Update last_scraped_at
    supabase.table("companies").update({"last_scraped_at": datetime.utcnow().isoformat()}).eq(
        "id", company_id
    ).execute()

    print(f"  Found {len(result.jobs)} jobs, inserted {new_jobs_count}")

    return {
        "company": company_name,
        "success": True,
        "jobs_found": len(result.jobs),
        "jobs_inserted": new_jobs_count,
        "duration_ms": result.duration_ms,
    }


async def main(specific_company_id: str | None = None):
    """Main entry point for the scraper runner."""
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
        result = await scrape_company(company, llm_provider, supabase)
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
    asyncio.run(main(company_id))
