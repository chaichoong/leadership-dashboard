---
name: pre-deploy
description: Pre-deployment checklist before pushing to GitHub Pages or deploying a Worker. Checks for console.log, security issues, config consistency, and deploy verification. Use before any push to main or deployment. Also called automatically by /build-feature and /fix workflows.
---

# Pre-Deploy Checklist

Run this checklist and report pass/fail for each item. Block deployment if any current-stack item fails.

---

## Current Stack (GitHub Pages)

These checks apply now. All must pass before pushing.

### 1. No debug statements in production paths

```bash
grep -rn "console\.log\|console\.warn\|console\.error\|debugger" js/ --include="*.js" | grep -v "// debug" | grep -v node_modules
```

Review each match. Remove any that are leftover from development. Keep intentional error logging (e.g. catch blocks that log before showing a toast).

**Pass criteria:** No unintentional console.log or debugger statements.

### 2. HTML validation

Run htmlhint on all changed HTML files. The PostToolUse hook covers edits, but verify no issues slipped through:

```bash
npx -y htmlhint@1.1.4 index.html follow-up.html compliance.html
```

**Pass criteria:** No errors.

### 3. escHtml on all external data

Grep for `innerHTML` assignments in changed files. Every one must use `escHtml()` on any Airtable-sourced or user-supplied text:

```bash
grep -n "innerHTML" js/*.js | grep -v "escHtml"
```

Review each match. Template literals building HTML from external data without escaping are security vulnerabilities.

**Pass criteria:** No unescaped external data in innerHTML.

### 4. Design tokens (no hardcoded colours)

```bash
grep -rn "#[0-9a-fA-F]\{3,8\}" js/*.js css/styles.css --include="*.js" --include="*.css" | grep -v "tokens.css" | grep -v "config.js"
```

**Pass criteria:** No hardcoded hex colours in feature files. All colours use `var(--token-name)`.

### 5. PAGE_REGISTRY consistency

For any new or modified pages, verify in `js/config.js`:
- `pageVer` exists
- `sopFile` path is correct and the file exists
- `standalone` URL is correct

**Pass criteria:** All registry entries valid.

### 6. Sitemap and robots.txt

If new pages were added:
- Confirm they appear in `sitemap.xml`
- Confirm `robots.txt` does not block them (unless intentional)

**Pass criteria:** New pages are discoverable.

### 7. Pre-commit mapping

If new pages were added, verify `scripts/pre-commit-action.py` has the file-to-page mapping so auto-bump works.

**Pass criteria:** Mapping exists for all new files.

### 8. Rollback path

Identify which commit to revert to if this push breaks production:

```bash
git log --oneline -5
```

State the rollback commit hash in the report.

**Pass criteria:** Rollback commit identified.

---

## Future Stack (activate when SaaS migration begins)

These checks are informational until Supabase and Cloudflare Workers are in use. Skip them for GitHub Pages-only deploys.

### 9. Supabase RLS policies
All new tables have RLS enabled. No table ships without a policy.

### 10. Supabase migrations
Migration files exist for all schema changes. Migrations have been run on production.

### 11. Cloudflare Worker env vars
All environment variables documented. All set in the Cloudflare dashboard for the production Worker.

### 12. CORS origins
Worker CORS allows only the production domain and localhost for development.

### 13. Rate limiting
Public endpoints have rate limiting configured.

### 14. Error tracking
New endpoints log errors to a monitoring service (not just console.log).

---

## Output format

```
## Pre-Deploy Report

1. Debug statements: PASS / FAIL (details)
2. HTML validation: PASS / FAIL
3. escHtml coverage: PASS / FAIL (details)
4. Design tokens: PASS / FAIL (details)
5. PAGE_REGISTRY: PASS / FAIL
6. Sitemap: PASS / N/A
7. Pre-commit mapping: PASS / N/A
8. Rollback: [commit hash]

Overall: READY / BLOCKED (list blockers)
```

If any item fails, fix it before deploying. Do not ask Kevin to fix it. Fix it, re-run the check, then report.
