# Business Blueprint Spec

The single map of the whole business: every workflow, what it does, who or what runs it, how ready it is, and how it is performing. Step 8 of the Process-to-Agent pipeline. It is the live operating system and the turnkey handover asset at the same time — the "Lego manual" a buyer or a new operator can pick up and run.

---

## What it shows

A new **Blueprint** view (a tab in Systemisation) that aggregates data the platform already captures.

**1. The headline rollup (the north-star scoreboard), across the top:**
- Total workflows, and the % that are documented (have an SOP).
- The disposition mix: how many are AI agents, recurring human tasks, ad-hoc, and not yet decided.
- The headline number: **% of operational work handled by AI**, shown as a bar trending toward 90%.
- Live agents and their accuracy.

**2. The map, grouped by business area** (Finance, Operations, Sales, Marketing, Admin), with a lens switcher to view instead by customer journey or by main method.
- Each area lists its workflows.
- Each workflow row shows: name, a one-line "what it does", a disposition badge (AI agent / Recurring task / Ad-hoc), a readiness state (Ready / Needs input / No SOP), and for agents a health or accuracy indicator.

---

## Two purposes, one view

- **Operating mode (daily):** surfaces what needs attention — workflows with no SOP, "Needs input" readiness, or agents with recent undos or slipping accuracy.
- **Handover mode:** a clean, complete, exportable map — the asset you hand to a buyer or a new operator. One document, print or export.

---

## Where the data comes from (mostly already there)

- Workflow names, departments, journey stage, method, SOP status: the Systemisation tables.
- Disposition (agent / recurring / ad-hoc) and readiness: already stored inside each workflow's SOP record.
- Agent performance: from the runtime's run and accuracy logs. Today only the reconciliation agent has real metrics; this fills in as more agents go live.

So v1 of the blueprint is largely a new **view over existing data**: high value, very little new plumbing.

---

## The headline metric (the point of it)

"% of operational work handled by AI", front and centre, trending toward 90%. Defined simply for v1: agents divided by (agents + human tasks) among the workflows that have a disposition, shown as a progress bar. This is the number that proves the promise, and the number a buyer values.

---

## Build phases

1. **v1 (now):** the map, the rollup, the lens switcher, and export. Built from existing data.
2. **v2 (with the runtime):** live per-agent accuracy and "needs attention" surfacing.
3. **v3:** the customer-journey end-to-end view (the FULFILL stages with automation overlaid) — "see how it all knits together".

---

## Placement

A new **Blueprint** tab in Systemisation. It aggregates Systemisation data and sits naturally alongside the existing lenses (Customer Journey, Main Method, Departmental, All Workflows, SOPs, Automation).
