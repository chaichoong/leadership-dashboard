# Build Feature: pre-deploy checklist (Phase 8e)

Moved from SKILL.md on 21 Sep 2026, word for word. Read after the 8d security review, before any commit or deploy.

Run and report pass/fail for each:

**Current stack (GitHub Pages):**
1. No `console.log` or `debugger` in production code paths
2. HTML passes htmlhint (the PostToolUse hook covers this, but verify)
3. All PAGE_REGISTRY entries correct (pageVer, sopFile, standalone URL)
4. `escHtml()` used on all external data rendered in HTML
5. Design tokens used (no hardcoded colours, fonts, or spacing)
6. `sitemap.xml` updated if new pages added
7. Pre-commit mapping updated in `scripts/pre-commit-action.py` if new pages added
8. Rollback path identified (which commit to revert to if this breaks production)

**Future stack (activate when SaaS migration begins):**
9. Supabase RLS policies on any new tables
10. Supabase migrations run on production
11. Cloudflare Worker env vars documented and set
12. CORS origins set correctly on Workers
13. Rate limiting on public endpoints
14. Error tracking/logging in place for new endpoints

Block deployment if any current-stack item fails. Future-stack items are informational until migration begins.
