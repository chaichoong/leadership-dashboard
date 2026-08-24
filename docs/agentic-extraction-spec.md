# AGENTIC Extraction Spec

The heart of the Systemisation module. It turns what a business owner knows into an autonomous AI agent, by two routes:

- **Video route:** the owner records one short scripted Loom. The system extracts an SOP and an agent spec, checks it for gaps, asks for anything missing, and only then builds the agent.
- **Form route (added 24 Aug 2026):** the owner fills in a guided form on the AI Agents tab. The AI asks the seven questions one at a time, checks each answer as it lands, and writes the finished spec to the AI Agents register in Airtable.

This document defines, for each of the seven AGENTIC stages: the on-screen prompt the owner reads, what it captures, the pass criteria for "complete", whether it can be marked Not Applicable, and the follow-up questions the AI asks when the stage comes back thin.

_History: on 24 Aug 2026 an eighth stage (R — Reasoning) was trialled and the framework briefly renamed. Kevin's ruling 25 Aug 2026: **the acronym stays AGENTIC, seven stages**. Reasoning lives INSIDE Navigate (the walk-through is where decisions get narrated), and C carries the score. Austin Chen's Agent Logic Model ("Artificial Intelligence for Beginners", brain file 23 Aug 2026) maps on like this:_

| Chen's need | AGENTIC home |
|---|---|
| A goal | A — Aim |
| A reasoning process | N — Navigate (the decision rules and the when-unsure behaviour) |
| Access to what it needs (memory/context) | E — Entry Points |
| Orchestration of the process | G — Go Signal + N — Navigate |
| A score | C — Conclusion & Score |

_Chen's Guardrail Stack and 3-Tier Decision Framework land as I — Inspections & Caveats plus the per-agent **guardrail level** (below)._

---

## The flow (video route)

1. Owner places the workflow (customer journey, department, method).
2. Owner records one AGENTIC video, following the seven on-screen prompts.
3. AI turns the video into a transcript, an SOP, and a draft agent spec.
4. The AGENTIC readiness check scores all seven stages.
5. If any stage is Thin or Missing, the owner gets a short list of exact questions, and answers by text, voice note, or by re-recording just that one stage.
6. The check re-runs. When all seven pass (or are justified Not Applicable), the agent moves to Ready.
7. The owner switches it Live.

An agent can never go Live with an unresolved gap.

## The flow (form route)

1. Owner clicks "+ Create an agent" on the AI Agents tab.
2. Basics first: name, goal, score metric, department, guardrail level.
3. The AI asks the seven stage questions one at a time. "Check with AI" scores the answer immediately (Clear / Thin / Missing) and asks up to two follow-ups. Skipping is allowed.
4. On create, the agent lands in the AI Agents register (Airtable `tbl9msVjyQWslLOIZ`) with a per-stage scorecard. Gaps leave it at "Needs input"; its panel shows exactly what is missing.
5. Stages are editable on the agent's panel; "Run readiness check" re-scores the whole spec with the same rules as the video route (shared wording in `agenticPassRules()`).

---

## Agent state machine

- **Draft** — captured (video or form), not yet checked.
- **Needs input** — one or more stages are Thin or Missing. Questions issued.
- **Ready** — all seven stages Clear or justified Not Applicable.
- **Live** — owner has switched it on. The runtime now runs it.

Register agents additionally carry a build **Status** (Planned / Building / Built / Live / Paused), because a role agent exists as a plan before its runtime exists.

---

## Triggers: no blanket schedule (Kevin's ruling, 25 Aug 2026)

**Each agent runs on its own Go Signal, never on a shared timetable.** One agent's G may be "every morning", another's "twice a day", another's "when a payment lands" or "when a call is booked". The G stage is where that trigger is captured, and each agent's build session implements exactly that trigger. A shared morning run may still EXIST as plumbing, but only as the implementation of agents whose own G happens to be "daily morning" — it is never the reason an agent runs.

---

## Guardrail levels (per agent)

Kevin's three styles, one per agent, set at creation and changeable any time:

- **Autonomous** — does the whole job start to finish on its own. For low-stakes, easily-undone work.
- **Approval required** — prepares everything, acts only after a human yes. Nothing reaches the outside world unapproved.
- **Hybrid escalation** — runs the agreed process itself; anything outside the agreed path comes to a human first.

The always-ask list holds at every level: money, deletions, and anything only the owner can own always comes to Kevin first.

### Accuracy bands (Kevin's mechanism, 25 Aug 2026)

Every agent carries exactly **two metrics**: its **goal metric** (the `Score Metric` target vs the `Metric Score` current reading, filled by the agent's own runtime) and its **accuracy** (of the work Kevin checked, how much was right — per job type, never blended; the register headline shows the WORST job type).

Accuracy maps to a recommended guardrail band, judged on the worst job type once it has a real sample (**20+ checked pieces**):

| Worst job type accuracy | Band |
|---|---|
| below 70% | Approval required |
| 70–90%, or any recent rejection | Hybrid escalation |
| 90%+ with a clean recent run | Autonomous eligible |

**Tightening is automatic**: the register auto-moves an agent DOWN to its band on load and writes a dated line into its Learning Log. **Loosening is always Kevin's click** — the panel shows the suggestion, never acts on it. This is the 16 Jul owner-moves-the-gears ruling plus the 3 Aug auto-demote ruling, expressed as bands.

---

## The living prompt and the learning loop

Every register agent carries:

- **Agent Prompt** — the compiled full working prompt, built deterministically from the seven stages + guardrail level + always-ask list, with the Learning Log appended so every run applies what Kevin taught it. Compiled/recompiled from the agent's panel ("Compile prompt"). The stages ARE the prompt; there is no second source to drift.
- **Learning Log** — dated lessons. The dispatch engine appends a line whenever Kevin's approval feedback teaches the agent something (changes requested, rejections, corrections). Build sessions periodically fold stable lessons back into the stages themselves, then recompile.

The CEO reviews the whole workforce every morning as part of the daily brief: register statuses, accuracy, stuck approvals, and anything blocked.

---

## The seven stages

### A — Aim
- **Prompt:** "In a sentence or two, what is this process for, and why does it matter to the business?"
- **Captures:** the goal — why the process exists and what outcome it is responsible for.
- **Pass criteria:** a clear outcome and why it matters. A vague purpose fails.
- **Not Applicable:** never.
- **Follow-ups when thin:**
  - "What would the business lose if this never happened again?"
  - "If you handed this to someone new, what would you tell them it is FOR?"

### G — Go Signal
- **Prompt:** "What tells you it is time to do this? A set time, an email arriving, a new record, a payment landing, or someone asking? This trigger is specific to THIS agent — there is no blanket schedule."
- **Captures:** the trigger — per agent, per the no-blanket-schedule ruling above.
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
- **Prompt:** "Walk me through exactly what you do, step by step. Every time you make a choice, say how you decide and why. And when something odd comes up that the steps do not cover, what happens: best guess, skip it, or stop and ask you?"
- **Captures:** the steps AND the reasoning — the decision rules at each choice, and the when-unsure behaviour (guess / skip / escalate). This is the make-or-break stage, and it is where Chen's reasoning core lives.
- **Pass criteria:** the steps are in order AND every decision point has a stated rule AND the when-unsure behaviour is named. A pure click-sequence with no reasoning fails, even if it is long.
- **Not Applicable:** never.
- **Follow-ups when thin:**
  - "You said you pick the right one. How do you decide which is right? What do you look at?"
  - "When it hits something it has not seen before, what should it do: guess, skip, or ask you?"
  - "Is there a rule of thumb here you have never written down?"

### T — Tools & Transformations
- **Prompt:** "What do you actually change, create, or send? Name every system you write into."
- **Captures:** the actions and side-effects, and the tools needed to perform them.
- **Pass criteria:** every write, create, or send action and its target system is named, and the end state is described.
- **Not Applicable:** never. A process that changes nothing is a report, and its output still counts as the result.
- **Follow-ups when thin:**
  - "You update the record. Which fields exactly, and what do they end up saying?"
  - "Does anything get sent to anyone? Who, and what does it say?"

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
- **Captures:** the definition of done AND the ongoing score — the `Score Metric` the register tracks (e.g. "15 emails/day", "95% reconciliation accuracy").
- **Pass criteria:** a concrete finished state (what exists or has changed) plus a success measure. End state with no measure is Thin for an agent; the measure is optional for a human task.
- **Not Applicable:** never — every process has an end state.
- **Follow-ups when thin:**
  - "If you walked in the next morning, what would you look at to confirm it worked?"
  - "Over a month, what number or check would tell you this agent is earning its keep?"

_Amended 2026-07-06: the final C changed from Caveats to Conclusion; caveats folded into I._
_Amended 2026-08-24: C became Conclusion & Score (the score is Chen's fifth need)._
_Amended 2026-08-25: back to seven stages on Kevin's ruling — reasoning folded into N, acronym stays AGENTIC._

---

## The readiness scorecard

Shown on the workflow (video route) and on the agent's panel (register route, stored in the `Stage Scores` field). Each stage is one of: **Clear**, **Thin**, **Missing**, or **N/A** (with reason). The agent's overall state is derived from the worst stage. The scorecard is also surfaced on the business blueprint, so anyone (including a future buyer) can see at a glance which processes are fully captured.

The shared wording lives in `agenticCheckIntro()` / `agenticPassRules()` / `agenticResultShape()` in `os/systemisation/index.html`, used by BOTH routes so they can never drift.

---

## Design guardrails

- **Cap the asks.** Issue at most about three follow-ups at a time, the ones that most block building the agent. Three quick questions feels helpful; fifteen feels like homework and kills the slickness.
- **Allow Not Applicable, with limits.** Only I may be N/A (with a reason). A, G, E, N, T and C never — G resolves to "manual / on demand", T to "report only", rather than N/A. The single source is `AGENTIC_STAGES.naAllowed` in the page code; this list mirrors it.
- **Be strict on judgement.** An agent passes N only when the decision reasoning AND the when-unsure behaviour are present. This is the most common silent failure.
- **Make topping up easy.** Default to a typed or voice answer for small gaps. Re-recording is per stage, never the whole video, because the script is split by letter.
- **Frame it as help, not a grade.** "Great start. I just need three quick things to finish your agent."

---

## Meta-learning: the script improves itself

Track which stages most often come back Thin across all owners. If a stage is consistently weak, the prompt for that stage is the problem, not the owners. Use that signal to refine the master prompts. The script is versioned and treated as a single source of truth, the same approach as the boardroom mentor prompt.
