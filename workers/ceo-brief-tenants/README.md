# ceo-brief-tenants

One Cloudflare Worker that writes every client's daily CEO Brief on the Supabase product.

## What it does

Hourly (05:00 to 12:00 UTC, every day), for each workspace with a `ceo_brief` row in `app_settings`:

1. Skip if `org_modules` has `ceo_brief` switched off, the config has `enabled: false`, or setup is incomplete (`missingForGoLive` in `js/ceo-brief-defaults.mjs`).
2. Check the tenant's own clock: weekday rule and the send hour plus two hours of retry room. The day is never in the cron.
3. Skip if today's `ceo_briefs` row already has a full brief.
4. Gather tasks (Airtable, or "not connected"), today's calendar (ICS), and the money light (manual or none).
5. Run every enabled board seat in parallel on the light model. Each answers completed, today, blocking, flag.
6. Run the CEO on the default model. Apply the approval-queue guards and the limits.
7. Store the row in `ceo_briefs` first, then deliver (Slack webhook, email webhook, or page only). A delivery failure writes `fallback = true` with the reason.

One tenant failing never stops the others.

## Files

- `worker.js` fetch, store, deliver. The only file that touches the network.
- `lib.mjs` pure functions: time window, prompts, guards, payloads. Tested directly.
- `../../js/ceo-brief-defaults.mjs` the config shape, shared with the setup page.

## Secrets

```
wrangler secret put SUPABASE_SERVICE_KEY -c workers/ceo-brief-tenants/wrangler.toml
wrangler secret put PROXY_TOKEN          -c workers/ceo-brief-tenants/wrangler.toml
wrangler secret put TRIGGER_KEY          -c workers/ceo-brief-tenants/wrangler.toml
wrangler secret put EMAIL_WEBHOOK_URL    -c workers/ceo-brief-tenants/wrangler.toml   # optional
wrangler secret put <AIRTABLE_PAT_REF>   -c workers/ceo-brief-tenants/wrangler.toml   # one per Airtable tenant
```

Model IDs and `SUPABASE_URL` are plain vars in `wrangler.toml`.

## Deploy

```
npx wrangler@4 deploy -c workers/ceo-brief-tenants/wrangler.toml
```

Needs the `ceo_briefs` table (migration 0043) and the `claude-proxy` worker.

## Manual endpoints

All but `/health` need `&key=<TRIGGER_KEY>`.

- `GET /health` liveness.
- `GET /?mode=tenants&key=KEY` every tenant with enabled, missing setup items, next window.
- `GET /?mode=brief&org=<org_id>&key=KEY` dry run: board plus CEO, nothing stored or sent.
- `GET /?mode=send&org=<org_id>&key=KEY` full run now, ignoring the time window. Still skips if today's brief exists, unless `&force=1`.

## Tests

```
npx vitest run tests/ceo-brief-tenants.test.js
```
