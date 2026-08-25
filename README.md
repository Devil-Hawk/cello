# 🎻 Cello

**Career Engine for Leads & Opportunities**

An open-source, AI-powered job hunting tool that helps you stay ahead of the competition. When companies post jobs, early applicants have a significant advantage — Cello ensures you never miss an opportunity.

![Next.js](https://img.shields.io/badge/Next.js-14-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)
![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-green?style=flat-square&logo=supabase)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)

## ✨ Features

- **🔍 Real-time Job Discovery** — Scout Agent monitors career pages every 15 minutes
- **🎯 AI-Powered Matching** — Compares jobs to your resume using embeddings
- **🤖 Intelligent Scraping** — Works with any career page format via LLM extraction
- **📧 Gmail Integration** — Auto-detects application status from email responses
- **📊 Kanban Pipeline** — Visual tracking of your entire job search
- **👻 Ghost Detection** — Alerts when applications go silent too long
- **🌙 Dark Mode** — Easy on the eyes for those late-night applications

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14 + TypeScript |
| Database | Supabase (PostgreSQL + Auth + Realtime) |
| Scraping | Python + GitHub Actions Cron |
| AI | Hybrid (Local embeddings + API for analysis) |
| Hosting | Vercel + GitHub Actions |

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8+
- Python 3.11+
- Supabase account

### Installation

```bash
# Clone the repository
git clone https://github.com/Devil-Hawk/cello.git
cd cello

# Install dependencies
pnpm install

# Set up Python environment
cd packages/scrapers
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cd ../..

# Configure environment
cp apps/web/.env.example apps/web/.env.local
# Edit .env.local with your Supabase credentials

# Run database migrations
# (Use Supabase CLI or dashboard)

# Start development server
pnpm dev
```

## Project Structure

```
cello/
├── apps/
│   └── web/                 # Next.js frontend + API routes
├── packages/
│   ├── agents/              # AI agent logic (TypeScript)
│   ├── scrapers/            # Python scraping scripts
│   └── shared/              # Shared types and constants
├── supabase/
│   └── migrations/          # Database migrations
└── .github/workflows/       # CI/CD pipelines
```

## Multi-Agent Architecture

| Agent | Purpose |
|-------|---------|
| **Orchestrator** | Coordinates all agents |
| **Scout** | Discovers and monitors career pages |
| **Matcher** | Scores job-resume fit |
| **Analyst** | Deep analysis and talking points |
| **Tracker** | Monitors Gmail for status updates |
| **Coach** | Suggests follow-ups |
| **Network** | Finds referral paths |

## Development

```bash
# Run all checks
pnpm lint
pnpm typecheck
pnpm test

# Build for production
pnpm build
```

## Observability

Error monitoring (Sentry) is fully optional and off by default — see
[`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) for the one env var that
enables it, exactly what's scrubbed before anything is sent, and how the
agent harness logs failures independently of Sentry.

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a PR.

## 🔧 GitHub Actions Setup

For automated job scraping every 15 minutes, add these secrets to your repository:

1. Go to **Settings → Secrets → Actions**
2. Add:
   - `SUPABASE_URL` — Your Supabase project URL
   - `SUPABASE_SERVICE_KEY` — Service role key (not anon key)
   - `OPENROUTER_API_KEY` — (Optional) For AI-powered extraction

## 🚢 Deployment

### Vercel (Recommended)

1. Push to GitHub
2. Import project in [Vercel](https://vercel.com)
3. Set root directory to `apps/web`
4. Add environment variables
5. Deploy!

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with ❤️ for job seekers everywhere
</p>
