# Job Hunt Tracker

**Live:** https://sulu-g.github.io/job-hunt/ (sign-in required)

A live job-search dashboard I built for my move into data center operations, ServiceNow, and IT support roles.

**What it does**
- A Supabase Edge Function (Deno/TypeScript) pulls postings straight from company hiring systems — Greenhouse, Lever, Ashby, Workday, Oracle, and Amazon Jobs — every 3 hours (31 companies, including NVIDIA, Flex, Jabil, HPE, xAI, OpenAI, Anthropic, Equinix, QTS, and CyrusOne).
- Each posting is filtered to US entry/mid-level roles and scored 0–100 against my actual skills (Cisco switch config, Python, Linux, rack integration, hardware troubleshooting), with the gaps listed honestly.
- Every 4 hours it re-checks open postings and marks any that were taken down as **Closed**, so I never apply to a dead link.
- The dashboard updates in real time (Supabase Realtime) and is locked to my login with Row Level Security.

**Stack:** Supabase (Postgres, Edge Functions, pg_cron, pg_net, Vault, Realtime, Auth) · vanilla HTML/JS · GitHub Pages

## Structure
```
index.html                      Dashboard (single file, no build step)
supabase/001_schema.sql         Tables, RLS policies, realtime
supabase/002_data.sql           Job board sources + first batch of saved jobs
supabase/003_security.sql       Hardening (private schema, Vault secret check)
supabase/004_cron.sql           Feed schedule
supabase/functions/jobs/        Edge function: ingest, verify, probe
```

## Security notes
- The key in `index.html` is Supabase's *publishable* key, which is designed to be public. Data access is enforced by Row Level Security: only the email listed in `app_owner` can read or change anything.
- The scheduled feed authenticates with a random secret stored in Supabase Vault — no secret is in this repo.
