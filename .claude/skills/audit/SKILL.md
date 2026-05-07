---
name: audit
description: Robustness audit of a page or dashboard — finds bugs, fixes them, re-audits self-introduced issues, deploys safely, and produces a scored readiness report.
---

# Audit & Score

Run a robustness audit on the specified page/dashboard.

## Steps

1. **Test the live site** using the Chrome MCP (`mcp__claude-in-chrome__*`) where auth permits, plus code-level checks (Read/Grep on the relevant `js/` and HTML files).
2. **List bugs found** with severity (HIGH / MEDIUM / LOW) and a one-line root cause for each.
3. **Fix each issue** and commit. Match the repo's commit-message style (look at `git log` first). Use one commit per logical fix, not a single mega-commit.
4. **Re-audit** the changes for self-introduced bugs — specifically: badge/count mismatches, filter logic that ignores dismissed items, double-submit risks, stale-state on async operations.
5. **Pull-rebase before pushing** to avoid overwriting parallel-session work:
   ```
   git pull --rebase origin main && git push origin main
   ```
   Then verify the GitHub Pages deploy is actually live (hard reload, check `pageVer` in `js/config.js` matches what's served).
6. **Score readiness out of 100** using this rubric (20 pts each):
   - **Correctness** — no logic bugs, counts match underlying data
   - **Error handling** — failed API calls, empty states, auth expiry
   - **Performance** — no obvious N+1 fetches, pagination respected
   - **UX polish** — loading states, mobile layout, accessibility basics
   - **Maintainability** — uses tokens.css, file split per CLAUDE.md, no hardcoded IDs
   Report each dimension's sub-score and the total.

## Output format

```
## Audit: <page name>

### Bugs found
- [HIGH] <bug> — <root cause>
- [MED]  <bug> — <root cause>
...

### Fixes applied
- <commit sha> <message>
...

### Re-audit
<self-introduced issues, or "clean">

### Deploy
<verified live at <pageVer>>

### Readiness: XX / 100
- Correctness: XX/20
- Error handling: XX/20
- Performance: XX/20
- UX polish: XX/20
- Maintainability: XX/20
```
