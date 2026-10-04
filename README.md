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
   headless browser and its links are classified by Gemini.
2. **Diff** — postings not seen before are new; one missing from two successful scans in a row is closed.
3. **Match** — location and excluded-keyword filters, then a titles-only triage, then a 0–100 fit score against
   the resume with matched skills and gaps.
4. **Research** — company brief (cached 30 days) and a pay estimate per role, using Google Search grounding,
   with sources. Pay stated in the posting always wins over an estimate.
5. **Email** — one digest per run, only when there is something new: matching roles, tracked roles that closed,
   and careers pages that stopped scanning.

Work that doesn't fit in the Gemini free quota is queued in the database and picked up by the next run.

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
| `GEMINI_MODEL` | variable (optional) | optional | Defaults to `gemini-3.8-flash` |

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
npm run scan -- --url https://jobs.lever.co/acme   # list what a careers page yields; no database needed
npm test
```

## Limits worth knowing

- Workday serves at most 2,000 postings per board. Larger boards are still watched for new roles, but closed-role
  detection is turned off for them.
- Sites that block automated browsers show up as a failing page (red dot, and one email) rather than silently
  returning nothing.
- On Gemini's free tier, submitted content, which includes the resume text, may be used by Google to improve its
  products. A paid key removes that.
- Pay figures and growth outlook are researched estimates with their sources linked.
