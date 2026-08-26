---
name: daily-transaction-reconciler
description: Run the transaction reconciler skill to categorise and reconcile unreconciled bank transactions
---

Run the /transaction-reconciler skill to reconcile all unreconciled transactions in the Operations Director Airtable base. Process both Santander and TNT Mgt Zempler accounts. After completion, report how many transactions were reconciled.

Then write the Reconciliation agent's daily log (this is how the AI Agents
page sees the run — added 26 Aug 2026; a zero-transaction day logs too):

    python3 scripts/agent_daily_log.py publish --agent-row recyrN5YCQFssAniE \
        --name "Reconciliation" \
        --summary "<one line: X reconciled, Y held for review, accounts processed>" \
        --decisions "<a few lines: notable categorisation calls, anything held and why>"

A non-zero exit means the log write failed — report that honestly, never
retry-loop it.