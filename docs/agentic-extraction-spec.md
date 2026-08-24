# AGENTRIC Extraction Spec

The heart of the Systemisation module. It turns what a business owner knows into an autonomous AI agent, by two routes:

- **Video route:** the owner records one short scripted Loom. The system extracts an SOP and an agent spec, checks it for gaps, asks for anything missing, and only then builds the agent.
- **Form route (added 24 Aug 2026):** the owner fills in a guided form on the AI Agents tab. The AI asks the eight questions one at a time, checks each answer as it lands, and writes the finished spec to the AI Agents register in Airtable.

This document defines, for each of the eight AGENTRIC stages: the on-screen prompt the owner reads, what it captures, the pass criteria for "complete", whether it can be marked Not Applicable, and the follow-up questions the AI asks when the stage comes back thin.

_Renamed from AGENTIC (seven stages) on 24 Aug 2026: R (Reasoning) added and C now carries the score, folding in Austin Chen's Agent Logic Model from "Artificial Intelligence for Beginners" (brain file, 23 Aug 2026). Chen's five needs map onto the stages like this:_

| Chen's need | AGENTRIC home |
|---|---|
| A goal | A — Aim |
| A reasoning process | R — Reasoning |
| Access to what it needs (memory/context) | E — Entry Points |
| Orchestration of the process | G — Go Signal + N — Navigate |
| A score | C — Conclusion & Score |

_Chen's Guardrail Stack and 3-Tier Decision Framework land as I — Inspections & Caveats plus the per-agent **guardrail level** (below)._

---

## The flow (video route)

1. Owner places the workflow (customer journey, department, method).
2. Owner records one AGENTRIC video, following the eight on-screen prompts.
3. AI turns the video into a transcript, an SOP, and a draft agent spec.
4. The AGENTRIC readiness check scores all eight stages.
5. If any stage is Thin or Missing, the owner gets a short list of exact questions, and answers by text, voice note, or by re-recording just that one stage.
6. The check re-runs. When all eight pass (or are justified Not Applicable), the agent moves to Ready.
7. The owner switches it Live.

An agent can never go Live with an unresolved gap.

## The flow (form route)

1. Owner clicks "+ Create an agent" on the AI Agents tab.
2. Basics first: name, goal, score metric, department, guardrail level.
3. The AI asks the eight stage questions one at a time. "Check with AI" scores the answer immediately (Clear / Thin / Missing) and asks up to two follow-ups. Skipping is allowed.
4. On create, the agent lands in the AI Agents register (Airtable `tbl9msVjyQWslLOIZ`) with a per-stage scorecard. Gaps leave it at "Needs input"; its panel shows exactly what is missing.
5. Stages are editable on the agent's panel; "Run readiness check" re-scores the whole spec with the same rules as the video route (shared wording in `agentricPassRules()`).

---

## Agent state machine

- **Draft** — captured (video or form), not yet checked.
- **Needs input** — one or more stages are Thin or Missing. Questions issued.
- **Ready** — all eight stages Clear or justified Not Applicable.
- **Live** — owner has switched it on. The runtime now runs it.

Register agents additionally carry a build **Status** (Planned / Building / Built / Live / Paused), because a role agent exists as a plan before its runtime exists.

---

## Guardrail levels (per agent)

Kevin's three styles, one per agent, set at creation and changeable any time:

- **Autonomous** — does the whole job start to finish on its own. For low-stakes, easily-undone work.
- **Approval required** — prepares everything, acts only after a human yes. Nothing reaches the outside world unapproved.
- **Hybrid escalation** — runs the agreed process itself; anything outside the agreed path comes to a human first.

These map onto Chen's 3-Tier Decision Framework (Tier 1 fully delegated / Tier 2 supervised / Tier 3 human only). The approval loop mechanics (gate BEFORE the action, owner moves the gears, nothing auto-promotes) are unchanged — see `docs/agent-runtime-spec.md`.

---

## The eight stages

### A — Aim
- **Prompt:** "In a sentence or two, what is this process for, and why does it matter to the business?"
- **Captures:** the goal and the success test (the agent's accuracy yardstick).
- **Pass criteria:** a clear outcome AND a concrete, checkable test of correctness. A vague purpose with no way to spot a mistake fails.
- **Not Applicable:** never.
- **Follow-ups when thin:**
  - "You told me what it does, but not how you would spot a mistake. What does a wrong result look like?"
  - "If you handed this to someone new, how would they know they had done it correctly?"

### G — Go Signal
- **Prompt:** "What tells you it is time to do this? A set time, an email arriving, a new record, a payment landing, or someone asking?"
- **Captures:** the trigger.
- **Pass criteria:** a specific, recognisable event or schedule a system could detect. "Whenever I get round to it" fails. "On demand / manual" is a valid trigger if that is genuinely true.
- **Not Applicable:** never (use "manual / on demand" instead).
- **Follow-ups when thin:**
  - "You said you do it regularly. What actually prompts each run, a date, an alert, a new entry?"
  - "Is there a signal a computer could also see, like an email label or a new row?"

### E — Entry Points
- **Prompt:** "Where do you go and what do you open to do this? Which systems, inboxes, files, or records, and what do you need from each?"
- **Captures:** the data and systems it reads — the agent's access and memory.
- **Pass criteria:** every source touched is named, with what gets read from each.
- **Not Applicable:** never (every process reads something).
- **Follow-ups when thin:**
  - "You mentioned the spreadsheet. Anything else you check before deciding, another system or record?"
  - "What exact information do you pull from each place?"

### N — Navigate the Process
- **Prompt:** "Walk me through exactly what you do, step by step. Most important: every time you make a choice, say out loud how you decide and why you pick what you pick."
- **Captures:** the steps in order. (Decision rules spoken here are credited to R.)
- **Pass criteria:** the steps are in order and complete enough to follow. Decision reasoning spoken during Navigate counts towards R rather than being demanded twice.
- **Not Applicable:** never.
- **Follow-ups when thin:**
  - "What happens between step X and the end result? Walk me through the middle."
  - "Is there a step you do so automatically you forgot to say it?"

### T — Tools & Transformations
- **Prompt:** "What do you actually change, create, or send? Name every system you write into."
- **Captures:** the actions and side-effects, and the tools needed to perform them.
- **Pass criteria:** every write, create, or send action and its target system is named, and the end state is described.
- **Not Applicable:** never. A process that changes nothing is a report, and its output still counts as the result.
- **Follow-ups when thin:**
  - "You update the record. Which fields exactly, and what do they end up saying?"
  - "Does anything get sent to anyone? Who, and what does it say?"

### R — Reasoning _(new, 24 Aug 2026)_
- **Prompt:** "How should good judgement sound when doing this? What rules of thumb decide the grey areas? And when it is unsure, what happens: best guess, skip it, or stop and ask you?"
- **Captures:** the decision rules — how the agent thinks, and its when-unsure behaviour. This is Chen's reasoning core made explicit.
- **Pass criteria:** the grey areas have stated rules, and the when-unsure behaviour is named (guess / skip / escalate). Decision reasoning captured inside Navigate is credited here — the check must not double-penalise.
- **Not Applicable:** for a HUMAN task only (the person brings their own judgement). Never for an agent.
- **Follow-ups when thin:**
  - "You said you pick the right one. How do you decide which is right? What do you look at?"
  - "When it hits something it has not seen before, what should it do: guess, skip, or ask you?"

### I — Inspections & Caveats
- **Prompt:** "Before you call it done, what do you check? What would you never let go out unchecked? And what trips this up — the odd cases, the exceptions, anything you must never do?"
- **Captures:** the approval gate, the must-not-auto items, the edge cases, and the hard guardrails — the checks and the never-dos live together.
- **Pass criteria:** the checks are named, anything that must always have a human eye is flagged, and the known exceptions / "never do" rules are captured (or an explicit "none").
- **Not Applicable:** allowed, but rare. If the owner genuinely checks nothing and knows no exceptions, mark N/A with a reason and flag it as a risk for review.
- **Follow-ups when thin:**
  - "Is there anything here that, if it were wrong, would be costly or hard to undo? That is what we would always check."
  - "Has this ever gone wrong? What happened?"
  - "Anything that would be a disaster if the agent did it by accident?"

### C — Conclusion & Score
- **Prompt:** "What does the finished job look like, and how is success scored? Describe the end result of one good run, and the number or check that tells you over time it is doing a good job."
- **Captures:** the definition of done AND the ongoing score — the measure the register tracks (e.g. "15 emails/day", "95% reconciliation accuracy").
- **Pass criteria:** a concrete finished state (what exists or has changed) plus a success measure. End state with no measure is Thin for an agent; the measure is optional for a human task.
- **Not Applicable:** never — every process has an end state.
- **Follow-ups when thin:**
  - "If you walked in the next morning, what would you look at to confirm it worked?"
  - "Over a month, what number or check would tell you this agent is earning its keep?"

_Amended 2026-07-06: the final C changed from Caveats to Conclusion (the successful end state); caveats folded into I as "Inspections & Caveats"._
_Amended 2026-08-24: seven stages became eight — R (Reasoning) added between T and I; C renamed Conclusion & Score. The acronym reads A-G-E-N-T-R-I-C._

---

## The readiness scorecard

Shown on the workflow (video route) and on the agent's panel (register route, stored in the `Stage Scores` field). Each stage is one of: **Clear**, **Thin**, **Missing**, or **N/A** (with reason). The agent's overall state is derived from the worst stage. The scorecard is also surfaced on the business blueprint, so anyone (including a future buyer) can see at a glance which processes are fully captured.

The shared wording lives in `agentricCheckIntro()` / `agentricPassRules()` / `agentricResultShape()` in `os/systemisation/index.html`, used by BOTH routes so they can never drift.

---

## Design guardrails

- **Cap the asks.** Issue at most about three follow-ups at a time, the ones that most block building the agent. Three quick questions feels helpful; fifteen feels like homework and kills the slickness.
- **Allow Not Applicable, with limits.** E and N can never be N/A. A, G, T should resolve to a real value (use "manual / on demand", "report only", etc.). I and C may be N/A with a reason; R may be N/A for human tasks only.
- **Be strict on judgement.** An agent passes R only when the decision reasoning is present. This is the most common silent failure.
- **Never double-penalise.** Decision rules spoken inside Navigate count towards R.
- **Make topping up easy.** Default to a typed or voice answer for small gaps. Re-recording is per stage, never the whole video, because the script is split by letter.
- **Frame it as help, not a grade.** "Great start. I just need three quick things to finish your agent."

---

## Meta-learning: the script improves itself

Track which stages most often come back Thin across all owners. If a stage is consistently weak, the prompt for that stage is the problem, not the owners. Use that signal to refine the master prompts. The script is versioned and treated as a single source of truth, the same approach as the boardroom mentor prompt.
