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

**The owner moves the ramp. The number advises.** (Amended 16 Jul 2026, Kevin's call — see the note below.) An agent never graduates itself. Accuracy is shown as a recommendation at each gear, and a dip is surfaced as a prompt to pull the agent back, but the human decides. Handing autonomy over without a human yes is the one thing that breaks client trust, and client trust is what the 90%-AI goal runs on.

The ramp has four gears, as shown on the autonomy dial in the Systemisation module:

1. **Guardrails set** — the never-dos are written down. Captured by the AGENTIC "I — Inspections & Caveats" stage, before the agent acts at all.
2. **Approve everything** (built as `agent.state = 'testing'`) — proposes everything, a human approves all. Builds the accuracy record.
3. **Loosen the leash** (built as `agent.autoFields` / `autoComments`) — auto-does only the actions the owner has ticked, queues the rest (the reconciliation model). This is the "assisted" tier.
4. **Heartbeat** (built as `agent.state = 'live'`) — runs to a schedule, does the confident majority alone; the human sees a summary and can undo.

The gear is **derived from live state, never stored**, so the dial can never disagree with what the agent is actually doing. See `getAgentGear()` in `os/systemisation/index.html`.

**Why this changed:** this spec previously said "an agent graduates a tier only when its measured accuracy clears a bar... the number drives the autonomy, not a guess." That was written before the runtime existed, and it conflicted with both the shipped code (a human has always flipped the state) and with how the ramp is sold. Two corrections: the owner holds the control, and the accuracy bar cannot drive anything until the runtime actually logs accuracy. Today only the reconciliation agent has real metrics. Until every agent does, the dial's guidance says what we can observe and does not invent a score. When the run/accuracy log lands (step 7 above), the bar drops into `agentGearAdvice()` as the recommendation at each gear — advising, not deciding.

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
4. **Every new agent rides the trust ramp** (guardrails → approve everything → loosen the leash → heartbeat), with the owner moving each gear.
