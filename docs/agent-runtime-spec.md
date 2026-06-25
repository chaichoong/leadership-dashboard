# Agent Runtime Spec

The engine that runs a "Ready" agent. Built once, every agent plugs into it. It turns the eight-part agent spec (from the AGENTIC extraction) into actual work done, safely. This is step 7 of the Process-to-Agent pipeline.

---

## The run loop (one agent run)

1. **Trigger fires** — an event or a schedule starts a run.
2. **Gather inputs** — the agent reads only the data sources its spec declares.
3. **Decide** — apply the decision rules. Rule-based work is deterministic; judgement work has the AI propose with a confidence score.
4. **Approval gate** — for every intended action, decide auto-do vs human-tap (see below).
5. **Act** — perform only the approved actions, through the agent's allowed tools.
6. **Record the run** — what it did, confidence, who approved (auto or human), outcome.
7. **Undo** — every run is reversible from its record.
8. **Learn** — corrections and outcomes feed back, raising confidence over time.

---

## The approval gate (the safety system)

Maps directly onto Kevin's decision framework (reversible/irreversible, financial thresholds, confidence).

- **Auto-execute** when ALL hold: confident, reversible, and below the value threshold (e.g. under £50, non-money, a categorisation).
- **Queue for one-tap approval** when ANY hold: low confidence, irreversible, above the threshold, or outward-facing (send, pay, share, post, delete).
- **Hard-never (always a human, never the agent)**: the prohibited set — moving money, changing access or permissions, deleting data, anything a person must own.

This is the queue mechanic already in the pricing model. It is what makes autonomy safe to sell.

---

## Trust ramp (how autonomy turns up safely)

Every agent earns its autonomy. It does not start fully loose.

1. **Shadow / suggest-only** — proposes everything, a human approves all. Builds the accuracy record.
2. **Assisted** — auto-does only the rock-solid tier, queues the rest (the reconciliation model).
3. **Autonomous** — runs the confident majority alone; the human sees a summary and can undo.

An agent graduates a tier only when its measured accuracy clears a bar, and drops back a tier if accuracy dips. The number drives the autonomy, not a guess.

---

## Where it runs (the honest architecture fork)

- **Phase A — browser-assisted (now, current stack).** The agent runs when the app is open, on load or on an in-app event. No new infrastructure; reuses the AI proxy, the Airtable writes, and the approval gate. Ships fast and proves the loop. Limit: it only runs when someone visits.
- **Phase B — server-side (with the Supabase migration).** Real headless triggers: cron, webhooks, Postgres triggers, queues. Agents run at 6am without anyone present. This is the true 90%-by-AI engine.

The runtime is the bridge into the SaaS stack. Build the loop in Phase A, then move the triggers to Phase B.

---

## Reuse what already exists

Reconciliation is already a runtime for one agent: trigger = unreconciled transactions; decide = the matcher with a confidence score; act = write the categorisation; accuracy = the audit log; learning = the knowledge base. Generalise that into the shared runtime rather than starting from a blank page.

---

## Tools and least privilege

Each agent's spec declares the exact tools it may use (specific Airtable tables, Gmail, Slack, Drive, the AI). The runtime enforces that list. An agent can never touch a tool it was not granted. Outward-facing tools (send, pay, share, delete) always route through the approval gate, regardless of confidence.

---

## Observability (feeds the blueprint)

Every run is logged: time, trigger, inputs seen, actions taken, confidence, approved by (auto or human), outcome, and an undo link. This produces each agent's live accuracy number and rolls up onto the business blueprint (step 8). It is also the audit trail a buyer would want.

---

## Recommended build sequence

1. **First agent, browser-assisted: the conservative reconciliation auto-approve** we scoped earlier. Auto-do the near-certain recurring matches, queue the rest, show a summary with undo. Safe, reversible, zero new infrastructure. It proves the gate, the accuracy logging, and the undo on a real daily job, and brings us full circle to where this started.
2. **Generalise the loop** into a shared runtime the agent spec plugs into.
3. **Move triggers server-side** with Supabase for true headless runs.
4. **Every new agent rides the trust ramp** (shadow → assisted → autonomous).
