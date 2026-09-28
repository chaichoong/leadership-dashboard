---
name: tenant-doc-generator
description: Builds a new tenant's signing pack (assured shorthold tenancy agreement and proof of residency) from the brain templates with scripts/make-tenancy-pack.js, puts it into Adobe with info@agilelets.co.uk signing first, and sends it once Kevin has checked the signature boxes. Use when Kevin gives a new tenant's details and asks for tenancy documents, an AST, a proof of residency, or the documents for someone to move in.
---

# Tenant document generator (reviewed copy, 28 Sep 2026)

This replaces the claude.ai skill of the same name. That copy rendered an older layout with
WeasyPrint, which is not installed on Kevin's Macs, and its proof of residency had no
"Signed:" label, so Adobe could not place a box for it. The pack Kevin approved on
10 Sep 2026 comes from the brain templates through `scripts/make-tenancy-pack.js`.

The copy the app loads lives at `~/.claude/skills/anthropic-skills/tenant-doc-generator/`.
Edit this repo copy, then copy it there in the same commit
(`tests/tenant-doc-generator-skill.test.js` fails if they differ).

## Inputs: ask only for what is missing

- Tenant full name, email, mobile, date of birth.
- Property, by its Airtable short name (for example "5 Dalham Place").
- Start date. Defaults to today.
- Rent. The pack prints the property's one-bed housing allowance rate from
  `js/growth-plan-model.js`. If Kevin gives a different figure, stop and ask. Never print a
  rent he did not give.
- Rent due day. The agreement does not print it: the first payment is the start date
  (Kevin's precedent, 23 and 28 Sep 2026). Record it in `notes.md` for Airtable onboarding.

Working files go in the private Property project, in a dated folder:
`~/Projects/kevin-hq/property/<YYYY-MM-DD> <tenant> <property>/`. Never in this repo.

## Step 1: build the pack

```bash
node scripts/make-tenancy-pack.js --new --name "<Full Name>" --property "<Property>" --start <YYYY-MM-DD> --dry
node scripts/make-tenancy-pack.js --new --name "<Full Name>" --property "<Property>" --start <YYYY-MM-DD>
```

- Templates come from `~/knowledge-os/templates`, PDFs go to `~/knowledge-os/attachments`.
- The script picks the documents: the agreement, a proof of residency, and an authority to
  act except where Kevin dropped it (5 Dalham Place).
- If `~/knowledge-os` is not readable on this Mac (the host move of 27 to 28 Sep 2026 left a
  stub file on the Air), fill the same templates into the spec shape of `newTenantPack()` in
  that script and render each one with `node scripts/make-document.js --spec <spec.json> --out <folder>/<name>.pdf`.

Check before going on: read the PDF text back. Name, address, rent and dates are right, no
`[` placeholder is left, and no earlier tenant's name appears.

## Step 2: into Adobe, stop before Send

```bash
AGENT_UPLOAD_DIR="<folder>" node scripts/adobe-assign.js --document "<folder>/AST_<Name>_<Property>.pdf" \
  --signers info@agilelets.co.uk,<tenant email> --fields blocks:2,1 --page <last page> --shot "<folder>/adobe-AST.png"
AGENT_UPLOAD_DIR="<folder>" node scripts/adobe-assign.js --document "<folder>/Proof_of_Residency_<Name>.pdf" \
  --signers info@agilelets.co.uk --page 1 --shot "<folder>/adobe-PoR.png"
```

- info@agilelets.co.uk is ALWAYS the first recipient (memory `feedback_tenancy_signing_rules`).
- Quote the `saved draft: field N (...) is <email>` log lines as the proof. A screenshot
  alone is not proof.
- Auto-place can add a stray tick box where a page opens with the last line of a clause. The
  log shows it as an `other` box that is `unproven`. Delete it from the draft before Kevin
  sees it: open the draft, select that `[data-fieldid]` box on its own, press Delete, wait
  for Adobe's save (PUT to `dc-api-v2.adobe.io/.../assets`, 204), reopen and count the boxes.

## Step 3: Kevin checks the boxes

Send him both screenshots with SendUserFile. Then ask with AskUserQuestion: send both, turn
signing order on and send, or change something. Nothing is sent without his yes.

## Step 4: send

- Agreement: switch "Recipients must complete in order" ON (Kevin, 28 Sep 2026), then Send.
- Proof of residency: one recipient, Send.
- Proof of a send is Adobe's box "<name> was successfully sent for signature", or the name
  in `#agreement_type=agreement&agreement_state=waiting_for_you`.
- **A weak confirmation is never a reason to press Send again.** Read `waiting_for_you` and
  `completed` for the name first. Adobe's drafts list lags behind a send. On 28 Sep 2026 a
  retry made a second proof of residency after Kevin had already signed the first. Cancel a
  duplicate from Waiting for you > Cancel, with "Notify recipients" unticked.

## Step 5: info@ signs, so the tenant gets their link

With order on, the tenant's link goes out only once info@ has signed.

- On Kevin's say-so, sign through the robot's Adobe session: Waiting for you > select the row >
  View & Sign > "Click for Next Field" > Enter applies the account's saved signature > move
  the mouse off the tooltip > Submit.
- The saved signature is Kevin's. For a box signed as Roy Lavin, type "Roy Lavin" (Kevin,
  28 Sep 2026).
- Proof: the agreement moves to `agreement_state=waiting_for_others` and reads
  "Out for signature, 1 of 2 completed".

## Step 6: after signing

- The signed proof of residency goes to the tenant. On 28 Sep 2026 Kevin signed it and
  forwarded the signed copy himself. He is writing up his steps so this can be handed over.
- Airtable onboarding waits until EVERY document is signed. Kevin does it himself.
