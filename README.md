# jobspy

Watches company careers pages and emails you when a new role fits your resume or the roles you asked for.
Each email carries a short company brief (what it does, top products, key numbers, growth outlook, its
best-known product and where it's used) and an expected-pay estimate per role.

```
Vercel (web UI)  ──►  Supabase Postgres  ◄──  GitHub Actions (scanner, daily)  ──►  Gemini  ──►  Gmail  ──►  you
       └──────────── "Scan now" (workflow_dispatch) ──────────────┘
```

- **Scanner** (`src/scanner`) runs on GitHub Actions every day and scans each company once every two days.
- **UI** (`src/app`) is a small Next.js app: add a careers URL, see matching roles, track applications, upload a resume.
- Nothing runs on your own machine.

## How a scan works

1. **Discover** — Greenhouse, Lever, Ashby, Workday and SmartRecruiters boards are read through their public
   JSON APIs, including when a company's own careers page merely embeds one. Anything else is rendered in a
   headless browser and its links are classified by the model.
2. **Diff** — postings not seen before are new; one missing from two successful scans in a row is closed.
3. **Match** — location and excluded-keyword filters, then a titles-only triage, then a 0–100 fit score against
   the resume with matched skills and gaps.
4. **Research** — a company brief (cached 30 days) and a pay estimate per role, written from live web search
   results and Wikipedia, with sources. Pay stated in the posting always wins over an estimate.
5. **Email** — one digest per run, only when there is something new: matching roles, tracked roles that closed,
   and careers pages that stopped scanning.

### Models and limits

Everything runs on Gemini's free tier, with no billing. `src/lib/llm.ts` rotates through the free models:
fit scoring and research start on the Flash models, bulk title triage starts on the Flash-Lite models. When a
model answers that its quota is exhausted it is recorded in the database and not asked again until the quota
resets (midnight Pacific), so later runs don't re-hit it. A model that is merely overloaded is skipped for ten
minutes. When no model is available, the remaining roles stay queued and the next run picks them up.

On a machine with [Ollama](https://ollama.com) running, a local scan falls back to it (`qwen2.5:7b` by default)
when Gemini is exhausted, or uses it for everything with `npm run scan -- --llm ollama`. GitHub runs never do.
Roles scored by the local model are tagged in the tracker.

### Web search

Research uses [SearXNG](https://github.com/searxng/searxng), an open-source metasearch engine, with no API key.
The workflow starts it as a container inside each run. The engines in `searxng/settings.yml` are the ones that
answered from GitHub's runners when measured with `searxng/probe.sh` (Bing, Yahoo, Startpage, Wikipedia); Google,
DuckDuckGo and Brave refuse datacenter addresses. If search is unreachable, briefs and pay fall back to what the
model knows and are labelled unverified.

For local scans:

```bash
docker run -d --name searxng -p 8888:8080 -v "$PWD/searxng/settings.yml:/etc/searxng/settings.yml:ro" searxng/searxng:latest
```

## Setup

### 1. Environment

Copy `.env.example` to `.env.local` for local runs. The same values go into GitHub and Vercel:

| Variable | GitHub Actions | Vercel | Notes |
|---|---|---|---|
| `SUPABASE_URL` | secret | ✓ | Project URL |
| `SUPABASE_SECRET_KEY` | secret | ✓ | Supabase → Project Settings → API keys → secret key |
| `GEMINI_API_KEY` | secret | ✓ | https://aistudio.google.com/apikey |
| `GMAIL_USER` | secret | | The Gmail account that sends the alerts |
| `GMAIL_APP_PASSWORD` | secret | | https://myaccount.google.com/apppasswords (needs 2-step verification) |
| `APP_PASSWORD` | | ✓ | Password for the UI |
| `SESSION_SECRET` | | ✓ | Any long random string (`openssl rand -hex 32`) |
| `GITHUB_DISPATCH_TOKEN` | | ✓ | Fine-grained token, this repo only, Actions: read and write |
| `GITHUB_REPO` | | ✓ | `owner/repo` |
| `APP_URL` | variable | | The Vercel URL, for the "Open the tracker" link in emails |
| `SEARXNG_URL` | set by the workflow | | `http://localhost:8888` for local scans |

### 2. Database

Run `supabase/migrations/0001_init.sql` in the Supabase SQL editor. Row level security is on with no
policies, so only the secret key can read or write.

### 3. Deploy

- Push to GitHub; the `scan` workflow starts running on its schedule.
- Import the repo in Vercel (framework: Next.js, no build settings needed) and add the Vercel variables.

## Commands

```bash
npm run dev                                  # UI at http://localhost:3000
npm run scan                                 # scan companies that are due, send the email
npm run scan -- --force                      # ignore the two-day interval
npm run scan -- --dry-run                    # no email; writes out/digest.html
npm run scan -- --llm ollama                 # use the local Ollama model for everything
npm run scan -- --url https://jobs.lever.co/acme   # list what a careers page yields; no database needed
npm test
```

## Limits worth knowing

- Workday serves at most 2,000 postings per board. Larger boards are still watched for new roles, but closed-role
  detection is turned off for them.
- Sites that block automated browsers show up as a failing page (red dot, and one email) rather than silently
  returning nothing.
- On Gemini's free tier, submitted content, which includes the resume text, may be used by Google to improve its
  products.
- Each free model is refused once on the day its quota runs out; after that it is left alone until the reset.
- A large first scan can take a few days to score, because the free quotas are small.
- Pay figures and growth outlook are estimates drawn from search results, with their sources linked.
