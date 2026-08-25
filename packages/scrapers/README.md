# Cello Scrapers

AI-powered job board scraping for Cello.

## Features

- **Intelligent Scraping**: Uses LLM to understand career page structure
- **No Brittle Selectors**: Works with any career page format
- **Self-Healing**: Adapts when site structure changes
- **Pagination Support**: Automatically follows "next" links

## Usage

```python
from src import IntelligentScraper, AnthropicProvider

provider = AnthropicProvider(api_key="your-key")

async with IntelligentScraper(
    company_id="uuid",
    career_url="https://company.com/careers",
    llm_provider=provider,
) as scraper:
    result = await scraper.scrape()

    for job in result.jobs:
        print(f"{job.title} - {job.location}")
```

## Development

```bash
# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install with dev dependencies
pip install -e ".[dev]"

# Run linter
ruff check src

# Run tests
pytest
```
