# Operations Director — Session Cheat Sheet

## Where is everything?

| What | Where |
|------|-------|
| **Source code (edit here)** | `/Users/kevinbrittain/Projects/leadership-dashboard/` |
| **Live website** | https://chaichoong.github.io/leadership-dashboard/ |
| **Google Drive** | Reference docs only — NOT for code editing |

---

## Which file does each feature use?

### Feature files (CAN be edited at the same time by different sessions)

| Feature | File |
|---------|------|
| Leadership Dashboard (KPIs, metrics) | `js/dashboard.js` |
| Cash flow forecast + balance calculator | `js/cashflow.js` |
| Reconciliation engine | `js/reconciliation.js` |
| Invoices tab | `js/invoices.js` |
| CFVs tab | `js/cfv.js` |
| Fintable Sync Monitor | `js/fintable.js` |
| Site Map & Links | `js/sitemap.js` |
| AI Assistant chat | `js/ai-assistant.js` |
| Operating Systems pages | `os/*.html` |
| Inbound Comms | `follow-up.html` |
| Property Compliance | `compliance.html` |
| SOPs | `sop*.html` |

### Shared files (only ONE session at a time)

| What | File |
|------|------|
| Sidebar menu, tab containers | `index.html` |
| All styles | `css/styles.css` |
| Constants, field IDs, PAGE_REGISTRY | `js/config.js` |
| Auth, API, helpers (escHtml, switchTab, etc.) | `js/shared.js` |

---

## The 3 rules

1. **One file per session** — tell each session which feature to work on
2. **Different files = safe at the same time** — run 2-3 sessions on different features
3. **Same file = one at a time** — never two sessions on the same file

---

## Adding a new page or sidebar item

This touches shared files, so do it in ONE session:
1. `index.html` — add sidebar item + tab panel HTML
2. `js/config.js` — add PAGE_REGISTRY entry
3. `js/shared.js` — add tabLabelMap entry
4. Push, THEN start other sessions

---

## Quick deploy steps

```
cd /Users/kevinbrittain/Projects/leadership-dashboard/
git pull                          # always pull first!
# make your edits
git add <files>
git commit -m "what you changed"
git push                          # live in 2-3 minutes
```
