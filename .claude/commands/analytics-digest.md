---
description: Print the Phool Gobhi analytics funnel digest from the first-party analytics_events table.
allowed-tools: Bash(node scripts/analytics-digest.cjs)
---

Run the analytics funnel digest and interpret it for the user.

1. Run: `node scripts/analytics-digest.cjs` from the backend repo root.
2. If it reports no `ANALYTICS_DATABASE_URL`, tell the user to populate `scripts/.analytics.env` (gitignored) once — pulling the URL from Secret Manager via a `!` command so the secret never enters chat — then stop.
3. Otherwise, relay the digest and add a one-line read: call out the biggest funnel drop-off step and any day-over-day change worth noticing. Keep it to a few lines — this runs on a loop, so be concise.

Note: prod analytics is currently `ANALYTICS_PROVIDER=none`, so this reflects **dev** traffic until prod is enabled.
