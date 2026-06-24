# AGENTIC Extraction Spec

The heart of the Systemisation module. It turns one short, scripted video from a business owner into an autonomous AI agent. The owner does one thing: record an AGENTIC video. The system extracts an SOP and an agent spec, checks it for gaps, asks for anything missing, and only then builds the agent.

This document defines, for each of the seven AGENTIC stages: the on-screen prompt the owner reads, what it captures, the pass criteria for "complete", whether it can be marked Not Applicable, and the follow-up questions the AI asks when the stage comes back thin.

---

## The flow

1. Owner places the workflow (customer journey, department, method).
2. Owner records one AGENTIC video, following the seven on-screen prompts.
3. AI turns the video into a transcript, an SOP, and a draft agent spec.
4. The AGENTIC readiness check scores all seven stages.
5. If any stage is Thin or Missing, the owner gets a short list of exact questions, and answers by text, voice note, or by re-recording just that one stage.
6. The check re-runs. When all seven pass (or are justified Not Applicable), the agent moves to Ready.
7. The owner switches it Live.

An agent can never go Live with an unresolved gap.

---

## Agent state machine

- **Draft** — video recorded, extraction done, not yet checked.
- **Needs input** — one or more stages are Thin or Missing. Questions issued.
- **Ready** — all seven stages Clear or justified Not Applicable.
- **Live** — owner has switched it on. The runtime now runs it.

---

## The seven stages

### A — Aim
- **Prompt:** "In a sentence or two, what is this process for? And how would you know it has been done right? What would tell you someone made a mistake?"
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
- **Captures:** the data and systems it reads.
- **Pass criteria:** every source touched is named, with what gets read from each.
- **Not Applicable:** never (every process reads something).
- **Follow-ups when thin:**
  - "You mentioned the spreadsheet. Anything else you check before deciding, another system or record?"
  - "What exact information do you pull from each place?"

### N — Navigate the Process
- **Prompt:** "Walk me through exactly what you do, step by step. Most important: every time you make a choice, say out loud how you decide and why you pick what you pick."
- **Captures:** the steps AND the decision rules. This is the make-or-break stage.
- **Pass criteria:** the steps are in order AND every decision point has a stated rule. A pure click-sequence with no reasoning fails, even if it is long. The check tests specifically for the "how I decide", not just for the presence of text.
- **Not Applicable:** never.
- **Follow-ups when thin:**
  - "You said you pick the right one. How do you decide which is right? What do you look at?"
  - "At this step you have options. What makes you choose one over another?"
  - "Is there a rule of thumb here you have never written down?"

### T — Tools & Transformations
- **Prompt:** "What do you actually change, create, or send? Name every system you write into, and describe what the finished result looks like."
- **Captures:** the actions and side-effects, and the tools needed to perform them.
- **Pass criteria:** every write, create, or send action and its target system is named, and the end state is described.
- **Not Applicable:** never. A process that changes nothing is a report, and its output still counts as the result.
- **Follow-ups when thin:**
  - "You update the record. Which fields exactly, and what do they end up saying?"
  - "Does anything get sent to anyone? Who, and what does it say?"

### I — Inspections
- **Prompt:** "Before you call it done, what do you check? And what would you never let go out without looking at it yourself?"
- **Captures:** the approval gate and the must-not-auto items.
- **Pass criteria:** the checks are named, and anything that must always have a human eye is flagged.
- **Not Applicable:** allowed, but rare. If the owner genuinely checks nothing, mark N/A with a reason and flag it as a risk for review.
- **Follow-ups when thin:**
  - "Is there anything here that, if it were wrong, would be costly or hard to undo? That is what we would always check."
  - "What does 'looks right' mean to you at the end?"

### C — Caveats
- **Prompt:** "What trips this up? The odd cases, the exceptions, and anything you must never do."
- **Captures:** the edge cases and the hard guardrails.
- **Pass criteria:** the known exceptions and any "never do" rules are captured, or an explicit "none I can think of".
- **Not Applicable:** allowed (explicit "none").
- **Follow-ups when thin:**
  - "Has this ever gone wrong? What happened?"
  - "Is there a situation where the normal steps do not apply?"
  - "Anything that would be a disaster if the agent did it by accident?"

---

## The readiness scorecard

Shown on the workflow. Each stage is one of: **Clear**, **Thin**, **Missing**, or **N/A** (with reason). The agent's overall state is derived from the worst stage. The scorecard is also surfaced on the business blueprint, so anyone (including a future buyer) can see at a glance which processes are fully captured.

---

## Design guardrails

- **Cap the asks.** Issue at most about three follow-ups at a time, the ones that most block building the agent. Three quick questions feels helpful; fifteen feels like homework and kills the slickness.
- **Allow Not Applicable, with limits.** E and N can never be N/A. A, G, T should resolve to a real value (use "manual / on demand", "report only", etc.). I and C may be N/A with a reason.
- **Be strict on judgement.** Navigate passes only when the decision reasoning is present, not when click-steps are present. This is the most common silent failure.
- **Make topping up easy.** Default to a typed or voice answer for small gaps. Re-recording is per stage, never the whole video, because the script is split by letter.
- **Frame it as help, not a grade.** "Great start. I just need three quick things to finish your agent."

---

## Meta-learning: the script improves itself

Track which stages most often come back Thin across all owners. If a stage is consistently weak, the prompt for that stage is the problem, not the owners. Use that signal to refine the master prompts. The script is versioned and treated as a single source of truth, the same approach as the boardroom mentor prompt.
