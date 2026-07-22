# Multi-tenancy stress test

Live two-tenant isolation probe for the Supabase project. It answers one question:
**can one client-facing account see, change, or destroy another client's data?**

It creates two throwaway tenants (A and B) through the normal signup flow, then actively
tries to break the boundary between them — reads, writes, forged inserts, workspace
enumeration, and the `manage-client` Edge Function. See the findings this was built to
verify in [`docs/supabase-multitenancy-stress-audit.md`](../../docs/supabase-multitenancy-stress-audit.md).

> This could not be run from the Claude Code web environment — that container has **no
> outbound network** (the egress proxy denies all HTTPS). Run it from your own machine or
> any environment with internet access to the Supabase project.

## Run it

```bash
cd supabase-migration/stress-test

# Simplest — reads the URL + anon key from ../../supabase-app.html, report-only, manual cleanup:
node multitenancy-stress-test.mjs

# Full run: confirm the escalation chain AND auto-clean the throwaway tenants:
node multitenancy-stress-test.mjs --run-destructive --service-key "<service-role-key>"
```

Node 18+ (uses global `fetch`). No `npm install` needed.

### Flags
| Flag | Effect |
|------|--------|
| `--url <url>` / `--anon <key>` | Override the Supabase URL / anon key (else read from `supabase-app.html`). |
| `--service-key <key>` | Service-role key. **Only** used to auto-delete the two throwaway tenants at the end (and to confirm users if email confirmation is on). Never commit it. |
| `--run-destructive` | Actually exercise `suspend`→`delete` **against throwaway tenant A** (called by throwaway tenant B) to confirm Finding 1's full chain. Without it, P6 runs report-only. |
| `--keep` | Skip cleanup and print the two throwaway org ids so you can inspect them. |

### Safety
- The destructive probes **only ever target throwaway tenant A** — never a real workspace.
- Auto-cleanup deletes **only** the two throwaway orgs, and only with a service-role key.
  Without one, the harness prints the `delete_workspace(...)` SQL for you to run.
- If email confirmation is enabled in Supabase Auth, signups won't return a session. Either
  toggle "Confirm email" off for the test, or pass `--service-key` so the users can be
  confirmed. The harness tells you which case it hit.

## What each probe proves
| Probe | Expected (isolation intact) |
|-------|------------------------------|
| P1 baseline | A fresh tenant sees **zero** rows from any other org (incl. the operator's real data). |
| P2 cross-read | B cannot read A's seeded contact. |
| P3 cross-write | B's UPDATE/DELETE of A's row affects **0 rows**. |
| P4 forged insert | B inserting a row stamped with A's `org_id` is **rejected** by the RLS `with check`. |
| P5 org enumeration | B sees only its own workspace in `organizations`/`memberships`. |
| P6 Edge Function | `manage-client` **denies** a plain client (403). If it returns the workspace list or lets B suspend/delete A, that is Finding 1 reproduced. |

Exit code `0` = all isolation checks passed; `1` = at least one isolation failure; `2` = harness/setup error.
