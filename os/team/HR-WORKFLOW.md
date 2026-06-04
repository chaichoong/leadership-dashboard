# HR / Team Members — Workflow, Automations & Integration Guide

This document covers the HR / Team Members section (`os/team/`): what ships in **phase one**, every **automation and integration point**, the **onboarding and offboarding** flows end to end, and the **exact steps Kevin runs on merge** to make it all live.

A visual version of this lives at `os/team/workflow.html` (open it in the browser — simple enough for a 13-year-old to follow).

---

## 1. Scope

### Six components

| # | Component | Phase one (shipped now) | Phase two (deferred) |
|---|-----------|-------------------------|----------------------|
| 1 | **Team Member Records** | Directory + detail drawer: status, department, manager, personal info, emergency contact, contracts (`contractDocs`, `contractHR`), DOB, utilisation | — |
| 2 | **Org Chart** | Reporting tree built from the `manager` field | — |
| 3 | **Training Record** | Matrix of who is trained on which SOP/workflow | Auto-tick on task completion (automation) |
| 4 | **Reviews** | **Reviews-lite**: per-member review count + "needs review / on record" status, from existing `performanceReviews` link | Full 6-monthly cycle: review topics, scheduling, recurring prompt |
| 5 | **Handbook** | **Handbook-lite**: handbook link + per-member issued status, core-values/onboarding structure | Watch-and-acknowledge (each person confirms they read it) |
| 6 | **Achievements** | Record + display achievements per person | — |
| + | **Onboarding/Offboarding tracker** | Members grouped by lifecycle status with a data-derived completeness checklist | — |

### Constraints honoured this phase
- **Edited `os/team/index.html` only** — plus two new sibling files (`workflow.html`, `HR-WORKFLOW.md`) inside `os/team/`.
- **No shared files touched** (`js/config.js`, root `index.html`, `js/*`, `css/*`).
- **No new Airtable fields/tables added.** Components needing new schema are deferred to phase two; Kevin adds the field constants at integration.
- Built on branch `feature/team-members`, PR raised to `main`.

---

## 2. Data the module uses (all existing `config.js` constants)

Read-only from the **Team Members** table (`TEAM`) and friends. No fields were added.

- Identity/status: `preferredName`, `fullLegalName`, `name`, `status`, `active`, `startDate`, `dob`, `country`
- Org: `department`, `role`, `manager`, `jobTitle`, `business`
- Contact: `workEmail`, `whatsApp`, `slackHandle`, `emergencyName`, `emergencyPhone`
- Capacity: `workingDays`, `weeklyCapacity`, `utilisation`, `constraints`
- Documents: `contractDocs` (attachment), `contractHR` (link → Contract HR OS), `handbookLink`
- Linked records: `achievements`, `sops`, `sopsTask`, `performanceReviews`
- Related tables: `ACHIEVE`, `DEPT`, `ROLES`, `SOP`

> **Note on linked fields:** the module counts linked records with a length check (`linkCount`) so it is tolerant of both string-ID and `{id,name}` array shapes returned by the API.

---

## 3. Automations & integration points

Each point below is **where the section talks to the rest of the app**. Phase-one UI is in place; the wiring marked **(Kevin)** is finished at integration.

### A. Inbound Comms → contract pull  *(Kevin, phase one wiring)*
- **What:** a signed contract emailed in is labelled in Inbound Comms and attached to the correct person's record (`contractDocs`).
- **UI today:** the drawer surfaces `contractDocs` and `contractHR` whenever they are present.
- **To make live:** see §5, step 3.

### B. Systemisation → training-watch tasks  *(Kevin, phase two)*
- **What:** each workflow's SOPs generate a "watch this SOP" task assigned to the team member; completing the task ticks their Training grid.
- **UI today:** the Training matrix reads `sops` / `sopsTask` links and shows trained/not-trained per SOP.
- **To make live:** automation that flips the training link/lookup when the watch-task is completed (Airtable automation or the existing task pipeline).

### C. Tasks & Projects → assignments  *(Kevin, phase two)*
- **What:** training-watch tasks and offboarding to-dos live in Tasks & Projects, assigned to the person.
- **UI today:** training assignments are reflected via the SOP links above.

### D. Reviews cycle  *(phase two)*
- **What:** a 6-monthly review with a fixed topic set, a stored record per review, and a recurring prompt for the next one.
- **UI today:** Reviews-lite shows count + "needs review" from `performanceReviews`.
- **Needs:** a Performance Reviews table constant in `config.js`, plus fields for topics, review date, and next-due date.

### E. Handbook acknowledgement  *(phase two)*
- **What:** new starter reads the handbook and ticks to confirm; status shows on their record.
- **UI today:** Handbook-lite shows issued/not-issued from `handbookLink`; the "Acknowledged" column is a phase-two placeholder.
- **Needs:** an acknowledgement field (date/checkbox) on the Team Members table.

---

## 4. The two lifecycle workflows, end to end

### Onboarding (offer → complete record → training booked)
1. **Offer accepted** — create the Team Member record; set `status = Onboarding`. *(HR)*
2. **Contract signed** — signed contract arrives by email, is labelled in Inbound Comms, and is pulled onto the record (`contractDocs`). *(Inbound Comms — point A)*
3. **Record completed** — fill department, manager, personal info, emergency contact. Org chart updates automatically from `manager`. *(HR)*
4. **Training assigned** — assign role-relevant SOP-watch tasks from Systemisation; the Training grid begins to fill. *(Systemisation/Tasks — points B & C)*
5. **Handbook issued** — issue the handbook; new starter reads it and (phase two) acknowledges. *(HR — point E)*
6. **Go live** — set `status = Active`. They drop out of the Onboarding tracker and into active counts.

The Onboarding tracker's checklist (Work email, Manager assigned, Contract on file, SOPs assigned, Profile photo) gives an at-a-glance completeness score derived entirely from data already on the record.

### Offboarding (leaving → archived)
1. **Leaving confirmed** — set `status = Offboarding`; the person appears in the tracker. *(HR)*
2. **Exit checklist** — return equipment, revoke access, reassign open tasks/SOPs to others. *(Tasks — point C)*
3. **Record archived** — store final pay/documents on the record; org chart drops them from the live tree. *(HR)*
4. **Marked Offboarded** — set `status = Offboarded`. They leave active counts; the record is retained.

---

## 5. Kevin's merge-time ingrain steps

Run these **after merging `feature/team-members` to `main`**.

1. **Wire the page into the app shell** *(standard contributor step, per CONTRIBUTING.md §3)*
   - The module already exists in `PAGE_REGISTRY` and the sidebar as `os-team` → `os/team/index.html`, so the new tabs (Onboarding, Reviews, Handbook) appear automatically. No new registry entry is needed for phase one.
   - Confirm `pageVer` auto-bumped for `os/team/index.html` on push (GitHub Action).

2. **Confirm existing fields resolve** — open the page with a live PAT and check the new tabs render real data (Reviews counts, Handbook issued status, Onboarding checklist). All fields used already exist in `config.js`.

3. **Finish the Inbound Comms contract pull** *(point A)*
   - Create/confirm the **personnel-contract email label** route in Inbound Comms (`follow-up.html` / the Gmail script).
   - On a labelled signed contract, attach the file to the matching Team Member record's `contractDocs` (match on work email or name).
   - Once flowing, the drawer's Documents/HR Contract section displays it with no further front-end change.

4. **Phase two — add the deferred schema** (when ready), then lift the in-file deferrals:
   - **Reviews cycle (point D):** add a Performance Reviews table constant + topic/date/next-due fields to `config.js`; extend `renderReviews()` to read review detail and surface the recurring prompt.
   - **Handbook acknowledgement (point E):** add an acknowledgement field; replace the "Phase two" column in `renderHandbook()` with the real status.
   - **Training auto-tick (point B):** add the Airtable automation that flips the SOP/training link on watch-task completion.

5. **SOP & sitemap** — if this becomes a formally documented page, create/update `sop-*.html` for the HR section and add `os/team/workflow.html` to `sitemap.xml`. (Phase-one docs live in `os/team/`.)

---

## 6. Files in this change

- `os/team/index.html` — new tabs (Onboarding/Offboarding tracker, Reviews-lite, Handbook-lite) + HR details in the member drawer; existing tabs unchanged.
- `os/team/workflow.html` — AI-built visual workflow diagram (new).
- `os/team/HR-WORKFLOW.md` — this document (new).

No shared files were modified.

---

## 7. Coordination

Mica is on the **Meetings** module in a separate folder — no file overlap with `os/team/`. Phase one proceeded independently. HR content (real core values, handbook copy, review topics) is populated at integration.
