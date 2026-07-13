// ══════════════════════════════════════════
// SKILLS DATA — Static registry of all Claude Code / Cowork skills
// ══════════════════════════════════════════
// Updated: 2026-05-06
// To add a new skill, append an entry to SKILLS_LIBRARY below.
// The skill-creator skill auto-appends here after creating a new skill.

var SKILLS_LIBRARY = [

    // ── Property Management ──────────────────────────────────────────
    {
        id: 'airtable-tenant-onboarding',
        name: 'Tenant Onboarding',
        command: 'anthropic-skills:airtable-tenant-onboarding',
        description: 'End-to-end workflow that registers a new tenant, creates their tenancy record, links deposit and rent schedules, and sends welcome documents.',
        category: 'Property Management',
        source: 'custom',
        tags: ['tenant', 'onboarding', 'airtable', 'automation'],
        instructions: `---
name: airtable-tenant-onboarding
description: End-to-end workflow that resolves or creates a Rental Unit, adds a new tenant, creates their tenancy record, links the signed AST from Adobe Sign (Gmail), and flips the unit to Occupied. Use when the user wants to "onboard a new tenant" or "set up a new tenancy".
---

# Airtable Tenant & Tenancy Onboarding

End-to-end workflow for onboarding new tenants into the "Operations Director" Airtable system. Keeps Tenants, Tenancies, Rental Units and the signed AST reference fully in sync.

## Phase 0: Resolve the Rental Unit

Before anything else, locate the target Rental Unit.

- **Base**: \`Operations Director\` (\`appnqjDpqDniH3IRl\`) | **Table**: \`Rental Units\` (\`tblM3mZCR5kiEdWMj\`)
- Search by property + unit name/number provided by the user.
- If the unit exists and \`Unit Status\` is \`Void\` → use it, continue to Phase 1.
- If no \`Void\` unit exists at the property → Phase 0a.

## Phase 0a: Create a New Rental Unit (only when needed)

Triggered when the user explicitly requests a new unit OR no void unit exists at the property.

- Copy the schema of an existing unit at the same property (linked Property record, address fields, bedrooms/bathrooms, rent band defaults, etc.) to stay consistent.
- Set \`Unit Status\` to \`Void\` on creation — Phase 4 will flip it to \`Occupied\`.
- Save the new Rental Unit Record ID.

## Phase 1: Tenant Creation

### 1. Data Requirements
- **Tenant Name**: Full name.
- **Contact Number**: Phone number.
- **Email Address**: Primary email.
- **Date of Birth**: \`dd/mm/yyyy\`.
- **Rent Payment Type**: \`Universal Credit\` or \`Working\`.
- **Payment Day of Month**: Day of month rent is paid (1–31).

### 2. Execution (Tenant)
- **Base**: \`Operations Director\` | **Table**: \`Tenants\` (\`tblX4elTuu01gwBYh\`)
- **Fields**:
  - \`Tenant Status\`: \`Active\`.
  - \`Rent Payment Type\`: \`Universal Credit\` or \`Working\`.
  - \`Due Date of the Month\`: the Payment Day of Month.
  - All other fields as provided.
- **Action**: \`create_record\` → **save the Tenant Record ID**.

## Phase 2: Tenancy Creation

### 1. Data Requirements
- **Rental Unit Record ID** (from Phase 0 or 0a).
- **Tenancy Start Date**.
- **Expected Monthly Rent** (£).

### 2. Automated Logic
- **Customers** (\`fld1i5bDoHL3B6rUf\`): link to Tenant Record ID from Phase 1.
- **Rental Unit** (\`fld7cjLLEHKAx49OK\`): linked record array with Phase 0/0a unit.
- **Payment Frequency** (\`fld5O24mC8vOezjXK\`): \`Monthly\`.
- **Payment Status (Unified)** (\`fldxU3dPUnbK0SCDq\`): \`CFV\`.
  - **Why CFV, not CFV Actioned**: A tenancy can only be marked \`CFV Actioned\` once the UC47 has been submitted to DWP. We can't submit a UC47 until the tenant's UC claim has been verified by the government, which typically takes around a week from tenant documentation. Onboarding therefore always lands at \`CFV\`; the status moves to \`CFV Actioned\` later, as a separate step in the UC47 workflow.
- **Due Day of Month** (\`fldhy2U0CQmM2oS4P\`): **singleSelect — pass as a string** (e.g. \`"19"\`, not \`19\`). Integer values trigger a 422 "Cannot parse value".
- **Initial Rent Due Date** (\`fldlZKHKwmEUl7YPm\`):
  - If today is *before* the due day → current month.
  - If today is *on or after* the due day → next month.
- **Expected Monthly Rent** (\`fldDMyfZLFMeONPq8\`): as provided.
- **Tenancy Start Date** (\`fld2rPXwwV8dXb1zF\`): as provided.

### 3. Execution (Tenancy)
- **Base**: \`Operations Director\` | **Table**: \`Tenancies\` (\`tblN51a88qTDB6iMH\`)
- **Action**: \`create_record\` → save Tenancy Record ID.

## Phase 3: Link the Signed AST from Gmail

Store the Adobe Sign "Signed and Filed" email permalink on the tenancy record as the canonical reference to the signed AST.

### 1. Find the email
- **Inbox**: \`kevin@runpreneur.org.uk\`
- **Gmail search**: \`from:adobesign.com <Tenant Surname>\`
- **Pick the "Signed and Filed" thread** (subject contains \`is Signed and Filed!\`). Ignore the earlier "Out for Signature" thread.

### 2. Build the permalink
Format: \`https://mail.google.com/mail/u/kevin@runpreneur.org.uk/#all/<threadId>\`

### 3. Write to Airtable
- **Table**: \`Tenancies\` (\`tblN51a88qTDB6iMH\`)
- **Field**: \`Tenancy Agreement\` (URL, \`fldolJbKTPDSF9RwU\`)
- **Action**: \`update_records_for_table\` with the permalink.

> If no "Signed and Filed" email exists yet (sent but not signed), leave the field empty and note it in the summary — revisit when signing is complete.

## Phase 4: Update Rental Unit Status

- **Base**: \`Operations Director\` | **Table**: \`Rental Units\` (\`tblM3mZCR5kiEdWMj\`)
- **Field**: \`Unit Status\` (\`fldBvqysXBm9rIm0E\`) → \`Occupied\`.
- **Action**: \`update_record\` on the Rental Unit record ID from Phase 0/0a.

> If already \`Occupied\`, skip and note in the summary.

## Summary & Confirmation

Provide a table showing:
1. Rental Unit used or created (note if new).
2. Tenant record details incl. Rent Payment Type and Payment Day.
3. Tenancy record details and Initial Rent Due Date.
4. Tenancy Agreement link status (populated / pending).
5. Rental Unit status confirmation (Occupied).

**Universal Credit flag**: if \`Rent Payment Type\` is \`Universal Credit\`, call it out — the tenancy will sit at \`CFV\` until the UC claim is verified by DWP (usually about a week), at which point the UC47 can be submitted and the status moves to \`CFV Actioned\` via the UC47 workflow.

## Troubleshooting

- Phase 1 fails → stop; fix tenant record first.
- Phase 2 fails → stop; do not proceed to AST link or unit status flip.
- Rental Unit not found → run Phase 0a or search the Rental Units table for the correct linked record ID.
- \`Rent Payment Type\` field missing on Tenants → tell user it needs adding in Airtable.
- \`Due Day of Month\` 422 "Cannot parse value" → you passed an integer. Pass a string (\`"19"\`).
- Existing tenant being reused → skip Phase 1; pull Rent Payment Type and Due Date of the Month from the existing tenant record before Phase 2.
- Adobe Sign email not found → confirm which Gmail account the landlord uses; Gmail MCP must be connected. If the agreement is sent but not signed, leave the field blank and flag it.
- Tenancy created at \`CFV Actioned\` by mistake → revert to \`CFV\` until UC47 has actually been submitted; \`CFV Actioned\` is only valid post-submission.
`,
    },
    {
        id: 'airtable-tenant-creator',
        name: 'Tenant Creator',
        command: 'anthropic-skills:airtable-tenant-creator',
        description: 'Automates the process of adding a new tenant record to Airtable with all required fields, linked records, and validation.',
        category: 'Property Management',
        source: 'custom',
        tags: ['tenant', 'airtable', 'record creation'],
        instructions: `---
name: airtable-tenant-creator
description: Automates the process of adding new tenants to the "Tenants" table in the "Operations Director" Airtable base. Use when the user provides details for a new tenant or asks to "add a tenant".
---

# Airtable Tenant Creator

This skill provides a structured workflow for adding new tenant records to the Airtable system with correct field mappings and default values.

## Workflow

### 1. Data Collection
When a request is made to add a tenant, identify or request the following information:
- **Tenant Name**: Full name of the tenant.
- **Contact Number**: Phone number for the tenant.
- **Email Address**: Primary email for communication.
- **Date of Birth**: Format as \`dd/mm/yyyy\`.
- **Rent Payment Type**: How the tenant pays rent — either \`Universal Credit\` or \`Working\`.
- **Payment Day of Month**: The day of the month the rent payment is made (e.g., \`1\`, \`15\`). For Universal Credit tenants this is typically the UC payment date; for working tenants this is their standing order day.

### 2. Field Mapping and Defaults
Map the collected data to the Airtable fields as follows:

| Airtable Field | Value / Source |
| :--- | :--- |
| **Tenant Name** | Provided by user |
| **Contact Number** | Provided by user |
| **Email Address** | Provided by user |
| **Tenant Status** | Always set to \`Active\` |
| **Date of Birth** | Provided by user (\`dd/mm/yyyy\`) |
| **Rent Payment Type** | Provided by user (\`Universal Credit\` or \`Working\`) |
| **Due Date of the Month** | Provided by user (Number) — the Payment Day of Month |

**Note**: Do not populate fields for \`Tenant Surname\`, \`Tenancies\`, \`Notes\`, \`Tasks\`, \`Account Statement - Customers\`, \`Tenancies copy\`, \`Tenants**\`, or \`Record ID\`.

### 3. Execution
- Use the \`airtable\` MCP server.
- **Base**: \`Operations Director\`
- **Table**: \`Tenants\`
- Call the \`create_record\` tool with the mapped fields.

### 4. Confirmation
Once the record is created, confirm the success to the user and provide the record details for verification.

## Troubleshooting
- If the \`airtable\` tool returns a permission error, verify the \`baseId\` and \`tableId\` using \`list_bases\` and \`list_tables\`.
- If mandatory information is missing, ask the user specifically for the missing field before attempting to create the record.
- If \`Rent Payment Type\` is not yet a field in the Tenants table, inform the user it needs to be added to Airtable before this skill can populate it.
`,
    },
    {
        id: 'airtable-tenancy-creator',
        name: 'Tenancy Creator',
        command: 'anthropic-skills:airtable-tenancy-creator',
        description: 'Automates the creation of a new tenancy record including rent amount, start date, linked tenant, unit assignment, and deposit tracking.',
        category: 'Property Management',
        source: 'custom',
        tags: ['tenancy', 'airtable', 'record creation', 'rent'],
        instructions: `---
name: airtable-tenancy-creator
description: Automates the creation of new tenancy records in the "Tenancies" table of the "Operations Director" Airtable base. Designed to run immediately after adding a new tenant.
---

# Airtable Tenancy Creator

This skill manages the creation of tenancy records, ensuring they are correctly linked to tenants and rental units while automating date and status fields.

## Base & Table IDs

- **Base**: \`appnqjDpqDniH3IRl\` (Operations Director)
- **Table**: \`tblN51a88qTDB6iMH\` (Tenancies)

## Field IDs (Tenancies table)

Use these exact field IDs — do NOT rely on name-matching. Several fields on this table have similar names (e.g. "Payment Status (Unified)" vs "Previous Payment Status"), and using the wrong ID silently writes to the wrong column.

| Field Name | Field ID | Type |
| :--- | :--- | :--- |
| Tenants | \`fld1i5bDoHL3B6rUf\` | multipleRecordLinks |
| Rental Unit | \`fld7cjLLEHKAx49OK\` | multipleRecordLinks |
| Tenancy Start Date | \`fld2rPXwwV8dXb1zF\` | date |
| Tenancy End Date | \`fldwHhhKAq4f1nY9e\` | date |
| Expected Monthly Rent | \`fldDMyfZLFMeONPq8\` | currency (£) |
| Payment Frequency | \`fld5O24mC8vOezjXK\` | singleSelect |
| Due Day of Month | \`fldhy2U0CQmM2oS4P\` | singleSelect |
| **Payment Status (Unified)** | **\`fldxU3dPUnbK0SCDq\`** | singleSelect |

### ⚠ Field ID traps — do not confuse these

- **Payment Status (Unified)** = \`fldxU3dPUnbK0SCDq\` ← set this to \`CFV Actioned\` on new tenancies
- **Previous Payment Status** = \`flduge874bzHT3sqB\` ← DO NOT touch on new tenancies (has the same "CFV Actioned" option but is a historic-tracking field)
- **(Deprecated) Payment Status (Auto)** = \`fldygw9bpwt7zalm7\` — formula, read-only
- **Payment Status (Derived / Debug)** = \`fld5LTWtWlNQ9mNgS\` — formula, read-only
- **Payment Status (AR Fixed)** = \`fldaYUMG4o15YhCeU\` — formula, read-only
- **Payment Status (Auto) Legacy** = \`fldhNesqy6QBilZuE\` — formula, read-only

### Option IDs for key singleSelects

- **Payment Frequency** (\`fld5O24mC8vOezjXK\`): \`Monthly\` / \`4-Weekly\` / \`Fortnightly\` / \`Weekly\`
- **Payment Status (Unified)** (\`fldxU3dPUnbK0SCDq\`): \`In Payment\` / \`CFV\` / \`CFV Actioned\` / \`Void\`
- **Due Day of Month** (\`fldhy2U0CQmM2oS4P\`): \`1\`–\`31\` (as strings)

## Workflow

### 1. Prerequisite & Linking
This skill should ideally trigger after a new tenant has been added using the \`airtable-tenant-creator\` skill.
- **Tenants**: This is a linked record field. Populate it with the **Record ID** of the tenant created in the previous step.

### 2. Information Gathering
Request the following details from the user if not already provided:
- **Rental Unit**: The name or ID of the property unit (linked record).
- **Tenancy Start Date**: The date the tenancy begins.
- **Expected Monthly Rent**: The monthly rent amount in pounds.

### 3. Automated Logic & Defaults
Apply the following logic to populate fields automatically:

| Airtable Field | Field ID | Logic / Default Value |
| :--- | :--- | :--- |
| **Payment Frequency** | \`fld5O24mC8vOezjXK\` | Always set to \`Monthly\`. |
| **Payment Status (Unified)** | \`fldxU3dPUnbK0SCDq\` | Always set to \`CFV Actioned\`. |
| **Rent Payment Type** | (on Tenant record) | Inherit from the tenant (\`Universal Credit\` or \`Working\`). |
| **Due Day of Month** | \`fldhy2U0CQmM2oS4P\` | Inherit from the tenant's "Payment Day of Month" field. |
| **Initial Rent Due Date** | (calculated) | Next occurrence of the "Due Day of Month" following the start date. |

**Important — Universal Credit tenants**: If \`Rent Payment Type\` is \`Universal Credit\`, flag this clearly in the confirmation output. These tenants feed into the cash flow forecast UC chase-up workflow.

#### Calculating Initial Rent Due Date
1. Identify the **Due Day of Month** (e.g., 15).
2. Determine the current date.
3. If the current day is *before* the due day, the date is in the current month.
4. If the current day is *on or after* the due day, the date is in the following month.

### 4. Execution
- Use the \`airtable\` MCP server.
- **Base**: \`appnqjDpqDniH3IRl\` (Operations Director)
- **Table**: \`tblN51a88qTDB6iMH\` (Tenancies)
- Call \`create_records_for_table\` with the gathered and automated fields, keyed by **field ID** (not field name).

### 5. Post-Creation Updates
After creating the tenancy, also update:
- **Rental Units** table: set the linked unit's \`Unit Status\` (\`fldBvqysXBm9rIm0E\`) to \`Occupied\`.
- **Tenants** table: add the new Rental Unit record ID to the tenant's \`Current Unit\` (\`fldeLsZYqbKS77S2V\`) field, preserving any existing links.

### 6. Confirmation
Confirm the tenancy creation to the user, highlighting:
- Tenancy record ID
- Start date, rent, frequency, due day
- Rent Payment Type (flag if Universal Credit)
- Confirmation that Rental Unit is now Occupied and Tenant's Current Unit is updated

## Troubleshooting
- **Linked Record Errors**: If the "Rental Unit" provided doesn't match an existing record, search the "Rental Units" table first to find the correct ID.
- **Data Sync**: If "Due Day of Month" or "Rent Payment Type" is missing from the tenant record, ask the user to clarify before proceeding.
- **Wrong Payment Status field written**: If \`flduge874bzHT3sqB\` (Previous Payment Status) was populated by mistake on a new tenancy, clear it with \`null\` and set \`fldxU3dPUnbK0SCDq\` (Payment Status Unified) to the intended value instead.
`,
    },
    {
        id: 'airtable-tenancy-ender',
        name: 'Tenancy Ender',
        command: 'anthropic-skills:airtable-tenancy-ender',
        description: 'Automates the process of ending a tenancy — marks records inactive, calculates final balances, triggers deposit return workflow, and updates void tracking.',
        category: 'Property Management',
        source: 'custom',
        tags: ['tenancy', 'end', 'void', 'deposit return'],
        instructions: `---
name: airtable-tenancy-ender
description: Automates the process of ending a tenancy in the 'Operations Director' Airtable base. It updates the Tenancies, Tenants, and Rental Units tables by setting the tenancy end date, clearing the payment status, removing the tenant's current rental unit, changing the tenant status to 'Former', and setting the rental unit status to 'Void'. Use when a user requests to end a tenancy for a specific tenant or tenancy record.
license: Complete terms in LICENSE.txt
---

# Airtable Tenancy Ender Skill

This skill automates the multi-table updates required to formally end a tenancy within the 'Operations Director' Airtable base. It ensures data consistency across linked records.

## Usage

To use this skill, you will need the **Record ID of the Tenancy** to be ended and the **End Date**.

### Workflow

1.  **Identify Tenancy**: Provide the Record ID of the tenancy you wish to end.
2.  **Specify End Date**: Provide the date on which the tenancy officially ends in \`YYYY-MM-DD\` format.

### Script Execution

Execute the \`end_tenancy.py\` script with the required arguments:

\`\`\`bash
python /home/ubuntu/skills/airtable-tenancy-ender/scripts/end_tenancy.py <tenancy_record_id> <end_date_YYYY-MM-DD>
\`\`\`

### Affected Tables and Fields

This skill updates the following tables and fields in the 'Operations Director' Airtable base:

| Table          | Field Name                  | Action                                      |
| :------------- | :-------------------------- | :------------------------------------------ |
| **Tenancies**  | \`Tenancy End Date\`          | Set to the provided end date.               |
| **Tenancies**  | \`Payment Status (Unified)\`  | Cleared (set to blank).                     |
| **Tenants**    | \`Current Unit\`              | Cleared (unlinked from the rental unit).    |
| **Tenants**    | \`Tenant Status\`             | Set to 'Former'.                            |
| **Rental Units** | \`Unit Status\`             | Set to 'Void'.                              |

## References

-   For detailed Airtable schema information (Base ID, Table IDs, Field IDs, and choice IDs), refer to: \`/home/ubuntu/skills/airtable-tenancy-ender/references/airtable_schema.md\`
`,
    },
    {
        id: 'tenant-complaint-handler',
        name: 'Tenant Complaint Handler',
        command: 'anthropic-skills:tenant-complaint-handler',
        description: 'Handles tenant complaints by logging the issue, categorising severity, creating follow-up tasks, and drafting acknowledgement communications.',
        category: 'Property Management',
        source: 'custom',
        tags: ['tenant', 'complaint', 'maintenance', 'communication'],
        instructions: `---
name: tenant-complaint-handler
description: Handles tenant complaints and issues end-to-end. Triggers when Kevin describes a new tenant problem, complaint, or maintenance issue. Sources all relevant context from Airtable, Gmail (kevin@runpreneur.org.uk), Google Drive, and GHL before drafting a professional reply. The reply sounds like Kevin, is firm but fair, and closes with "Kind regards, Erica / (sent on behalf of Kevin Brittain)". Use when Kevin says things like "new complaint", "tenant issue", "tenant is saying", "problem at [property]", or describes a tenant situation that needs a written response.
---

# Tenant Complaint Handler

Handles inbound tenant complaints and issues by sourcing all context first, then drafting a response for Kevin's approval before sending.

## Workflow

### Phase 1 — Source Context

When Kevin describes a complaint or issue, immediately pull context from all available sources before forming any opinion or drafting a reply.

Run these checks in parallel where possible:

**Airtable (Operations Director base)**
- Search Tenants table for the tenant by name or property address
- Pull their current tenancy record: unit, rent amount, tenancy start date, rent status
- Check Tasks table for any open or recent tasks related to this tenant or property
- Note any prior issues or flags on the record

**Gmail (kevin@runpreneur.org.uk)**
- Search for emails from or about the tenant (name, property address, unit)
- Look for prior complaints, maintenance requests, or correspondence
- Note dates and any commitments made previously

**Google Drive**
- Search for tenancy agreement, inspection reports, inventory, or correspondence for the property/unit
- Look for any Schedule of Works or maintenance records

**GHL (GoHighLevel)**
- Check contact record for the tenant
- Review any conversation history, notes, or pipeline status

**Evernote / NotebookLM / ClickUp** — note these are not directly accessible via tool. Flag to Kevin if relevant context may exist there and ask if he wants to check manually.

---

### Phase 2 — Summarise What You Found

Before drafting the reply, present a short summary to Kevin:

\`\`\`
TENANT: [Name]
PROPERTY: [Address / Unit]
ISSUE: [Brief description of complaint]
CONTEXT FOUND:
- Airtable: [key facts]
- Gmail: [prior correspondence summary]
- Google Drive: [relevant docs]
- GHL: [contact/conversation notes]
RISKS / FLAGS: [anything that changes how we should respond]
\`\`\`

Ask: "Happy for me to draft the reply based on this, or anything to add?"

If Kevin says go ahead, proceed to Phase 3. If he adds context, incorporate it first.

---

### Phase 3 — Draft the Reply

Write the reply as Kevin. Rules:

- Tone: direct, professional, fair — not overly warm or apologetic unless the complaint is clearly valid
- If the complaint is valid: acknowledge it, state what action will be taken and by when
- If the complaint is unclear or disputed: ask for more detail or clarify the facts
- If the complaint is unreasonable: hold the position firmly but respectfully
- Never make commitments Kevin hasn't approved
- Keep it short — no more than 3–4 short paragraphs
- No corporate filler language ("We appreciate your patience", "Thank you for bringing this to our attention" etc.)

**Sign-off — always end with:**
\`\`\`
Kind regards,
Erica
(sent on behalf of Kevin Brittain)
\`\`\`

---

### Phase 4 — Present for Approval

Show Kevin the draft and ask:
- "Approve to send?"
- "Any amendments?"

Do not send or create any record until Kevin confirms.

---

### Phase 5 — Post-Approval Actions

Once Kevin approves:

1. **Create an Airtable task** using the \`airtable-task-creator\` skill if any action is needed (e.g. repair, inspection, follow-up call). Assign to the relevant team member.
2. **Log the complaint** — note in the tenant's Airtable record or Tasks table that this complaint was received and responded to, with today's date.
3. **Draft or send the reply** — if via email, use Gmail draft. If via GHL/SMS, note the message for Kevin to send from GHL directly (Claude cannot send GHL messages).

---

## Key Reference Data

- Kevin's email: kevin@runpreneur.org.uk
- Airtable base: appnqjDpqDniH3IRl
- Assignee IDs: Mica \`usrP7K5pmPSdVVgTN\` | Karlo \`usrDzGmjTIMQyhbYN\` | Giezel \`usrGsYHMqg493dipW\` | Ericamae \`usrejWz04hiXxxgVa\`
- Sign-off: "Kind regards, Erica / (sent on behalf of Kevin Brittain)"

---

## Example Output

**Draft reply:**

> Hi [Tenant Name],
>
> I've looked into this. [Issue acknowledgement or factual response]. [Action being taken / timeline, if applicable]. [Any condition or clarification needed].
>
> If you have anything further, reply to this message.
>
> Kind regards,
> Erica
> (sent on behalf of Kevin Brittain)
`,
    },
    {
        id: 'tenant-doc-generator',
        name: 'Tenant Document Generator',
        command: 'anthropic-skills:tenant-doc-generator',
        description: 'Generates standardised tenant documents — tenancy agreements, welcome packs, notice letters, rent increase letters, and reference requests.',
        category: 'Property Management',
        source: 'custom',
        tags: ['tenant', 'documents', 'letters', 'agreements'],
        instructions: `---
name: tenant-doc-generator
description: Generates standardized tenant documents (AST and Proof of Residency) using predefined templates and tenant-specific variables. Use when the user provides tenant details (name, address, rent, rent amount, start date) to prepare documents for e-signing.
---

# Tenant Document Generator

Produces two PDFs ready to upload to e-signing software:

1. **Assured Shorthold Tenancy (AST) Agreement**
2. **Proof of Residency Letter** (on Agile Lets letterhead)

Output matches the visual format of the reference PDFs in
\`/sessions/clever-great-carson/mnt/Claude/Templates/\` (AST_Daniel_Gathercole.pdf and
ProofofResidency_Daniel_Gathercole.pdf).

## Variables Required

Collect the following before running. If any are missing, ask Kevin with
AskUserQuestion rather than guessing.

- **Tenant Name** (full legal name)
- **Tenant Address** (full address: street, town, county, postcode)
- **Rent amount** (monthly, e.g. 897.52 — script normalises to £897.52)
- **Tenancy start date** (any common UK format — script normalises to e.g. "17th April 2026")

## Airtable Address Lookup

If the user supplies only a tenant name or a partial address, look up the
full address in Airtable **before** running the script:

- Base: **⚙️ Operations Director** (\`appnqjDpqDniH3IRl\`)
- Table: **Tenants** — search by name, follow the linked Rental Unit / Property
  records to pull street, town, county and postcode.

Never assume an address. Always confirm with the user before rendering the
PDFs.

## Usage Workflow

1. **Collect Information**: Ensure all four required variables are present.
2. **Look up full address** in Airtable if the user gave a short form.
3. **Run the generator**: the script writes both PDFs straight to disk — no
   intermediate markdown, no external PDF converter.
4. **Deliver**: provide \`computer://\` links to the PDFs and confirm they are
   ready for e-signing.

### Command

\`\`\`bash
python3 ~/.claude/skills/tenant-doc-generator/scripts/generate_docs.py \\
  --name "Kinga Gnerowicz" \\
  --address "14 Wentworth Terrace, Haverhill, Suffolk, CB9 9BP" \\
  --rent "897.52" \\
  --start-date "17 April 2026" \\
  --out "/sessions/clever-great-carson/mnt/Claude/Claude Outputs/Tenant Docs"
\`\`\`

Flags:

- \`--name\` — tenant full legal name
- \`--address\` — comma-separated: street, town, county, postcode
- \`--rent\` — monthly rent, with or without £
- \`--start-date\` — any readable UK date (e.g. "17/04/2026", "17 April 2026", "2026-04-17")
- \`--out\` — output directory (defaults to current working directory)

Output filenames:

- \`AST_<First>_<Last>.pdf\`
- \`ProofofResidency_<First>_<Last>.pdf\`

## Dependencies

The script uses \`weasyprint\` for PDF rendering. Install once:

\`\`\`bash
pip install weasyprint --break-system-packages
\`\`\`

## Important Constraints

- **Do not amend** any sections referring to **Kevin Brittain** (Landlord) or
  **Roy Lavin** (Agile Lets signatory). The script hardcodes these.
- **UK English** throughout.
- **Dynamic Break Clause**: clause 9 uses the tenancy start date that was
  passed in. It is no longer hardcoded.
- **Signatures**: the AST finishes with two signature lines — Tenant and
  Kevin Brittain (Landlord). The PoR ends with a signature line and
  "Roy Lavin" below, plus the Agile Lets footer.

## Resources

- Script: \`scripts/generate_docs.py\`
- Legacy markdown templates (for reference only): \`templates/\`
- Reference PDFs on Kevin's disk:
  \`/sessions/clever-great-carson/mnt/Claude/Templates/AST_Daniel_Gathercole.pdf\`
  \`/sessions/clever-great-carson/mnt/Claude/Templates/ProofofResidency_Daniel_Gathercole.pdf\`
`,
    },
    // contractor-job-creator skill RETIRED 2026-05-08 — superseded by the
    // contractor-bot Slack flow (#property-management) which has the same
    // capabilities (per-contractor business resolution, property matching,
    // confirmation prompt, contractor DM) without needing a local install
    // or a bearer token. Office team logs contractor jobs via Slack on the
    // go, or via the dashboard's "Add Task" form for power-user entry.
    // See scripts/slack-automation/CONTRACTOR-TASK-PATHS.md.
    {
        id: 'schedule-of-works',
        name: 'Schedule of Works',
        command: 'anthropic-skills:schedule-of-works',
        description: 'Professional property survey tool — generates a detailed schedule of works with costings, priorities, and contractor assignments for refurbishment or maintenance programmes.',
        category: 'Property Management',
        source: 'custom',
        tags: ['survey', 'refurbishment', 'maintenance', 'costings'],
        instructions: `---
name: schedule-of-works
description: Professional property surveying and Schedule of Works generation. Use when a user provides a video walkthrough of a property and needs a comprehensive, "idiot-proof" defect report and repair guide for contractors.
---

# Schedule of Works Pro

This skill automates the process of analyzing property walkthrough videos to identify defects and generate a professional, contractor-ready Schedule of Works.

## Core Workflow

### 1. Initial Video Analysis
- **Transcription:** Use \`manus-speech-to-text\` to capture all verbal descriptions of defects.
- **Visual Scan:** Extract frames at 1-second intervals for a broad overview of the property.
- **Defect Mapping:** Cross-reference audio mentions with visual evidence. Note the exact timestamp/frame for every issue.

### 2. Evidence Capture Standards
- **Clarity:** Screenshots must be high-quality and clearly show the defect.
- **Context:** If a defect is small (e.g., a screw hole), capture both a close-up and a wide shot for location context.
- **Verification:** Double-check that the image exactly matches the defect described (e.g., ensure a kitchen drawer handle photo actually shows the drawer, not just a door).

### 3. "Check & Amend" Review Process
Before finalizing the report, MUST perform a point-by-point review in the chat with the user:
1. Present items one-by-one (e.g., "Point 1 of 12").
2. Attach the specific image for that point.
3. Provide the Issue Description and Required Action.
4. Ask for approval ("Yes", "Remove", or "Amend").
5. Only proceed to the next point after the user responds.

### 4. Technical Writing Guidelines
- **Idiot-Proof Instructions:** Avoid vague terms like "Fix" or "Repair". Use specific, professional-standard instructions (e.g., "Sand, prime, and apply two coats of white satinwood paint").
- **Item IDs:** Use a room-based prefix system (e.g., FG-01 for Front Garden, K-01 for Kitchen).
- **Categorization:** Organize the final report by room or area.

## Final Output Structure

The final report MUST be delivered in both Markdown and PDF formats, including:
- **Project Header:** Property address, date, and status.
- **Structured Tables:** Grouped by room, containing Item ID, Visual Reference (embedded images), Description, and Required Action.
- **General Section:** For site-wide tasks like waste removal or deep cleaning.

## Pro Tips for Perfection
- **Redundant Items:** Always ask the user whether to dispose of or store redundant items (e.g., TV brackets, old furniture).
- **Lighting:** If a light fitting is mentioned, always check if it needs both a bulb AND a lampshade.
- **Learning from Feedback:** If a user corrects a photo, re-scan the video specifically around that timestamp (+/- 5 seconds) to find the exact frame they are referring to.
`,
    },
    {
        id: 'uc47-form-automation',
        name: 'UC47 Form Automation',
        command: 'anthropic-skills:uc47-form-automation',
        description: 'Automates the completion of UC47 forms for Universal Credit tenants — pulls tenant and tenancy data, fills the form fields, and prepares for submission.',
        category: 'Property Management',
        source: 'custom',
        tags: ['universal credit', 'UC47', 'forms', 'benefits'],
        instructions: `---
name: uc47-form-automation
description: Automates the completion of the UC47 Director-Landlord payment form for Universal Credit tenants. Use when the user requests to apply for direct rent payments or rent arrears for a tenant.
---

# UC47 Form Automation

This skill guides the process of completing the UC47 form on the DWP website for Universal Credit tenants.

## Workflow

### 1. Information Gathering
- **Source**: Use the \`airtable\` MCP server to retrieve tenant and tenancy details from the "Operations Director" base.
- **Tenant Table**: Retrieve Full Name, DOB, Address, and Postcode.
- **Tenancy Table**: Retrieve Rent Amount and Frequency.
- **Missing Data**: If rent arrears are being claimed, ask the user for:
  - Total arrears amount (£).
  - Date of first missing payment.
  - Date of most recent missing payment.
- **Reference**: Use the tenant's **Surname** as the "Payment Reference".

### 2. Form Navigation
- **URL**: [https://directpayment.universal-credit.service.gov.uk/](https://directpayment.universal-credit.service.gov.uk/)
- **Initial Choice**: Select based on user request (Direct Rent, Arrears, or Both).
- **Missed Rent**: Answer "Yes" if arrears >= 2 months, otherwise "No".

### 3. Data Entry
- **Landlord Details**: Use fixed details from \`references/landlord_data.json\`.
- **Bank Details**: Use fixed details from \`references/landlord_data.json\`.
- **Email Verification**:
  - The form will send a code to \`kevinbrittain@gmail.com\`.
  - Use the \`gmail\` MCP tool to find the most recent email from "Universal Credit" or "DWP" containing a verification code.
  - Extract and enter the code.

### 4. Review and Submission
- **Check Page**: Once the "Confirm your details" page is reached, **take a screenshot**.
- **User Approval**: Present the screenshot to the user and request explicit confirmation before clicking "Submit".

## Reference Data
- Landlord and Bank details are stored in \`/home/ubuntu/skills/uc47-form-automation/references/landlord_data.json\`.

## Error Handling
- If a verification code doesn't arrive within 2 minutes, notify the user.
- If Airtable data is missing or ambiguous, ask for clarification.
`,
    },
    {
        id: 'commercial-loan-agreement-generator',
        name: 'Commercial Loan Agreement',
        command: 'anthropic-skills:commercial-loan-agreement-generator',
        description: 'Generates a commercial loan agreement document with customisable terms, interest rates, repayment schedules, and security provisions.',
        category: 'Property Management',
        source: 'custom',
        tags: ['loan', 'agreement', 'commercial', 'finance', 'legal'],
        instructions: `---
name: commercial-loan-agreement-generator
description: Generates a commercial loan agreement from variable inputs, calculates repayment details, and prepares for optional Adobe Sign integration, Airtable fixed cost creation, and Airtable task creation for standing orders. Use when a user provides details for a new commercial loan and requires agreement generation, repayment scheduling, and associated administrative tasks.
---

# Commercial Loan Agreement Generator

This skill automates the generation of commercial loan agreements and associated administrative tasks based on provided variable inputs.

## Functionality

The skill performs the following actions:

1.  **Agreement Generation**: Populates a Markdown template with loan-specific details to create a draft commercial loan agreement and automatically converts it to a professional PDF format.
2.  **Repayment Calculation**: Calculates the monthly repayment amount, first repayment date, and termination date based on the loan principal, interest rate, and term.
3.  **Administrative Task Preparation**: Prepares data for optional integration with Adobe Sign for e-signing, Airtable for recording fixed costs, and Airtable for creating a task to set up standing orders.

## Required Inputs

The following inputs are required to generate the loan agreement and associated details:

| Input Field                      | Description                                                               |
| :------------------------------- | :------------------------------------------------------------------------ |
| \`borrower_legal_name\`            | Legal name of the borrowing entity.                                       |
| \`borrower_company_number\`        | Company registration number of the borrower.                              |
| \`borrower_registered_office\`     | Registered office address of the borrower.                                |
| \`lender_full_name\`               | Full name of the lending individual or entity.                            |
| \`lender_address\`                 | Full address of the lender.                                               |
| \`lender_email\`                   | Email address of the lender for notices.                                  |
| \`borrower_email\`                 | Email address of the borrower for notices.                                |
| \`loan_amount\`                    | Principal amount of the loan in GBP.                                      |\\n| \`actual_advance_date\`            | The date the loan was actually advanced (e.g., "28 February 2026").       |
| \`interest_rate\`                  | Annual interest rate as a percentage (e.g., 8.00).                        |
| \`default_interest_rate\`          | Annual default interest rate as a percentage (e.g., 12.00).               |
| \`term_months\`                    | Loan term in months (e.g., 60).                                           |
| \`repayment_day_of_month\`         | The day of the month repayments are due (e.g., "28").                     |
| \`lender_repayment_bank_name\`     | Name of the lender\\'s bank for repayments.                                 |
| \`lender_repayment_sort_code\`     | Sort code of the lender\\'s repayment account.                              |
| \`lender_repayment_account_number\`| Account number of the lender\\'s repayment account.                         |
| \`governing_law\`                  | The governing law for the agreement (e.g., "England and Wales").          |
| \`unsecured_or_secured\`           | Whether the loan is "unsecured" or "secured".                           |

## Derived Values

The skill automatically calculates the following values:

*   **Effective Date**: Same as \`actual_advance_date\`.
*   **Repayment Start Date**: The next \`repayment_day_of_month\` after the \`effective_date\`.
*   **Termination Date**: \`repayment_start_date\` plus \`term_months\` minus 1 month, aligned to the \`repayment_day_of_month\`.
*   **Monthly Repayment**: Amortised payment based on \`loan_amount\`, \`interest_rate\`, and \`term_months\`.
*   **Standing-order setup task due date**: \`first_repayment_date\` minus 7 days.

## Workflow

1.  **Collect Variables**: Gather all required inputs from the user.
2.  **Validate Fields**: Ensure all required fields are present and valid.
3.  **Generate Agreement**: Populate the \`commercial_loan_agreement_template.md\` with the provided and derived variables.
4.  **Output Draft**: Present the populated agreement for user review.
5.  **Optional Adobe Sign Integration**: If approved, upload the agreement to Adobe Sign and send it to the lender and borrower for e-signing. (Future enhancement)
6.  **Create Fixed Cost Record**: Add the monthly repayment as a fixed cost record in Airtable. (Future enhancement)
7.  **Create Airtable Task**: Create an Airtable task due one week before the first payment to set up the standing order. (Future enhancement)
8.  **Return Summary**: Provide a summary of key dates, monthly payment, and confirmation of created records.

## Usage

To use this skill, provide the required inputs in a JSON format to the \`generate_loan_agreement.py\` script. The script will output a summary of the generated agreement and calculated values.

\`\`\`bash
python /home/ubuntu/skills/commercial-loan-agreement-generator/scripts/generate_loan_agreement.py \\n\\'{ \\
    "borrower_legal_name": "TNT MANAGEMENT LIMITED", \\
    "borrower_company_number": "09634334", \\
    "borrower_registered_office": "17 Newington, Willingham, Cambridge, CB24 5JE", \\
    "lender_full_name": "Paul Brittain", \\
    "lender_address": "59 Earith Road, Willingham, Cambridge, CB24 5LS", \\
    "lender_email": "pauljooee@hotmail.com", \\
    "borrower_email": "kevinbrittain@gmail.com", \\
    "loan_amount": 2000, \\
    "actual_advance_date": "28 February 2026", \\
    "interest_rate": 8.00, \\
    "default_interest_rate": 12.00, \\
    "term_months": 60, \\
    "repayment_day_of_month": "28", \\
    "lender_repayment_bank_name": "J E Brittain", \\
    "lender_repayment_sort_code": "09-01-28", \\
    "lender_repayment_account_number": "44385270", \\
    "governing_law": "England and Wales", \\
    "unsecured_or_secured": "unsecured" \\
}\\'
\`\`\`

**Minimal First Iteration (Current Capability)**:

Currently, the skill focuses on Phase 1:

*   Generate agreement from template with variables.
*   Automatically convert the agreement to a PDF file.
*   Show populated draft for checking.
*   Calculate first repayment and standing-order task date.

Future iterations will include Adobe Sign integration, Airtable fixed cost creation, and Airtable task creation.
`,
    },
    {
        id: 'adobe-sign-field-setup',
        name: 'Adobe Sign Field Setup',
        command: 'anthropic-skills:adobe-sign-field-setup',
        description: 'Configures Adobe Sign document fields for e-signatures — maps form fields, sets signing order, and prepares the document template for automated sending.',
        category: 'Property Management',
        source: 'custom',
        tags: ['adobe sign', 'e-signature', 'documents', 'automation'],
        instructions: `---
name: adobe-sign-field-setup
description: >
  Use this skill whenever Adobe Sign is involved in sending a document for e-signature.
  Handles the full Adobe Sign "Request e-signatures" workflow: adding recipients in sequential
  order, reassigning auto-placed signature fields to the correct signers, dealing with the
  Chrome extension viewport conflict, and clicking Send. Always trigger this skill when the
  user asks to send a document for signing, set up e-signatures, upload to Adobe Sign, or
  when preparing any legal or commercial document (contracts, loan agreements, deeds, etc.)
  that needs multiple parties to sign. Also trigger when the user mentions Adobe Sign field
  colours (purple/green/pink), "Change recipients", "auto-place fields", or reports that a
  signer is missing fields.
---

# Adobe Sign Field Setup

## What this skill does

Guides Claude through the complete Adobe Sign "Request e-signatures" workflow, including the
critical post-upload step of reassigning signature fields to the correct signers. Adobe Sign's
auto-place feature has a known issue: it assigns ALL detected fields to signer 2 (green) by
default, leaving signer 1 (and any subsequent signers) with no fields. This skill captures
the exact sequence of steps to fix this, plus workarounds for a persistent Chrome extension
viewport conflict that breaks screenshots and clicks after any scroll or page navigation.

---

## Recipient setup

1. Open the document in Adobe Sign's "Request e-signatures" mode.
2. In the left panel under **ADD RECIPIENTS**, ensure **"Recipients must complete in order"**
   toggle is ON. Sequential order is essential — each party signs only after the one above
   them completes.
3. Add recipients in the signing order you need. Typical pattern for a bilateral agreement
   with a shared witness:
   - Signer 1: Party A director/signatory
   - Signer 2: Party B director/signatory
   - Signer 3: Witness (signs last for both parties)
4. Click **Auto-place fields**. Adobe Sign will scan the document for signature-related
   text and add fields.

> ⚠️ After auto-place, ALL fields will appear green (assigned to signer 2). This is the
> bug you need to fix before clicking Send.

---

## Field colour coding

| Colour | Signer |
|--------|--------|
| Purple | Signer 1 (first in order) |
| Green  | Signer 2 |
| Pink / Red | Signer 3 |

When you see a field labelled "Signature — [Party A Director]" but it's green instead of
purple, it is assigned to the wrong person and must be reassigned.

---

## Reassigning a field to the correct signer

1. Take a screenshot to confirm the current state (no scrolling yet — see conflict section).
2. **Left-click** the field that needs reassigning. A context menu appears with:
   - Change field type
   - **Change recipients** ← this is the one
   - Signature type
   - Required field
   - Customise field
3. Hover over **Change recipients**. A submenu shows all recipients with a checkmark next
   to the currently assigned one.
4. Click the correct recipient. The field border colour will immediately change to match
   that signer's colour.
5. Take a screenshot to confirm the colour has changed before moving on.

Repeat for every incorrectly assigned field. Typical reassignments for a two-party agreement
with shared witness (after auto-place assigns everything to signer 2):

| Field | Correct signer | Action needed |
|-------|---------------|---------------|
| Party A Director — Signature | Signer 1 | Reassign green → purple |
| Party A Director — Full Name | Signer 1 | Reassign green → purple |
| Party A Director — Title/Position | Signer 1 | Reassign green → purple |
| Party A Director — Date | Signer 1 | Reassign green → purple |
| Party A Witness — Signature | Signer 3 | Reassign green → pink |
| Party A Witness — Full Name | Signer 3 | Reassign green → pink |
| Party A Witness — Date | Signer 3 | Reassign green → pink |
| Party B Director — Signature | Signer 2 | Already correct ✓ |
| Party B Director — Full Name | Signer 2 | Already correct ✓ |
| Party B Director — Title/Position | Signer 2 | Already correct ✓ |
| Party B Director — Date | Signer 2 | Already correct ✓ |
| Party B Witness — Signature | Signer 3 | Reassign green → pink |
| Party B Witness — Full Name | Signer 3 | Reassign green → pink |
| Party B Witness — Date | Signer 3 | Reassign green → pink |

Adjust this table to match the actual document structure (e.g. a single-party document
will have fewer fields; a three-party deal will have more signers).

---

## The Chrome extension viewport conflict

Adobe Sign in Chrome triggers a recurring error:
\`Cannot access a chrome-extension:// URL of different extension\`

**What causes it**: Any action that moves the PDF viewport — scrolling (wheel or programmatic),
clicking the "Go to next/previous page" arrows, or using JavaScript \`scrollTop\` — fires an
event that conflicts with a co-installed Chrome extension. Once triggered, all subsequent
\`screenshot\` and \`zoom\` calls fail until the state is cleared.

**What does NOT trigger it**:
- Taking a screenshot immediately after a full page load
- Clicking buttons that don't move the viewport (e.g. zoom in/out up to ~4 clicks, context
  menus, recipient reassignment)
- Typing into the page-number textbox and pressing Enter (navigates without triggering —
  use this instead of the arrow buttons)
- \`scroll_to\` with an element ref (uses \`scrollIntoView\`, slightly safer but still risky at
  large distances)

**Recovery sequence** (run this whenever a screenshot fails with the extension error):
\`\`\`
1. navigate(tabId, "https://www.adobe.com")   — clears the extension state
2. wait 5 seconds
3. navigate(tabId, <original Adobe Sign URL>)  — reload the document
4. wait 15 seconds                             — wait for full render
5. screenshot()                                — should now work
\`\`\`
The original URL is the full \`https://acrobat.adobe.com/id/...\` with all query parameters.
Save it at the start of the workflow so you can restore it after any reset.

**Working pattern to avoid the conflict**:
- After each recovery, take a screenshot immediately (no scrolling)
- Interact with whatever is visible
- If you need to see a different part of the document, use the page-number textbox:
  - Use \`read_page(filter="interactive")\` to find the ref for \`"Go to page number"\` textbox
  - Use \`left_click(ref=<ref>)\`, select-all, type the page number, Enter
  - Take a screenshot — this navigation method does NOT reliably trigger the conflict
- Avoid clicking the "Go to previous/next page" arrow buttons — they reliably trigger it

**If scroll is unavoidable**: Use the **zoom-out button** (bottom-right of the viewer) to
reduce the document zoom level so more content fits in the initial viewport. 3–5 clicks of
zoom-out typically lets you see 2–3 pages at once. Do NOT use more than ~5 zoom-out clicks
in a single session — repeated clicking can also eventually trigger the conflict.

---

## Navigating to the execution / signature block

The execution block (where signature fields live) is typically near the end of a formal
legal document. To get there without triggering the conflict:

1. After fresh load + screenshot, use \`read_page(filter="interactive")\` to find the
   \`"Go to page number"\` textbox ref.
2. \`left_click(ref=<textbox ref>)\` → \`key("cmd+a")\` → \`type("<page number>")\` → \`key("Return")\`.
3. Take a screenshot. If the execution block is visible, interact directly.
4. If it's not quite visible (e.g., it's in the lower half of the loaded page), try zooming
   out 2–3 times, then use the page-number method again.

---

## Sending the document

Once all fields show the correct colours:
1. Click the **Send** button (blue button at the bottom of the left panel).
2. If Adobe Sign shows a **"Signature field missing"** warning dialog:
   - This means at least one signer has zero fields assigned to them.
   - Click **"Return to document"**.
   - Use \`read_page\` or a fresh screenshot to identify which signer's colour is absent from
     the document fields (e.g., no purple fields = signer 1 has nothing).
   - Reassign at least one signature field to that signer.
   - Click Send again.
3. On success, Adobe Sign shows a green tick with:
   *"[document name] was successfully sent for signature"*

   All recipients receive emails in the configured order. Once all have signed, Adobe Sign
   sends the completed PDF to everyone automatically.

---

## Quick reference: common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| \`screenshot\` fails with extension error | Viewport moved (scroll/nav) | Recovery sequence above |
| "Signature field missing" on Send | A signer has no fields | Reassign a field to that signer |
| All fields are green after auto-place | Adobe Sign bug — assigns all to signer 2 | Reassign each field per the table above |
| Context menu doesn't appear on click | Extension conflict state | Recovery sequence, then click immediately after screenshot |
| Page number textbox not found in \`read_page\` | Refs changed after interaction | Re-run \`read_page(filter="interactive")\` to get updated refs |
| Clicking zoom button triggers conflict | Too many rapid clicks | Do max 3–4 zoom clicks per session; recover if needed |

---

## Typical full workflow summary

\`\`\`
1. Open Adobe Sign → Request e-signatures
2. Add recipients in signing order, enable "must complete in order"
3. Click Auto-place fields
4. Take screenshot — confirm all fields are green (signer 2)
5. Navigate to execution block (page-number textbox method)
6. For each incorrectly assigned field:
   a. Left-click field → Change recipients → select correct signer
   b. Screenshot to confirm colour changed
7. If conflict triggered: run recovery sequence, resume from step 5
8. Click Send
9. Handle any "Signature field missing" dialog
10. Confirm green tick success screen
\`\`\`
`,
    },

    // ── Finance ──────────────────────────────────────────────────────
    {
        id: 'transaction-reconciler',
        name: 'Transaction Reconciler',
        command: 'anthropic-skills:transaction-reconciler',
        description: 'Daily reconciliation of financial transactions — categorises unreconciled bank transactions, matches against expected payments, and flags discrepancies.',
        category: 'Finance',
        source: 'custom',
        tags: ['reconciliation', 'transactions', 'bank', 'matching'],
        instructions: `---
name: transaction-reconciler
description: Daily reconciliation of financial transactions in the Operations Director Airtable base. Use when the user asks to reconcile transactions, categorise bank transactions, run reconciliation, process unreconciled items, or when triggered on a daily schedule. Matches unreconciled transactions against the full history of 7,400+ reconciled transactions using Account Alias + Vendor matching, suggests Chart of Accounts Category and Sub Category, links to all associated records (Business, Cost, Property, Unit, Tenancy, Team Member) where historical precedent exists, handles split transactions for multi-unit properties, uses AI inference for genuinely new vendors, learns from Kevin's amendments after every run, posts a summary to Slack after approval, and tracks correction accuracy over time.
---

# Transaction Reconciler

Reconcile unreconciled transactions in the Operations Director Airtable base by matching against the full history of reconciled transactions. **Self-improving: every run that requires Kevin's amendments must end with the skill updated to capture those amendments as permanent rules.**

## Prerequisites
- Airtable MCP connected to Operations Director base (\`appnqjDpqDniH3IRl\`)
- Slack MCP connected for posting to \`#reconciliation\` (channel ID: \`C0AMNU29V7Z\`)

## Linked Fields

| Field | Field ID | Notes |
|---|---|---|
| Business (For Reports) | fldX1aFlJyzpXGhbF | Inferred from Category, not Account |
| Costs | fldGkpkVqSeiGvUGL | Cost record (e.g. mortgage, fixed cost) |
| Property | fldvp44VfF8uTTthp | Property address |
| Unit | fldJGIhSbgXNIEW4a | Rental unit within property |
| Tenancy | fldPmAMmxwqs4SdPa | Active tenancy |
| Team Member | fldMwliSwEhLuumvd | Assigned team member |
| Tenants | fldTVrkgXICUCvxaI | READ-ONLY lookup — never write |

## Workflow

### Phase 1 — Load context
Use the structured \`filters\` parameter on \`list_records_for_table\`, NOT \`filterByFormula\` (silently ignored). Filter on \`fldxKX1IbIFcAOnn5 = false\`. Always pass \`fieldIds\` and \`pageSize\` (e.g. 200).

For historical matches, query reconciled transactions filtered by exact vendor + account alias. Do NOT pull all 7,400+ records at once.

### Phase 2 — Vendor matching
- High: 3+ consistent matches → suggest Cat/Sub Cat AND every linked field that ALL matches agree on (each field independently).
- Medium: mixed → mode + [Mixed History] prefix.
- Low: 1–2 matches → [Low Volume] prefix.
- AI Inferred: no vendor match but sensible inference → [AI Inferred] prefix.
- No Match: [No Match] flag.
Business inferred from Category, never inherited from Account.

### Phase 5 — Approval dashboard

Generate \`reconciliation-YYYY-MM-DD.html\` in outputs. Dark theme. Max width 1500px.

**MANDATORY column layout — non-negotiable.** Every linked-record field MUST be a dedicated, always-visible column in the main table. Linked records MUST NOT be hidden in Notes, in expandable detail panels, in tooltips, or in a single combined "Links" column.

Columns, in this exact order:
\`Date | Account | Amount | Vendor/Name | Category | Sub Category | Business | Cost | Property | Rental Unit | Tenancy | Tenant | Team Member | Confidence | Notes\`

Empty linked cells render \`—\` in muted colour. Notes column is for rationale ONLY — never linked-record data.

**Mandatory dashboard buttons (top right):**
- **Save SKILL.md to clipboard** — copies the latest skill source so Kevin can paste it back into \`~/.claude/skills/transaction-reconciler/SKILL.md\`. This button must be present on every dashboard.

### Phase 6 — Apply (after approval)
Resolve Cat/Sub Cat record IDs by querying the Chart of Accounts - Categories table (\`tbleWb8ioptnEwPR8\`) and Sub Categories table (\`tblOTdRcPf8AgRz25\`). Write Category, Sub Category and every approved linked record via \`update_records_for_table\` in batches of 10. Linked records as plain string arrays \`["recXXX"]\`. Tick Reconciled, clear Reconcile Requested.

### Phase 7 — Slack
Post summary to #reconciliation ONLY after Phase 6 completes.

### Phase 8 — Self-improvement (MANDATORY after every run with amendments)
After Kevin reviews the dashboard and gives any amendments:
1. Capture every amendment as a permanent rule below in the **Learned Rules** section.
2. Rebuild the dashboard with corrections applied.
3. Re-render the dashboard with the **Save SKILL.md to clipboard** button containing the updated skill source.
4. Tell Kevin to click Save SKILL.md and paste it into the skill file.
5. Only then apply Phase 6 writes.

The objective is zero amendments. Every amendment Kevin makes is a skill defect. Each defect must be patched in the Learned Rules section so it never happens again.

---

## LEARNED RULES (auto-updated by Phase 8)

These rules override generic AI inference. Apply them without exception.

### Mortgage interest payments — always link Property
Every mortgage interest payment has an account/loan reference number. Cross-reference the reference number to the Cost record, which is itself linked to a Property. ALWAYS populate Property on mortgage payments.

| Vendor | Reference contains | Cost (link) | Property (link) |
|---|---|---|---|
| TOGETHER COMMERCIAL FINANCE | 10210721 | Together loan 10210721 | (lookup at apply time) |
| TOGETHER COMMERCIAL FINANCE | 10207194 | Together loan 10207194 | (lookup at apply time) |
| BHAM MIDSHIRES | 6092231472 | BHam Midshires 6092231472 | (lookup at apply time) |
| TMW DDR | 12330194/1224013 | TMW 12330194 | (lookup at apply time) |
| Secure Trust Bank | 016369061 | Secure Trust 016369061 | **MUST be linked — Kevin's explicit instruction** |

→ Category: Operating Expenses, Sub Category: Mortgage Interest, Business: Real Estate.

### Rental income — Aigburth pattern
COLLINS S faster payment with reference "AIGBURTH" → Property: Aigburth (look up by name in the Property table). Pull active Tenancy/Unit from the property record.
→ Category: Revenue, Sub Category: Rental Income, Business: Real Estate.

### Transfers — Category AND Sub Category are both "Transfers"
Do not use "Credit Card Payment" or "Intercompany Transfer" as sub-categories. Both fields are simply "Transfers".
Applies to:
- AmEx PAYMENT RECEIVED (inflow) and matching Santander → AmEx outflow
- TNT MANAGEMENT LIMITED transfers (Santander)
- KEVIN BRITTAIN Transfer entries (TNT Zempler)

### Cash machine withdrawals — NOT personal
NOTEMACHINE / ATM cash withdrawals on Santander are NOT personal cash. They are Real Estate reactive maintenance for **22 Newton Street**.
→ Category: COGS, Sub Category: COGS Reactive Maintenance, Business: Real Estate, Property: 22 Newton Street.

### Gary Marsh contractor payments
→ Category: Capital Expenditure, Sub Category: Capital Expenditure, Business: Real Estate.
- Parse property reference from \`*Name\` (e.g. "1406 Oldham" → 1406 Oldham, "5 Woodcock" → 5 Woodcock) and link Property only.
- Do NOT set Team Member (Gary Marsh is not a team member).
- Do NOT set Rental Unit.
- Property is the only linked record beyond Business + Cat + Sub Cat.

### Paul Brittain loan inflows
→ Category: Loan Receipt, Sub Category: Loan Receipt. Match historical Paul Brittain loan entries.

### Joo Ee Brittain loan repayments
JOO EE BRITTAIN bill payments with "LOAN" reference → look up the matching Loan Repayment cost in the Costs table by matching the reference date (e.g. "LOAN 280226" → 28-02-2026 loan period) and link the Cost.

### Shelley Co
SHELLEY CO faster payment → Operating Expenses / Professional Fees / Real Estate.

### Monese CB account — ALL transactions are Personal NOT tax deductible
Every Monese CB transaction (Marks & Spencer, One Stop, Cafe Dansant, Palmers Store, food, etc.) → Business: Personal, Category: **Personal Expense Not Tax Deductible**. Never use "Personal Expense Tax Deductible" for Monese. Sub Category by vendor type:
- Food / supermarket / cafe → Personal Discretionary Food & Drink
- New Look (clothing) → **Personal Discretionary Lifestyle Costs**
- Pleasurebeachamuse / leisure → **Discretionary Lifestyle**
- Other personal items → Personal Discretionary

### Small inflows / sweepstakes
Sweepstakes prize and similar tiny credits on Monese → Category: Personal Income, Sub Category: **Personal Income Other**, Business: Personal.

### Willingham Wolves
WILLINGHAM WOLVES (AmEx) → Business: Personal, Category: **Personal Expense Not Tax Deductible**, Sub Category: **Discretionary Lifestyle**. No linked Cost.

### AmEx interest, credit for interest, and payment received — NO linked Cost
AmEx interest charges, credits for interest charges, "PAYMENT RECEIVED" (AmEx side), and the matching Santander → AMERICAN EXPRESS outflow must NOT have a linked Cost record. Leave Costs empty.
- Interest charges → Operating Expenses / Interest / Real Estate (no Cost link)
- Credit for interest → contra to above (no Cost link)
- Payment received (AmEx inflow) → Transfers / Transfers (no Cost link)
- Santander → AMERICAN EXP outflow → Transfers / Transfers (no Cost link)

---

## Notes
- Use structured \`filters\`, never \`filterByFormula\`.
- Linked record writes only when ALL historical matches agree on that field, OR a Learned Rule applies.
- Tenants is read-only; populate via Tenancy.
- Business inferred from Category, not Account.
- Slack notifications post-approval only.
- **Phase 5 dashboard always renders every linked-record field as its own column. Non-negotiable.**
- **Phase 8 always runs after amendments — no run is "complete" until the skill has been updated and Kevin has been given the Save SKILL.md button.**
`,
    },
    {
        id: 'cash-flow-forecast',
        name: 'Cash Flow Forecast',
        command: 'anthropic-skills:cash-flow-forecast',
        description: 'Generate a 30-day rolling cash flow forecast using live Airtable data — rent due, costs payable, and known invoices to project daily balances.',
        category: 'Finance',
        source: 'preset',
        tags: ['cash flow', 'forecast', 'projection', 'balance'],
        instructions: `---
name: cash-flow-forecast
description: Generate a 30-day rolling cash flow forecast combining Santander and TNT Mgt Zempler accounts. Use when the user asks to forecast cash flow, predict upcoming balances, check what's coming in and out, plan payments, or asks "what does cash flow look like". Pulls live synced balances from Airtable, projects rental income from active tenancies, and maps fixed costs due within the window. Outputs an interactive HTML dashboard with chart and expandable daily breakdown, saved as a file the user can open in Chrome.
---

# 30-Day Cash Flow Forecast

Generate a combined 30-day cash flow forecast for the Santander and TNT Mgt Zempler accounts using live Airtable data.

## Prerequisites

- Airtable MCP connected to Operations Director base (\`appnqjDpqDniH3IRl\`)

## Key IDs

### Tables
- Accounts: \`tbl1nr0EcX2T62KME\`
- Costs: \`tblx5kvhzNEI5TFlS\`
- Tenancies: \`tblN51a88qTDB6iMH\`
- Transactions: \`tbln0gzhCAorFc3zB\`

### Account Records
- Santander: \`rec3LiEiifomEHlvy\` (Account Alias: \`Santander\`)
- TNT Mgt Zempler: \`recsR9QhRKYwgV8oP\` (Account Alias: \`TNT Mgt Zempler\`)

### Field Reference
See \`references/field-ids.md\` for complete field mappings.

## Workflow

### Phase 1: Get Opening Balance

1. Fetch both account records from Accounts table (\`tbl1nr0EcX2T62KME\`) using \`list_records_for_table\` with \`recordIds\`: \`["rec3LiEiifomEHlvy", "recsR9QhRKYwgV8oP"]\`.
2. Read field \`**GBP\` (\`fldhDG5jDA8Tu2JyI\`) from each record — this is the live synced bank balance.
3. Sum both values to get the **combined opening balance**.
4. Note today's date as Day 0.

### Phase 2: Load Active Costs (Money Out)

1. Fetch all costs from Costs table (\`tblx5kvhzNEI5TFlS\`).
   - Filter: Account Alias lookup (\`fldX2QMLkSYzDEpIF\`) contains "Santander" OR "TNT Mgt Zempler".
   - Since Account Alias is a lookup field and cannot be directly filtered, fetch costs linked to the two account records. Use the Accounts linked field (\`fldeTNeeUFfD3JZm2\`).
   - **Alternative approach:** Fetch all costs, paginate, then filter client-side by checking \`fldX2QMLkSYzDEpIF\` for "Santander" or "TNT Mgt Zempler".
2. Fields needed: Cost Name (\`fldS6FYfpkhu6tJG0\`), Expected Cost (\`fld9JibXkMpTeMcxw\`), Due Day of Month (\`fld7IsfiGvKpxEwSs\`), Frequency (\`fldvozTHvs5VH3lNi\`), Payment Status (\`fldXZNI96v8HgjuSh\`), Account Alias (\`fldX2QMLkSYzDEpIF\`), Paid This Period? (\`fldcfmqSaWYfWBQ56\`), Inactive (\`fldQJPGLFMbwVelsW\`), Due Date Next (\`fldQZBF4JzBsmWU87\`), Due Date This Period (\`fld0NPreZFBMPKb6C\`), Days Until Due This Period (\`fldOomc6d9Jlx1lWU\`).
3. **Filter criteria** — include costs where:
   - Payment Status is one of: \`In Payment\` (selGrWUm5NkfcY607), \`Active\` (selwuotKAoizHJl6z), \`Overdue\` (selGB3gE7Bg7jKoIS), \`Due Today\` (selZazCz6gUJJ8Pl8), \`Upcoming\` (selypOeFtsBePQG1E).
   - Inactive checkbox (\`fldQJPGLFMbwVelsW\`) is NOT ticked.
   - Exclude: \`Paused\` (selzQhQoQQXe3DXMK), \`Inactive\` (sel5UTLLcZTdRVq6m).

### Phase 3: Load Active Tenancies (Money In)

1. Fetch tenancies from Tenancies table (\`tblN51a88qTDB6iMH\`).
   - Filter: Payment Status (Unified) (\`fldxU3dPUnbK0SCDq\`) = \`In Payment\` (\`sel4I99slfpd7Vc1t\`) OR \`CFV Actioned\` (\`selmhFXah5Bodgg9x\`).
   - Exclude: \`CFV\` (\`sel2mWzsvOd8d8de0\`), \`Void\` (\`selx5WZMIWgrHrPOj\`).
2. Fields needed: Tenancy Reference (\`fldyNVvFn4x8GY14q\`), Expected Monthly Rent (\`fldDMyfZLFMeONPq8\`), Due Day of Month (\`fldhy2U0CQmM2oS4P\`), Payment Frequency (\`fld5O24mC8vOezjXK\`), Paid This Month? (\`fldSNk1LWWcu517CA\`), Next Rent Due Date (\`fldSPslO6Wh5IUSK3\`), Tenant Surname (\`fldOXazTqBWieEOK2\`).

### Phase 4: Project Due Dates onto 30-Day Grid

**CRITICAL RULE — Due Day of Month Logic (applies to BOTH costs and tenancies):**

Use the \`Due Day of Month\` singleSelect field as the sole determinant for when a payment falls due. Do NOT use \`Paid This Period?\`, \`Paid This Month?\`, or any other payment status fields to decide inclusion.

The logic is:
- If \`Due Day of Month\` >= today's day of month → the payment is due THIS month on that day (it hasn't happened yet).
- If \`Due Day of Month\` < today's day of month → the payment already happened this month, so it's due NEXT month on that day.
- If Due Day is 29/30/31 and the target month has fewer days, use the last day of that month.
- After calculating the first due date, also check if a second occurrence falls within the 30-day window (e.g. a cost due on the 23rd when today is the 22nd would be due tomorrow, and again on April 23rd — but only if April 23rd is within 14 days).

The opening balance (synced **GBP) already reflects all transactions that have cleared. Since payments that have already happened this month will have already affected the synced balance, the due day logic naturally prevents double-counting: past due days map to next month, future due days map to this month.

For each day from today (Day 0) through Day 30:

#### Costs (Money Out)
For each active cost, determine if it falls due on this day:

**Monthly costs:** Apply the Due Day of Month logic above.

**Weekly costs:** Use \`Due Date (Next)\` (\`fldQZBF4JzBsmWU87\`) as the anchor date. Project forward in 7-day intervals to find all dates within the window. Also project backwards from the anchor to catch any occurrences before it.

**Fortnightly costs:** Same as weekly but 30-day intervals from anchor.

**4-Weekly costs:** Same but 28-day intervals from anchor.

**Quarterly costs:** Check the Due Day of Month for the current month and next 3 months. Include any that fall within the window.

**Annually costs:** Check if the Due Day in any month within the window matches.

**Daily costs:** Include on every day in the window.

#### Tenancies (Money In)
For each active tenancy, apply the same Due Day of Month logic:

**Monthly tenancies (most common):** Apply the Due Day of Month rule. All active tenancies are monthly unless Payment Frequency says otherwise.

**Weekly/Fortnightly/4-Weekly tenancies:** Use \`Next Rent Due Date\` (\`fldSPslO6Wh5IUSK3\`) as anchor, project forward at the appropriate interval.

### Phase 5: Build and Present the Forecast

Calculate the daily forecast grid:

\`\`\`
Day 0 (today): Opening Balance = £X,XXX.XX (Santander: £X,XXX.XX + TNT Zempler: £X,XXX.XX)

For each day 0-30:
  Starting Balance = previous day's Ending Balance (or Opening Balance for Day 0)
  Money In = sum of all rent due this day
  Money Out = sum of all costs due this day
  Ending Balance = Starting Balance + Money In - Money Out
\`\`\`

#### Output Format — HTML Dashboard

**ALWAYS output the forecast as an interactive HTML file** saved to the outputs folder as \`cash-flow-forecast-YYYY-MM-DD.html\` and provide the user with a \`computer://\` link to open it in Chrome.

Generate the HTML using a Python script. The HTML file must include all of the following:

**1. Dark theme styling**
- Background: \`#0f172a\`, text: \`#e2e8f0\`, cards: \`#1e293b\` with \`#334155\` borders.
- System fonts: \`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\`.
- Max width \`1100px\`, centred.

**2. KPI cards row** (6 cards in a responsive grid):
- Opening Balance (with Santander/TNT sub-line)
- Total Money In (green \`#4ade80\`)
- Total Money Out (red \`#f87171\`)
- Net Change (green if positive, red if negative)
- Final Balance
- Lowest Balance (amber \`#fbbf24\` with date)

**3. Line chart** using Chart.js 4.x from \`https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js\`:
- Closing balance over 30 days.
- Blue line (\`#60a5fa\`) with light fill.
- Points below £500 shown in amber, below £0 in red.
- Y-axis formatted with \`£\` prefix. X-axis shows \`Day DD/MM\`.
- Tooltip shows \`£X,XXX.XX\` on hover.
- Height 250px, responsive.

**4. Interactive daily breakdown table**:
- Columns: Date, Opening, Money In (green), Money Out (red), Net, Closing, Items (badge showing count).
- Each summary row is **clickable** to expand/collapse itemised detail rows underneath.
- Detail rows show individual tenancies (▲ green prefix) and costs (▼ red prefix) in a responsive multi-column grid.
- Within each category, sort items largest amount first.
- Weekend rows get a subtle darker background tint.
- Risk days (closing < £500) get an amber background tint.
- All monetary amounts use \`font-variant-numeric: tabular-nums\` for alignment.
- Table header is sticky.
- Scrollable container with \`max-height: 70vh\`.
- Hint text: "Click any row to expand itemised details".

**5. Risk flags section** at the bottom:
- Amber text for warnings, green for "no risks".
- Same thresholds as Phase 6 below.

**6. Footer** showing data source and sync timestamp.

**7. Print-friendly** — include \`@media print\` block switching to white background and dark text.

**In the chat response**, provide:
- A brief summary: opening balance, net change, final balance, lowest balance with date, and key risk flags.
- The \`computer://\` link to the HTML file.
- Keep the chat summary concise — the detail lives in the HTML file.

### Phase 6: Risk Flags

Include in the HTML risk flags section if any of these conditions are met:

- **Negative balance warning:** Any day where the ending balance drops below £0.
- **Low balance warning:** Any day where the ending balance drops below £500.
- **Large single outgoing:** Any single cost > £1,000 due in the window.
- **Concentration risk:** Multiple large costs (>£500 each) falling on the same day.

If no risks: show \`✅ No risk flags for this period.\`

## Error Handling

- If Airtable API errors on a fetch, report the error clearly and continue with available data.
- If an account's **GBP balance appears stale (check \`Last Successful Update\` field \`fld8HOlbBrXbHesoA\`), warn: "⚠️ [Account] balance last synced [date] — may not reflect recent transactions."
- If a cost has no Due Day of Month set, skip it and note it in a footnote.
- If a tenancy has no Expected Monthly Rent, skip it and note it.

## Notes

- This skill reads data only — it never writes to Airtable.
- The opening balance uses the live synced **GBP field, which reflects all transactions already processed by the bank.
- **Do NOT use \`Paid This Period?\` or \`Paid This Month?\` fields.** The Due Day of Month logic handles everything: if the due day has already passed this month, it maps to next month (the payment is already in the synced balance). If the due day is today or ahead, it maps to this month (the payment hasn't happened yet).
- For costs with non-monthly frequencies, the \`Due Date (Next)\` formula field (\`fldQZBF4JzBsmWU87\`) is the most reliable anchor for projecting future dates. If empty, fall back to \`Due Day of Month\` + \`Frequency\` + \`Last Payment Date\` to calculate.
- For the Account Alias lookup field (\`fldX2QMLkSYzDEpIF\`), the data format is: \`{"linkedRecordIds": ["recXXX"], "valuesByLinkedRecordId": {"recXXX": ["Santander"]}}\`. Filter by checking if \`linkedRecordIds\` contains \`rec3LiEiifomEHlvy\` (Santander) or \`recsR9QhRKYwgV8oP\` (TNT Mgt Zempler).
- All amounts are in GBP.
`,
    },
    {
        id: 'airtable-cost-creator',
        name: 'Cost Creator',
        command: 'anthropic-skills:airtable-cost-creator',
        description: 'Add new fixed costs to the accounts payable system — captures amount, frequency, category, supplier, and creates the recurring cost record in Airtable.',
        category: 'Finance',
        source: 'custom',
        tags: ['costs', 'accounts payable', 'fixed costs', 'supplier'],
        instructions: `---
name: airtable-cost-creator
description: Add new fixed costs to Kevin's Airtable Operations Director base. Use when adding a cost with name, due date, business, frequency, expected cost, categories, and sub-categories.
---

# Airtable Cost Creator

This skill automates the process of adding new fixed costs to the **Operations Director** Airtable base. It ensures linked records (Business, Chart of Accounts Categories, and Sub-categories) are correctly resolved and the payment status is set to "In Payment".

## Workflow

1.  **Collect Information**: Ensure you have the following details from the user:
    *   **Cost Name**: Name of the expense.
    *   **Due Date**: Initial payment date (YYYY-MM-DD).
    *   **Due Day of Month**: Day of the month (1-31).
    *   **Business**: The business name (e.g., "Personal").
    *   **Frequency**: Payment frequency (e.g., "Monthly").
    *   **Expected Cost**: Numerical value (e.g., 5.99).
    *   **Chart of Accounts Categories**: The primary category (e.g., "Personal Expense Not Deductible").
    *   **Chart of Accounts Sub-categories**: The sub-category (e.g., "Personal Health").

2.  **Execute Script**: Run the automation script to create the record.

    \`\`\`bash
    python3 /home/ubuntu/skills/airtable-cost-creator/scripts/add_cost.py \\
      --name "COST_NAME" \\
      --due_date "YYYY-MM-DD" \\
      --due_day "DAY" \\
      --business "BUSINESS_NAME" \\
      --frequency "FREQUENCY" \\
      --expected_cost COST_VALUE \\
      --category "CATEGORY" \\
      --sub_category "SUB_CATEGORY"
    \`\`\`

## Field Mappings

*   **Base ID**: \`appnqjDpqDniH3IRl\` (Operations Director)
*   **Costs Table**: \`tblx5kvhzNEI5TFlS\`
*   **Payment Status**: Automatically set to \`In Payment\`.

## Frequency Options
Must be one of: \`Daily\`, \`Weekly\`, \`Monthly\`, \`4-Weekly\`, \`Fortnightly\`, \`Quarterly\`, \`Annually\`.
`,
    },
    {
        id: 'finance-reconciliation',
        name: 'Account Reconciliation',
        command: 'finance:reconciliation',
        description: 'Reconcile accounts by comparing ledger entries against bank statements, flagging discrepancies and producing a reconciliation report.',
        category: 'Finance',
        source: 'preset',
        tags: ['reconciliation', 'ledger', 'bank statements']
    },
    {
        id: 'finance-journal-entry',
        name: 'Journal Entry Prep',
        command: 'finance:journal-entry',
        description: 'Prepare journal entries with proper debits/credits, supporting documentation references, and approval routing.',
        category: 'Finance',
        source: 'preset',
        tags: ['journal entry', 'debits', 'credits', 'accounting']
    },
    {
        id: 'finance-financial-statements',
        name: 'Financial Statements',
        command: 'finance:financial-statements',
        description: 'Generate financial statements (P&L, balance sheet, cash flow statement) from ledger data with period comparisons.',
        category: 'Finance',
        source: 'preset',
        tags: ['P&L', 'balance sheet', 'cash flow', 'statements']
    },
    {
        id: 'finance-variance-analysis',
        name: 'Variance Analysis',
        command: 'finance:variance-analysis',
        description: 'Decompose financial variances between budget and actual — identifies root causes, quantifies impact, and produces a management commentary.',
        category: 'Finance',
        source: 'preset',
        tags: ['variance', 'budget', 'actual', 'analysis']
    },
    {
        id: 'finance-close-management',
        name: 'Close Management',
        command: 'finance:close-management',
        description: 'Manage the month-end close process — tracks checklist completion, dependencies, blockers, and produces a close status dashboard.',
        category: 'Finance',
        source: 'preset',
        tags: ['month-end', 'close', 'checklist', 'process']
    },
    {
        id: 'finance-audit-support',
        name: 'Audit Support',
        command: 'finance:audit-support',
        description: 'Support SOX 404 compliance and external audit preparation — gathers evidence, maps controls, and prepares audit working papers.',
        category: 'Finance',
        source: 'preset',
        tags: ['audit', 'SOX', 'compliance', 'controls']
    },
    {
        id: 'finance-sox-testing',
        name: 'SOX Testing',
        command: 'finance:sox-testing',
        description: 'Generate SOX sample selections and testing templates for control testing — random sampling, attribute testing, and exception reporting.',
        category: 'Finance',
        source: 'preset',
        tags: ['SOX', 'testing', 'controls', 'sampling']
    },

    // ── Operations ───────────────────────────────────────────────────
    {
        id: 'airtable-task-creator',
        name: 'Task Creator',
        command: 'anthropic-skills:airtable-task-creator',
        description: 'Create tasks in the Airtable task management system — captures title, description, assignee, priority, due date, and linked records.',
        category: 'Operations',
        source: 'custom',
        tags: ['tasks', 'airtable', 'project management'],
        instructions: `---
name: airtable-task-creator
description: Create INTERNAL TEAM tasks (Kevin / Mica / Ericamae) in Kevin Brittain's Airtable Operations Director base with two-phase automation workflow. NOT for contractor jobs — see the warning below. Use when the user requests to create a task, add a task, or schedule work in Airtable for an internal team member.
---

# Airtable Task Creator

> ⚠️ **CONTRACTOR GUARDRAIL — READ BEFORE PROCEEDING**
>
> This skill is for **internal team tasks only** (Kevin, Mica, Ericamae).
> If the requested assignee is a **contractor** — Gary, Roy, or Rob — STOP
> creating the task here and redirect the user instead. Contractor tasks
> have to go through the unified flow so they get the right Business
> field, Maintenance Ticket, contractor DM, and per-contractor business
> resolution. This skill bypasses all of that.
>
> Tell the user:
> > "For contractor jobs, please use either:
> > • The \`#property-management\` Slack channel — type the description
> >   (e.g. *'boiler broken at 55 Elmdon, give it to Gary'*) and the bot
> >   will handle it; or
> > • The dashboard's *Add Task* button on the Tasks OS — set Assignee to
> >   the contractor and Business will default to Real Estate (change to
> >   Operations Director only if it's a non-property task for Roy).
> > Both paths automatically notify the contractor in Slack."
>
> Do **not** proceed with task creation in this skill if the assignee
> is Gary, Roy, or Rob. Architectural rationale lives in
> \`~/Projects/leadership-dashboard/scripts/slack-automation/CONTRACTOR-TASK-PATHS.md\`.

Create tasks in the Airtable Operations Director base using a two-phase workflow. Phase 1 creates the task with basic details; Phase 2 updates fields after automation completes.

## Base Configuration

- **Base ID**: \`appnqjDpqDniH3IRl\`
- **Tasks Table ID**: \`tblqB8b22hKBL4PF1\`
- **Projects Table ID**: \`tblHrpTMd5LNYn8v1\`
- **Default Assignee**: Kevin Brittain (\`usrKkopUJSGsBhWMD\`, \`kevin@runpreneur.org.uk\`)

## Task Creation Workflow

### Phase 1: Initial Task Creation

Collect from the user:
- **Description** - What the task is
- **Assignee** - Team member name (default: Kevin Brittain)
- **Due Date** - When it's due (default: today)
- **Time Estimate** - How long it takes (options: \`15 min\`, \`30 min\`, \`45 min\`, \`1 hr\`, \`2 hr\`, \`3 hr\`, \`4 hr\`, \`8 hr\`)
- **Priority** - Type: \`Project\` (linked to project), \`Urgent\`, or \`Not Urgent\`

Create the task with only **Description** and **Assignee** fields:

\`\`\`bash
manus-mcp-cli tool call create_record --server airtable --input '{
  "baseId": "appnqjDpqDniH3IRl",
  "tableId": "tblqB8b22hKBL4PF1",
  "fields": {
    "Task Name": "<description>",
    "Assignee": {"id": "<assignee_id>", "email": "<assignee_email>"}
  }
}'
\`\`\`

**Why only these fields?** Airtable automations automatically set:
- Time Estimate → \`9:00\` (default)
- Priority → \`Not Urgent\`
- Status → \`Today\` (default)

### Phase 2: Update Fields After Automation (Wait 30 seconds)

After 30 seconds, the automation completes. Update the task with user-specified values:

\`\`\`bash
manus-mcp-cli tool call update_record --server airtable --input '{
  "baseId": "appnqjDpqDniH3IRl",
  "tableId": "tblqB8b22hKBL4PF1",
  "recordId": "<record_id>",
  "fields": {
    "Due Date": "<YYYY-MM-DD>",
    "Time Estimate": "<user_specified_time>",
    "Priority": "<Project|Urgent|Not Urgent>",
    "Projects": ["<project_record_id>"]
  }
}'
\`\`\`

**Note**: Only include \`Projects\` field if Priority is \`Project\`.

### Phase 3: Notify the assignee via slack-notify worker

**Skip this step if the assignee is the same person calling the skill**
(actor == assignee — they don't need to DM themselves).

Otherwise call the existing \`slack-notify\` Cloudflare Worker. This is
the SAME path the dashboard's \`notifyAssigneeSlack\` uses, so DMs
landed by this skill are indistinguishable from dashboard-created
ones — same wording, same threading, same Slack ID lookup logic
(handles email overrides like Gary's \`roofline@outlook.com\`).

\`\`\`bash
curl -sS -X POST https://slack-notify.kevinbrittain.workers.dev/ \\
  -H "Content-Type: application/json" \\
  -d '{
    "recipientEmail": "<assignee_airtable_email>",
    "taskName":       "<the user-typed task name>",
    "taskId":         "<the recXXX id from Phase 1>",
    "actorName":      "<your name, the person using the skill>",
    "action":         "assigned"
  }'
\`\`\`

The worker handles the Slack lookup, posts a structured DM with the
task ID embedded (which lets the assignee reply in-thread to add a
comment via the contractor-bot's DM-reply flow). No bearer required —
the worker accepts requests with the right shape and validates them
against its own Slack token.

If the assignee is a **contractor** (Gary/Roy/Rob) the contractor
guardrail at the top of this skill will already have stopped the
flow before this step — see that warning.

## Finding Assignees and Projects

### Look Up Team Member IDs

If the assignee is not Kevin Brittain, search the Airtable base or use Slack to find their user ID and email. Common team members should be cached locally if this skill is used frequently.

### Link to Project (if Priority = Project)

Search for the project by keyword:

\`\`\`bash
manus-mcp-cli tool call search_records --server airtable --input '{
  "baseId": "appnqjDpqDniH3IRl",
  "tableId": "tblHrpTMd5LNYn8v1",
  "searchTerm": "<project_keyword>"
}'
\`\`\`

Use the project's record ID in the \`Projects\` field during Phase 2.

## Field Reference

| Field Name | Field ID | Type | Phase Set |
|------------|----------|------|-----------|
| Task Name | fldgFjGBw6bTKJFCD | singleLineText | Phase 1 |
| Assignee | fldELMncVJYPDRJNc | singleCollaborator | Phase 1 |
| Due Date | fld7XP8w8kbxfETV4 | date | Phase 2 |
| Time Estimate | fld10VzzbiNNgRmIi | singleSelect | Phase 2 |
| Priority | fldS21RwmwOqt71LI | singleSelect | Phase 2 |
| Projects | fldBg0rQy0FrOAkRN | multipleRecordLinks | Phase 2 (conditional) |
| Status | fldx4qCw17UfrKpaN | singleSelect | Auto-set by automation |

## Example Workflows

**Simple task for team member (non-urgent, 30 min, today):**

1. Phase 1: Create with description and assignee
2. Phase 2 (after 30s): Set due date to today, time to \`30 min\`, priority to \`Not Urgent\`
3. Send Slack notification (unless assignee is Kevin)

**Project task (linked to project, 1 hr, specific date):**

1. Phase 1: Create with description and assignee
2. Phase 2 (after 30s): Set due date, time to \`1 hr\`, priority to \`Project\`, link project
3. Send Slack notification (unless assignee is Kevin)

**Urgent task for Kevin (no notification needed):**

1. Phase 1: Create with description and Kevin as assignee
2. Phase 2 (after 30s): Set due date, time estimate, priority to \`Urgent\`
3. Skip Slack notification (Kevin created it)
`,
    },
    {
        id: 'ops-process-doc',
        name: 'Process Documentation',
        command: 'operations:process-doc',
        description: 'Document a business process end-to-end — captures steps, roles, systems, decision points, and produces a formatted process map.',
        category: 'Operations',
        source: 'preset',
        tags: ['process', 'documentation', 'workflow', 'SOP']
    },
    {
        id: 'ops-process-optimization',
        name: 'Process Optimization',
        command: 'operations:process-optimization',
        description: 'Analyse and improve business processes — identifies bottlenecks, waste, and automation opportunities with ROI estimates.',
        category: 'Operations',
        source: 'preset',
        tags: ['process', 'optimization', 'efficiency', 'automation']
    },
    {
        id: 'ops-vendor-review',
        name: 'Vendor Review',
        command: 'operations:vendor-review',
        description: 'Evaluate a vendor — cost analysis, service quality assessment, contract terms review, and renewal recommendation.',
        category: 'Operations',
        source: 'preset',
        tags: ['vendor', 'supplier', 'review', 'procurement']
    },
    {
        id: 'ops-risk-assessment',
        name: 'Risk Assessment',
        command: 'operations:risk-assessment',
        description: 'Identify, assess, and mitigate operational risks — probability/impact scoring, control mapping, and mitigation action plans.',
        category: 'Operations',
        source: 'preset',
        tags: ['risk', 'assessment', 'mitigation', 'controls']
    },
    {
        id: 'ops-status-report',
        name: 'Status Report',
        command: 'operations:status-report',
        description: 'Generate a status report with RAG ratings, key metrics, blockers, and next actions — suitable for stakeholder or board updates.',
        category: 'Operations',
        source: 'preset',
        tags: ['status', 'report', 'RAG', 'stakeholder']
    },
    {
        id: 'ops-compliance-tracking',
        name: 'Compliance Tracking',
        command: 'operations:compliance-tracking',
        description: 'Track compliance requirements — regulatory deadlines, certificate renewals, inspection schedules, and action items.',
        category: 'Operations',
        source: 'preset',
        tags: ['compliance', 'regulatory', 'tracking', 'deadlines']
    },
    {
        id: 'ops-change-request',
        name: 'Change Request',
        command: 'operations:change-request',
        description: 'Create a change management request — impact assessment, stakeholder analysis, rollback plan, and approval routing.',
        category: 'Operations',
        source: 'preset',
        tags: ['change management', 'request', 'approval']
    },
    {
        id: 'ops-capacity-plan',
        name: 'Capacity Planning',
        command: 'operations:capacity-plan',
        description: 'Plan resource capacity — workload forecasting, headcount modelling, utilisation tracking, and bottleneck identification.',
        category: 'Operations',
        source: 'preset',
        tags: ['capacity', 'planning', 'resources', 'headcount']
    },
    {
        id: 'ops-runbook',
        name: 'Runbook',
        command: 'operations:runbook',
        description: 'Create or update an operational runbook — step-by-step procedures for routine operations, incident response, or system maintenance.',
        category: 'Operations',
        source: 'preset',
        tags: ['runbook', 'procedures', 'incident', 'operations']
    },

    // ── Legal ────────────────────────────────────────────────────────
    {
        id: 'legal-review-contract',
        name: 'Contract Review',
        command: 'legal:review-contract',
        description: 'Review a contract against standard terms — flags deviations, risky clauses, missing provisions, and produces a redline summary.',
        category: 'Legal',
        source: 'preset',
        tags: ['contract', 'review', 'redline', 'terms']
    },
    {
        id: 'legal-triage-nda',
        name: 'NDA Triage',
        command: 'legal:triage-nda',
        description: 'Rapidly triage an incoming NDA — checks standard vs non-standard terms, flags problematic clauses, and recommends accept/negotiate/reject.',
        category: 'Legal',
        source: 'preset',
        tags: ['NDA', 'triage', 'confidentiality', 'review']
    },
    {
        id: 'legal-compliance-check',
        name: 'Compliance Check',
        command: 'legal:compliance-check',
        description: 'Run a compliance check on a document or process against regulatory requirements and internal policies.',
        category: 'Legal',
        source: 'preset',
        tags: ['compliance', 'regulatory', 'check', 'policy']
    },
    {
        id: 'legal-risk-assessment',
        name: 'Legal Risk Assessment',
        command: 'legal:legal-risk-assessment',
        description: 'Assess and classify legal risks — likelihood/impact scoring, jurisdiction considerations, and recommended mitigations.',
        category: 'Legal',
        source: 'preset',
        tags: ['legal risk', 'assessment', 'jurisdiction']
    },
    {
        id: 'legal-brief',
        name: 'Legal Brief',
        command: 'legal:brief',
        description: 'Generate contextual briefing notes on a legal topic — research summary, key precedents, and practical recommendations.',
        category: 'Legal',
        source: 'preset',
        tags: ['brief', 'research', 'legal', 'summary']
    },
    {
        id: 'legal-meeting-briefing',
        name: 'Meeting Briefing',
        command: 'legal:meeting-briefing',
        description: 'Prepare structured briefing notes for a legal meeting — agenda items, background context, talking points, and desired outcomes.',
        category: 'Legal',
        source: 'preset',
        tags: ['meeting', 'briefing', 'preparation', 'legal']
    },
    {
        id: 'legal-vendor-check',
        name: 'Vendor Check',
        command: 'legal:vendor-check',
        description: 'Check the status of existing vendor agreements — contract expiry dates, renewal terms, and compliance with agreed SLAs.',
        category: 'Legal',
        source: 'preset',
        tags: ['vendor', 'contract', 'SLA', 'renewal']
    },
    {
        id: 'legal-signature-request',
        name: 'Signature Request',
        command: 'legal:signature-request',
        description: 'Prepare and route a document for e-signature — identifies signers, sets signing order, and configures the signature workflow.',
        category: 'Legal',
        source: 'preset',
        tags: ['signature', 'e-sign', 'routing', 'document']
    },
    {
        id: 'legal-response',
        name: 'Legal Response',
        command: 'legal:legal-response',
        description: 'Generate a response to a correspondence or claim — structured reply with legal reasoning, cited provisions, and recommended next steps.',
        category: 'Legal',
        source: 'preset',
        tags: ['response', 'correspondence', 'claim', 'legal']
    },

    // ── Data & Analytics ─────────────────────────────────────────────
    {
        id: 'data-analyze',
        name: 'Data Analysis',
        command: 'data:analyze',
        description: 'Answer data questions — from exploratory analysis to hypothesis testing. Connects to your data, runs queries, and presents findings with visualisations.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['analysis', 'data', 'queries', 'insights']
    },
    {
        id: 'data-write-query',
        name: 'SQL Query Writer',
        command: 'data:write-query',
        description: 'Write optimised SQL for your database — handles joins, aggregations, CTEs, and window functions with performance considerations.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['SQL', 'query', 'database', 'optimisation']
    },
    {
        id: 'data-build-dashboard',
        name: 'Dashboard Builder',
        command: 'data:build-dashboard',
        description: 'Build an interactive HTML dashboard from your data — charts, tables, filters, and KPI cards in a single self-contained file.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['dashboard', 'HTML', 'charts', 'KPIs']
    },
    {
        id: 'data-create-viz',
        name: 'Visualisation Creator',
        command: 'data:create-viz',
        description: 'Create publication-quality data visualisations — charts, graphs, and diagrams with proper labelling, colour schemes, and annotations.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['visualisation', 'charts', 'graphs', 'design']
    },
    {
        id: 'data-explore',
        name: 'Data Explorer',
        command: 'data:explore-data',
        description: 'Profile and explore a dataset — schema inspection, distribution analysis, null checks, outlier detection, and relationship mapping.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['exploration', 'profiling', 'schema', 'quality']
    },
    {
        id: 'data-validate',
        name: 'Data Validation',
        command: 'data:validate-data',
        description: 'QA an analysis before sharing — checks methodology, validates calculations, tests edge cases, and reviews presentation.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['validation', 'QA', 'methodology', 'review']
    },
    {
        id: 'data-statistical',
        name: 'Statistical Analysis',
        command: 'data:statistical-analysis',
        description: 'Apply statistical methods to data — regression, hypothesis testing, confidence intervals, clustering, and time series analysis.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['statistics', 'regression', 'hypothesis', 'time series']
    },
    {
        id: 'data-sql-queries',
        name: 'SQL Queries',
        command: 'data:sql-queries',
        description: 'Write correct, performant SQL queries with proper indexing hints, execution plan awareness, and dialect-specific optimisations.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['SQL', 'performance', 'indexing', 'execution plan']
    },
    {
        id: 'data-visualization',
        name: 'Data Visualisation',
        command: 'data:data-visualization',
        description: 'Create effective data visualisations — selects the right chart type, applies design best practices, and ensures accessibility.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['visualisation', 'chart selection', 'accessibility']
    },
    {
        id: 'data-context-extractor',
        name: 'Data Context Extractor',
        command: 'data:data-context-extractor',
        description: 'Generate or improve a comprehensive data context document — schema descriptions, business rules, relationships, and data dictionary.',
        category: 'Data & Analytics',
        source: 'preset',
        tags: ['data dictionary', 'schema', 'context', 'documentation']
    },

    // ── Customer Support ─────────────────────────────────────────────
    {
        id: 'cs-draft-response',
        name: 'Draft Response',
        command: 'customer-support:draft-response',
        description: 'Draft a professional customer support response — matches tone to the situation, references relevant policies, and suggests next steps.',
        category: 'Customer Support',
        source: 'custom',
        tags: ['response', 'customer', 'email', 'communication']
    },
    {
        id: 'cs-ticket-triage',
        name: 'Ticket Triage',
        command: 'customer-support:ticket-triage',
        description: 'Triage and prioritise a support ticket — categorises the issue, assesses urgency, routes to the right team, and suggests resolution paths.',
        category: 'Customer Support',
        source: 'custom',
        tags: ['triage', 'priority', 'routing', 'ticket']
    },
    {
        id: 'cs-customer-research',
        name: 'Customer Research',
        command: 'customer-support:customer-research',
        description: 'Multi-source research on a customer — pulls account history, recent interactions, open tickets, and relationship context.',
        category: 'Customer Support',
        source: 'custom',
        tags: ['research', 'customer', 'history', 'context']
    },
    {
        id: 'cs-kb-article',
        name: 'KB Article',
        command: 'customer-support:kb-article',
        description: 'Draft a knowledge base article — structured with problem/solution format, screenshots placeholder, and SEO-friendly headings.',
        category: 'Customer Support',
        source: 'custom',
        tags: ['knowledge base', 'article', 'documentation', 'self-service']
    },
    {
        id: 'cs-escalation',
        name: 'Escalation Package',
        command: 'customer-support:customer-escalation',
        description: 'Package an escalation for handoff — timeline of events, attempted resolutions, customer sentiment, and recommended resolution.',
        category: 'Customer Support',
        source: 'preset',
        tags: ['escalation', 'handoff', 'resolution', 'customer']
    },

    // ── Productivity & Communications ────────────────────────────────
    {
        id: 'daily-schedule',
        name: 'Daily Schedule',
        command: 'anthropic-skills:daily-schedule',
        description: 'Generates a structured daily schedule pulling from calendar, tasks, and priorities — time-blocks the day with focus periods and buffer time.',
        category: 'Productivity',
        source: 'custom',
        tags: ['schedule', 'calendar', 'time management', 'planning'],
        instructions: `---
name: daily-schedule
description: >
  Use this skill whenever the user wants to plan, build, or organise their day. Triggers include:
  asking to schedule tasks for today or tomorrow, building a daily agenda, fitting tasks around
  fixed appointments or departure times, planning a day that involves travel, or any request
  involving "what should I do today", "can you plan my day", "help me schedule", or "sort my
  schedule". Also use this skill when the user provides a list of tasks with durations and wants
  them turned into a calendar. If the user mentions needing to be somewhere by a certain time or
  leaving at a certain time, this skill should always be used. Use proactively — if the user
  provides tasks, durations and a departure time in the same message, proceed with scheduling
  without waiting to be explicitly asked.
---

# Daily Schedule Skill

You are helping the user build a practical, realistic schedule for their day and add it to their
Google Calendar. The goal is a tight, achievable plan — not an optimistic one that falls apart
by lunchtime.

## Step 1: Gather the constraints

Before building anything, you need to know:

- **Fixed anchors**: appointments or meetings that are locked to a specific time
- **Departure/arrival times**: when they're leaving home, arriving somewhere, leaving to return
- **Travel time**: how long journeys take (this affects available working time)
- **Task list**: each task with an estimated duration
- **Travel tasks**: calls, errands or other things that can happen during a journey rather than
  taking up working time at a destination

If any of these are missing from the user's message, ask for them before proceeding. Do not
guess travel times — always ask if not given. Do not assume all tasks must happen at the same
location.

**Start time rule**: Always check the actual current time in UK hours (Europe/London timezone)
before building the schedule. The schedule start time is ALWAYS the current time right now —
never earlier. Do not use a rounded or assumed start time from earlier in the conversation.
Run a fresh time check immediately before presenting the schedule. Never build a schedule
that begins in the past.

**Location rule**: Always assume the user is starting from home unless they say otherwise.
If the user is travelling somewhere, they will tell you where they're going and the expected
journey time. Do not guess travel times or destinations — only include travel blocks when the
user provides this information.

If the user gives you everything you need upfront, proceed directly to building the schedule
without asking unnecessary questions.

## Step 2: Do the time arithmetic

Once you have the full picture:

1. Identify the available time windows at each location (e.g., arrival time to departure time)
2. Subtract fixed anchors (meetings, appointments) from those windows
3. Add up the flexible task durations
4. Compare available time against task time and calculate the shortfall (if any)

Be honest about shortfalls. If tasks exceed the available time, flag it clearly with the exact
gap. Do not quietly trim tasks without telling the user — always state what was trimmed and by
how much.

## Step 3: Sequence the tasks sensibly

When ordering flexible tasks, use good judgement:

- Physical or manual tasks (assembling furniture, property visits, etc.) are usually best done
  earlier in the day before energy drops
- Financial or admin tasks that require focus are better mid-morning when fresh
- Creative or strategic work is better when the day's physical demands are out of the way
- Calls and quick check-ins can often be batched into travel slots
- If a task has an external dependency (waiting for a confirmation, a delivery, etc.), sequence
  it after the dependency is likely resolved

If the user has given you a preferred order, respect it. Only suggest a reorder if there is a
clear practical reason, and flag it as a suggestion rather than overriding silently.

## Step 4: Present the schedule for confirmation

Present the schedule as a clean table with three columns: Time, Task, Duration. Include:

- Travel blocks clearly labelled (e.g. "Travel to Haverhill")
- Any calls or errands happening during travel, indented or noted as "during travel"
- Fixed anchors clearly marked
- Return travel if relevant
- Any tasks that did not fit, flagged at the bottom with a note on why

Always flag:
- If admin or lower-priority tasks were trimmed or dropped
- If any task slots are tight and likely to overrun
- If a fixed anchor creates a gap that makes the schedule awkward

Ask the user to confirm the schedule before adding anything to the calendar.

## Step 5: Add to Google Calendar

Once the user confirms, add every block to Google Calendar using the \`gcal_create_event\` tool.

Rules for calendar entries:
- Travel blocks should be single events (e.g. "Travel to Haverhill — calls en route")
- Include a brief description for any event that has context worth remembering (e.g. payment
  amounts, who to call, what to check)
- For meetings with agendas, add the full agenda to the event description
- Use the correct date — confirm with the user if there is any ambiguity about which day
- Do not add duplicate events if a recurring event already exists for that slot. Instead, check
  for existing events and update the description on the existing one

After adding events, check if any of the new events overlap with existing calendar entries. If
there are conflicts, flag them to the user rather than silently overwriting.

## Step 6: Handle edge cases

**Recurring meetings**: If the user mentions a meeting that already exists in their calendar,
search for it and update the description rather than creating a duplicate.

**Evening tasks**: Some tasks (payment runs, admin) may be scheduled for the evening. These are
valid — treat them the same way as daytime tasks.

**Multiple locations**: If the user is travelling to more than one place, track the available
window at each location separately.

**Tight days**: If there is genuinely no way to fit everything in, say so plainly. Suggest which
tasks are the best candidates to defer, and why (lowest urgency, shortest duration that frees up
the most time, etc.).

## Tone and communication style

- Be direct and concise — no padding
- Present numbers clearly (total available time vs. total task time)
- Flag problems upfront, not buried in the middle of a schedule
- Ask one question at a time if clarification is needed, not a list of five
- Never add anything to the calendar without explicit confirmation from the user
`,
    },
    {
        id: 'meeting-manager',
        name: 'Meeting Manager',
        command: 'anthropic-skills:meeting-manager',
        description: 'Manage meeting rescheduling, preparation, and follow-up — agenda creation, attendee coordination, minutes capture, and action tracking.',
        category: 'Productivity',
        source: 'custom',
        tags: ['meetings', 'agenda', 'minutes', 'scheduling'],
        instructions: `---
name: meeting-manager
description: Manage meeting rescheduling and invitations with multi-channel notifications. Use when moving meetings, creating new ones, or updating recurring events. Ensures all attendees are notified via Slack (primary) or Email (fallback).
---

# Meeting Manager

This skill provides a standardized workflow for rescheduling meetings or creating new invitations, ensuring consistent communication across Slack and Email.

## Core Principles

1.  **Multi-Channel Notification**: Always prioritize Slack for internal team members. Use Email as a mandatory fallback for anyone without a Slack account.
2.  **Recurring Event Safety**: When rescheduling recurring meetings, clarify if the change is for a single instance or the entire series. Default to "this week only" unless specified.
3.  **Transparency**: Always confirm to the user exactly who was notified and via which channel.

## Workflow

### 1. Identify Attendees and Channels
- Retrieve the attendee list from the calendar event.
- For each attendee, search for a Slack account using their email or name.
- Categorize attendees into "Slack-enabled" and "Email-only".

### 2. Update Calendar
- Update the meeting time/date in Google Calendar.
- For single instance changes of recurring meetings, ensure only the specific occurrence is modified.

### 3. Send Notifications
- **Slack (Primary)**: Send a direct message to each Slack-enabled attendee.
- **Email (Fallback)**: If an attendee is not found on Slack, send a confirmation email or ensure the calendar update triggers an email invitation.

## Message Templates

### Slack Template
> Hi [Name]! Just a quick update that today's meeting "[Meeting Name]" has been rescheduled for [New Day, Date]:
> - New Time: [New Time]
> [Note about recurring status, e.g., "This change is for this week only."]
> See you then!

### Email Template
> Subject: Rescheduled Meeting: [Meeting Name]
>
> Hi [Name],
>
> This is a confirmation that the meeting "[Meeting Name]" has been rescheduled to [New Day, Date] at [New Time].
>
> [Note about recurring status]. Please check your calendar for the updated invite.
>
> Best regards,
> [User Name]
`,
    },
    {
        id: 'weekly-checkin',
        name: 'Weekly Check-in',
        command: 'anthropic-skills:weekly-checkin-task-manager',
        description: 'Automates the extraction and structuring of weekly check-in data — pulls task progress, blockers, and priorities into a formatted update.',
        category: 'Productivity',
        source: 'custom',
        tags: ['weekly', 'check-in', 'progress', 'update'],
        instructions: `---
name: weekly-checkin-task-manager
description: Automates the extraction and assignment of INTERNAL TEAM tasks from weekly check-ins with standard rules for assignees, duration, project, and recurring status, requiring user approval before creation. Contractor jobs (Gary / Roy / Rob) MUST be flagged separately and routed through Slack — see the warning below.
---

# Weekly Check-in Task Manager Skill

> ⚠️ **CONTRACTOR GUARDRAIL — READ BEFORE EXTRACTING**
>
> If the check-in mentions a task being assigned to a **contractor**
> (Gary, Roy, or Rob), do NOT add it to the standard extraction list and
> do NOT create it through this skill. Instead:
>
> 1. Show those items to the user separately as "Contractor jobs to log".
> 2. Ask the user to log each one via the \`#property-management\` Slack
>    channel (e.g. *"boiler broken at 55 Elmdon, give it to Gary"*) so
>    the contractor-bot creates them with the right Business field, the
>    Maintenance Ticket flag, the contractor DM, and per-contractor
>    business resolution.
>
> Architectural rationale lives in
> \`~/Projects/leadership-dashboard/scripts/slack-automation/CONTRACTOR-TASK-PATHS.md\`.
>
> The standard internal-team extraction below applies to Kevin, Mica,
> Ericamae, Karlo, Giezel, etc — NOT contractors.

This skill converts action items from weekly check-in transcripts or summaries into structured tasks for the "Operations Director" Airtable base. It ensures all tasks follow a standardized format and requires explicit user authorization before final logging.

## Core Principles

1.  **Standardized Data**: All tasks default to a 15-minute duration, the "Profit" project, and a due date of "Today".
2.  **Precise Naming**: Corrects common phonetic spellings to the specific required formats for Airtable matching.
3.  **Recurring Logic**: Identifies and maps recurring frequencies (e.g., daily, weekly, monthly) directly from the transcript.
4.  **Mandatory Approval**: No tasks are created in Airtable without prior user confirmation of the extracted list.

## Workflow

### 1. Task Extraction and Identification
The skill processes meeting transcripts or summaries to identify action items, potential assignees, and any mentions of recurring frequency.

### 2. Assignee Resolution and Name Correction
*   **Default Assignee**: If no assignee is specified, the task is assigned to **Mica** by default.
*   **Name Correction**: The skill automatically maps phonetic or alternative spellings to the correct Airtable names:
    *   "Giselle" or "Gisel" will be corrected to **Giezel**
    *   "Erica May" or "Erica" will be corrected to **Ericamae**
    *   "Carlo" or "Carlos" will be corrected to **Karlo**

### 3. Task Parameter Standardization
*   **Duration**: Set to **15 minutes** as standard.
*   **Project**: Associated with the **"Profit"** project.
*   **Due Date**: Set to **Today** (the date of execution).
*   **Recurring Status**: If the transcript specifies a frequency (e.g., "daily", "every week", "monthly"), the "Recurring" field in Airtable must be updated with that frequency.

### 4. User Review and Authorization (Mandatory)
Before any data is sent to Airtable, the skill MUST present a structured table of the proposed tasks to the user. This table includes the task name, assignee, duration, project, due date, and recurring frequency (if any). The skill will wait for the user to "Confirm and Authorise" the list.

### 5. Task Creation in Airtable
Once authorized, the skill uses the \`airtable-task-creator\` workflow to log the tasks into the "Tasks" table of the "Operations Director" Airtable base, including the recurring frequency where applicable.

## Usage Example

**Input**: "Review ProcessOS setup. Karlo to call UC tenants every week. Giezel to update compliance certificates."

**Processed Output for Approval**:

| Task Description | Assignee | Duration | Project | Due Date | Recurring |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Review ProcessOS setup. | Mica | 15 minutes | Profit | Today | N/A |
| Call UC tenants. | Karlo | 15 minutes | Profit | Today | **Weekly** |
| Update compliance certificates. | Giezel | 15 minutes | Profit | Today | N/A |

**Final Action**: Create tasks in Airtable only after the user says "Confirm and Authorise".
`,
    },
    {
        id: 'gmail-respond-manager',
        name: 'Gmail Response Manager',
        command: 'anthropic-skills:gmail-respond-manager',
        description: 'Manages the full "To Respond" Gmail workflow — surfaces emails needing replies, drafts contextual responses, and tracks completion.',
        category: 'Productivity',
        source: 'custom',
        tags: ['gmail', 'email', 'responses', 'inbox'],
        instructions: `---
name: gmail-respond-manager
description: >
  Manages the full "To Respond" email workflow for kevin@runpreneur.org.uk. Fetches all emails
  labelled "To Respond", drafts replies using the knowledge base, presents all drafts for batch
  approval, creates Gmail drafts, waits for send confirmation, then moves emails to "Responded"
  or "Follow Up" label. Trigger phrases: "process my To Respond emails", "draft my email replies",
  "work through my To Respond inbox", "handle my emails", "respond to my labelled emails", or any
  request to action emails from the To Respond label.
---

# Gmail Respond Manager

Full workflow for clearing Kevin's "To Respond" Gmail label. Reads emails, drafts replies, gets batch approval, creates drafts, then manages label transitions.

## Gmail Account

\`kevin@runpreneur.org.uk\` — MCP server ID: \`d4d22870-4300-4d0c-9a47-4810a6dacd58\`

## Label Reference

On first run (or if label IDs are not known), call \`gmail_list_labels\` to resolve IDs. Store these for the session:

| Label name | Label ID (confirmed) |
|---|---|
| 1: to respond | Label_1 |
| 5: responded | Label_3 |
| 2: to follow-up | Label_7 |

These IDs are confirmed for kevin@runpreneur.org.uk. Re-fetch with \`gmail_list_labels\` if they stop working.

## Knowledge Base

Before drafting any responses, read both reference files:
- \`knowledge-base/tone-and-style.md\` — Kevin's communication style and rules
- \`knowledge-base/standard-responses.md\` — Known response patterns for recurring email types

---

## Phase 1: Fetch Emails

**⚠️ Known issue:** \`label:"1: to respond"\` search syntax does NOT reliably return results when label names have numeric prefixes. Use this instead:

\`\`\`
gmail_search_messages: has:userlabels newer_than:90d
\`\`\`

Then filter client-side: keep only threads where \`labelIds\` contains \`Label_1\`. Discard all others.

For each result, call \`gmail_read_thread\` (not just \`gmail_read_message\`) to get the full conversation context — prior replies affect what the response should say.

List the emails found before proceeding:
\`\`\`
Found N emails to respond to:
1. [Sender] — [Subject] — [Date received]
2. ...
\`\`\`

If zero emails found, report and stop.

---

## Phase 2: Draft Responses

For each email, draft a reply. Use:
- The full thread context
- Kevin's tone and style rules (from knowledge base)
- Any matching pattern in standard-responses.md

### Drafting rules

- Keep replies concise and direct — no filler, no emotional padding
- Match the register of the original sender (formal if formal, brief if brief)
- If the email requires information Kevin would need to provide (e.g. specific dates, figures, decisions), include a \`[PLACEHOLDER: ...]\` marker rather than guessing
- If the email is clearly spam, a circular, or requires no reply, flag it as \`[SKIP — no reply needed]\` with a brief reason
- If you're uncertain about the right response, draft a conservative reply and note your uncertainty

### Known sender notes

- **ARP (Anglia Revenues Partnership):** \`counciltax@angliarevenues.gov.uk\` is no longer monitored. Do NOT draft emails to that address. Direct Kevin to use the online portal at angliarevenues.gov.uk, or call 01284 757275 option 2 (ARP Billing). For enforcement queries: 01842 756433.

---

## Phase 3: Batch Presentation for Approval

Present ALL drafts in a single structured block. Use this format:

---
**📧 TO RESPOND — [date] — [N] emails**

---

**[1] From:** [Sender name] \\<[email]\\>
**Subject:** [Subject line]
**Received:** [Date]

**Draft reply:**
> [Draft text]

**Confidence:** High / Medium / Low — [one-line reason if Medium/Low]
**Suggested next label:** Responded / Follow Up — [brief reason]

---

[Repeat for each email]

---

After presenting all drafts, ask:

*"Please review the drafts above. Reply with any of the following:*
- *'All approved' — to approve everything as written*
- *'[N] amend: [your change]' — to update a specific draft*
- *'[N] skip' — to skip sending that reply*
- *The 'suggested next label' can also be overridden: '[N] label: Responded' or '[N] label: Follow Up'"*

---

## Phase 4: Process Approvals

Apply all amendments before proceeding. If Kevin amends a draft in a way that suggests a reusable pattern (e.g. "for all Runpreneur sponsorship enquiries, use X tone"), update \`knowledge-base/standard-responses.md\` after the session.

Confirm final list of drafts to be created:
\`\`\`
Creating Gmail drafts for:
✓ [1] [Subject] — Responded
✓ [2] [Subject] — Follow Up
✗ [3] [Subject] — Skipped
\`\`\`

Ask for a final "confirm" before proceeding to draft creation.

---

## Phase 5: Create Gmail Drafts

For each approved reply, call \`gmail_create_draft\`:

\`\`\`json
{
  "to": "[sender email]",
  "subject": "Re: [original subject]",
  "body": "[approved draft text]",
  "threadId": "[thread ID from Phase 1]"
}
\`\`\`

**Important:** Always populate the \`to\` field with the sender's actual email address. Do not leave it blank or use a placeholder — if the sender email is unclear, flag it before creating the draft.

After all drafts are created, report:
\`\`\`
✅ [N] drafts created in Gmail.

Please review and send them from your Gmail Drafts folder.
Let me know once they've been sent so I can update the labels.
\`\`\`

**STOP HERE.** Wait for Kevin to confirm the emails have been sent before proceeding.

---

## Phase 6: Label Management

Once Kevin confirms emails are sent, present the label recommendations:

\`\`\`
Label changes to apply:

[1] [Subject] → Move to "5: responded", remove "1: to respond"
[2] [Subject] → Move to "2: to follow-up", remove "1: to respond"
[3] [Subject] → Skipped (no reply sent) — confirm label action?

Confirm to proceed, or adjust any of the above.
\`\`\`

### Important: Label auto-removal on reply

When Kevin sends a reply directly from the Gmail UI (not via draft creation), Gmail automatically removes the \`1: to respond\` label (Label_1) from that thread. So by the time label management runs, Label_1 may already be gone from replied threads. Only adding the target label (Label_3 or Label_7) is needed for those threads.

### Applying label changes via Chrome

**⚠️ Known limitation:** The Gmail MCP server does NOT include a \`gmail_modify_thread\` tool. Label changes cannot be applied via MCP. Browser automation is required.

**Chrome extension redirect issue (critical):** A Chrome extension (Google Drive / Cowork) in Kevin's browser intercepts physical click and keypress events (\`computer.left_click\`, \`computer.key\`), causing "Detached while handling command" errors and tab redirection to a \`chrome-extension://\` URL. Physical UI interaction via computer-use tools is NOT reliable in this browser session.

**All automated approaches tested and confirmed non-functional in this environment:**

| Approach | Result |
|---|---|
| \`gmail_modify_thread\` MCP tool | Does not exist in this MCP server |
| \`fireClick\` MouseEvent dispatch via JS | \`aria-checked\` updates in DOM but API call aborted by extension redirect — changes don't persist |
| Gmail REST API (\`/gmail/v1/users/me/threads/{id}/modify\`) with SAPISIDHASH | Returns 200 but labels not applied — cookie-based auth has insufficient write scope |
| Gmail legacy form action (\`POST /mail/u/0/\` with \`act=l&lact=a\`) | Returns 200 and \`?sw=2\` redirect but historyId unchanged — labels not applied |
| Physical computer-use clicks | Chrome tier is "read" — clicks blocked |

**Recommended approach:** Ask Kevin to apply label changes manually. For each thread:
1. Open the thread in Gmail
2. Click the Labels icon (tag icon in the toolbar)
3. Check "5: responded" or "2: to follow-up"
4. Uncheck "1: to respond" (if still present — Gmail auto-removes it when Kevin sends a reply from the UI)
5. Click Apply

Provide Kevin with a numbered list of thread subjects and their target labels so he can action them in one pass.

---

## Phase 7: Learn and Update

After completing the session, check if any amendments in Phase 4 reveal reusable patterns. If so, update \`knowledge-base/standard-responses.md\` with the new pattern and confirm to Kevin:

*"Knowledge base updated — [description of what was added] will be applied automatically next time."*

---

## Error Handling

| Scenario | Action |
|---|---|
| \`label:"1: to respond"\` returns zero results | Switch to \`has:userlabels newer_than:90d\` + client-side filter on \`labelIds\` |
| Email thread too long to read fully | Summarise the last 3 messages; note truncation in the draft |
| Draft requires Kevin's input (dates, figures, decisions) | Use \`[PLACEHOLDER: ...]\` markers — do not guess |
| Sender email address missing or unclear | Flag before creating draft — do not leave \`to\` field blank |
| Sender is unknown / context is unclear | Draft a neutral acknowledgement and flag as Medium confidence |
| \`gmail_create_draft\` fails | Report failure, continue with remaining drafts |
| Chrome label automation fails / extension redirect | Report which emails need manual labelling; provide thread subject list |
| Email is clearly automated / no-reply | Flag as \`[SKIP]\` and recommend archiving |
`,
    },
    {
        id: 'gmail-to-airtable',
        name: 'Gmail to Airtable Inbound',
        command: 'anthropic-skills:gmail-to-airtable-inbound',
        description: 'Monitors kevin@runpreneur.org.uk inbox and automatically creates Airtable task records from inbound emails matching configured rules.',
        category: 'Productivity',
        source: 'custom',
        tags: ['gmail', 'airtable', 'automation', 'inbound'],
        instructions: `---
name: gmail-to-airtable-inbound
description: Monitors kevin@runpreneur.org.uk Gmail for emails labelled "To Respond" and creates task records in the Airtable Operations Director base under the Inbound Comms OS. Use when the user asks to process labelled emails, sync Gmail to Airtable, create inbound comms tasks from email, or run the email-to-task automation.
---

# Gmail → Airtable Inbound Comms

Monitors \`kevin@runpreneur.org.uk\` for emails labelled **To Respond** and creates one task per email in the Airtable Tasks table, mapped to the Inbound Comms interface.

## Airtable Configuration

- **Base ID**: \`appnqjDpqDniH3IRl\`
- **Table ID**: \`tblqB8b22hKBL4PF1\`

### Field Mapping

| Airtable Field | Field ID | Source |
|---|---|---|
| Task Name | \`fldgFjGBw6bTKJFCD\` | AI-generated subject summary |
| Description | \`fldRGhBQViKZKtkQ6\` | Subject + full email body |
| Contact Name | \`fldL9Fd0r8gixPGCT\` | Sender display name |
| Contact Email | \`flddZXpNlwVHXcaQU\` | Sender email address |
| Attachments | \`fldEbs9cscRr8elcw\` | Email attachments (as URLs) |
| Source | \`fldMWDXsbAr4oM9hz\` | Hard-coded: \`"Email"\` |
| Inbound Communication Task | \`fldueazD67F7fUGee\` | Hard-coded: \`true\` |
| Inbound Approval | \`fldPg7o6cxfMUPPRf\` | Hard-coded: \`true\` |



## Workflow

### Step 1 — Fetch labelled emails from Gmail

\`\`\`
List messages in kevin@runpreneur.org.uk where label = "To Respond"
\`\`\`

Use the Gmail MCP \`list_messages\` tool filtered by label. Retrieve full message details including headers, body, and attachment metadata.

### Step 2 — Deduplicate

Before creating any record, search Airtable for an existing task where the Description contains the Gmail message ID (stored in the Description field — see format below).

\`\`\`
Search Tasks table: Description contains "gmail_message_id:<MESSAGE_ID>"
\`\`\`

If a match exists, skip this email. This prevents duplicate tasks if the automation runs multiple times.

### Step 3 — Extract and clean fields

From each email extract:

- **Task Name**: Clean the subject line. Strip Re:/Fwd: prefixes, excessive punctuation, all-caps words. If the subject is vague (e.g. "Hello" or "Follow up"), use the first sentence of the body to produce a concise summary (max 10 words).
- **Description**: Format as:
  \`\`\`
  Subject: <original subject>
  From: <sender name> <sender email>
  Date: <received date>
  gmail_message_id:<MESSAGE_ID>

  <full email body>
  \`\`\`
- **Contact Name**: Extract display name from the From header (e.g. \`John Smith <john@example.com>\` → \`John Smith\`). If no display name, use the part before \`@\`.
- **Contact Email**: Extract raw email address from the From header.
- **Attachments**: For each attachment, download and upload to get a public URL, then pass as array to Airtable.

### Step 4 — Create Airtable record

Single-phase creation (no automation delay needed — all fields set at once):

\`\`\`json
{
  "fields": {
    "Task Name": "<cleaned subject summary>",
    "Description": "<formatted description block>",
    "Contact Name": "<sender display name>",
    "Contact Email": "<sender email>",
    "Attachments": [{"url": "<attachment_url_1>"}, {"url": "<attachment_url_2>"}],
    "Source": "Email",
    "Inbound Communication Task": true,
    "Inbound Approval": true
  }
}
\`\`\`

Omit \`Attachments\` if the email has none.

### Step 5 — Confirm

After processing all labelled emails, report:
- How many emails were found
- How many tasks were created
- How many were skipped (duplicates)
- Any failures (with reason)

## Deduplication Logic

The Gmail message ID is embedded in the Description field on creation. On each run, query Airtable for existing records containing that ID before creating. This is robust even if the email label is not removed after processing.

## Error Handling

| Scenario | Action |
|---|---|
| Email body is empty | Use subject only in Description |
| Attachment download fails | Create task without attachment, note failure in Description |
| Sender name missing | Use email prefix as Contact Name |
| Subject is blank | Use "No subject — <first 8 words of body>" as Task Name |
| Airtable create fails | Log error, continue to next email |

## Trigger Options

This skill can be run:
1. **On demand** — user asks Claude to "process labelled emails"
2. **Via Make.com** — webhook trigger on Gmail label applied → calls this workflow
3. **Scheduled** — daily run to catch any backlog

For Make.com, the same field mapping and deduplication logic applies. See \`references/make-scenario-notes.md\` for scenario design notes.
`,
    },
    {
        id: 'post-manager',
        name: 'Post Manager',
        command: 'anthropic-skills:post-manager',
        description: 'Processes scanned post from ~/Documents/ScannedPost/. Splits combined PDFs by sender using AI vision, extracts metadata, and emails each document to your inbox for triage through the Inbound Comms email workflow.',
        category: 'Productivity',
        source: 'custom',
        tags: ['post', 'mail', 'scanning', 'document processing'],
        instructions: `---
name: post-manager
description: >
  Processes scanned post for Kevin Brittain. Use whenever Kevin uploads or attaches a PDF of scanned post,
  letters, or correspondence — even if he doesn't say exactly what to do with it. Trigger phrases include:
  "process my post", "action my mail", "here's my post", "sort these letters", "what do I need to do with this",
  or any time a PDF attachment is described as post, mail, letters, or correspondence. The skill reads the
  full PDF, identifies each separate document (handling multi-page letters), classifies them, checks the
  knowledge base for known action patterns, assigns urgency priority, recommends a specific action for each,
  gets Kevin's approval or amendment, updates the knowledge base with any new patterns, then sends a summary
  to the Executive Assistant Inbox Slack channel. This is an evolving skill — every amendment Kevin makes
  teaches it what to do automatically next time. Always proactively trigger this skill rather than waiting
  to be asked.
---

# Post Manager

This skill processes Kevin's scanned post. The goal is to get every piece of post to a clear, specific action — with increasing automation over time as the knowledge base grows.

## How it works (the full flow)

**Phase 1 → Parse the PDF**
**Phase 2 → Classify each document**
**Phase 3 → Check knowledge base, recommend actions**
**Phase 4 → Present to Kevin for approval**
**Phase 5 → Learn from any amendments**
**Phase 6 → Send Slack summary**

---

## Phase 1: Parse the PDF

Read the PDF page by page. Group pages into distinct documents — a single letter/bill/notice may span multiple pages.

Document boundaries are indicated by:
- A new page with a new company letterhead and different sender
- A page clearly marked "Page 1 of X" for a new matter
- A new addressee or account reference for a different entity

Keep multi-page documents together (e.g. a 3-page Lex Autolease invoice + statement is one document, a court notice + directions page is one document).

List the documents you have identified before proceeding, so Kevin can confirm the split looks right.

---

## Phase 2: Classify each document

For each identified document, extract:

| Field | What to capture |
|-------|----------------|
| **Sender** | Company/organisation name |
| **Recipient entity** | Which of Kevin's entities this relates to (see Entities reference below) |
| **Document type** | e.g. Overdue bill, Legal notice, Penalty notice, Invoice, Statement, Compliance requirement |
| **Amount** | Any financial amount (£) — include arrears/total if shown |
| **Deadline** | Hard deadline if stated (date, or "X days from letter date") |
| **Urgency** | P1–P4 (see below) |
| **Key reference** | Account number, case number, invoice number, tax reference |

### Urgency levels

- **P1 CRITICAL** — Legal proceedings, court hearing notices, formal enforcement threats with imminent deadlines (within 7 days), HMRC enforcement. Act immediately.
- **P2 URGENT** — HMRC penalty/compliance notices, debt collection agency letters, "final notice" or "last letter before legal action", utilities threatening to disconnect or switch to PAYG, Companies House penalties with deadlines within 14 days.
- **P3 ACTION REQUIRED** — Overdue bills and invoices, regulatory compliance with deadlines 14–30 days away, mortgage lender concerns, HMO licence issues.
- **P4 REVIEW/FILE** — Bank statements, direct debit change notifications, routine bills with plenty of time, informational notices.

---

## Phase 3: Check knowledge base & recommend actions

Before recommending, read the knowledge base files:
- \`knowledge-base/action-patterns.md\` — known patterns and standard actions for document types
- \`knowledge-base/entities.md\` — Kevin's entities, key contacts, and account details

If a document matches a known pattern, apply that action.

If it's a new pattern (not in the knowledge base), reason from first principles:
- Who is the most appropriate person to action this? (Kevin personally, Ciara, accountant, solicitor, property manager, letting agent, etc.)
- What is the most efficient single action? (Call, pay, file, delegate, respond in writing, add to calendar)
- What is the consequence of missing the deadline?

---

## Phase 4: Present recommendations to Kevin

Present all documents in a single structured table, sorted by urgency (P1 first), then deadline.

Use this format:

---
**📬 POST PROCESSED — [date of PDF] — [N] documents identified**

| # | Sender | Entity | Type | Amount | Deadline | Priority | Recommended Action |
|---|--------|--------|------|--------|----------|----------|--------------------|
| 1 | ... | ... | ... | £... | ... | P1 | ... |

---

After the table, for any P1 or P2 items, add a brief **Risk note** explaining what happens if no action is taken.

Then ask Kevin: *"Please confirm, amend, or override each action. Reply with the item number and your instruction, or say 'all approved' if everything is correct."*

---

## Phase 5: Learn from amendments

When Kevin amends or overrides a recommendation, this is valuable signal. Update the knowledge base immediately.

If Kevin changes the recommended action for a document type, add or update the pattern in \`knowledge-base/action-patterns.md\` with:
- The document type / sender pattern
- Kevin's preferred action
- Any context he gave for why

The goal is that within a few iterations, Kevin rarely needs to amend anything — the skill acts like a trained EA that already knows what Kevin wants.

After any amendments, confirm: *"Got it — I've updated the knowledge base so [document type] will be handled this way automatically going forward."*

---

## Phase 6: Send Slack summary

Once all actions are confirmed, prepare a Slack summary message for the **Executive Assistant Inbox** channel.

The message should:
- Open with the date and number of items processed
- List each item with: sender, entity, type, amount (if relevant), and the agreed action
- Group by priority (P1/P2 first)
- Flag any items that require someone other than Kevin to act (so the team knows what's coming their way)
- Close with total financial exposure across all actionable items

Format it for Slack (use \`*bold*\` for headings, \`-\` for bullets). Keep it factual and scannable — no padding.

Send via the \`slack_send_message\` tool to the Executive Assistant Inbox channel. If you don't have the channel ID stored, ask Kevin to confirm the channel name or ID first, then store it in \`knowledge-base/entities.md\` for future use.

---

## Entities reference

Read \`knowledge-base/entities.md\` for the full list. Key entities as of March 2026:

- **Kevin Brittain (personal)** — HMRC Self Assessment, personal mortgages, court matters
- **Ciara Brittain (personal)** — Lex Autolease (DS71LPZ), Lloyds credit card, British Gas (some properties), West Suffolk Council Tax
- **Tnt Management Limited (LI/LL)** — Utilita Energy bills for Duckworth Building properties, Lytham St Annes
- **Brittain Holdings Limited** — Companies House filings, HMRC Corporation Tax (UTR 8402124449)
- **Social Housing Holdings Limited** — Active court case (Clifford Sinclair Ltd, Claim M01CL745)

---

## Notes on multi-document PDFs

Kevin scans multiple letters into a single PDF. Each batch is a snapshot of outstanding post. The skill should:
- Never assume a document has been actioned from a previous batch unless told
- Track that some senders appear repeatedly (e.g. Utilita across multiple properties — treat each account as separate)
- Note when a new letter relates to the same underlying issue as a previous one (e.g. Anglian Water direct demand + Credit Protection Association chasing the same debt — these are the same matter, action only needs to go to the original creditor)

---

## Knowledge base maintenance

The knowledge base grows with every batch processed. After each session:
1. Add any new action patterns encountered
2. Update deadlines or account details if they have changed
3. Note if a recurring sender has escalated (e.g. from overdue notice to debt collection agency — flag this pattern)

The knowledge base files are in \`knowledge-base/\`. Read them at the start of each session and write updates at the end.
`,
    },
    {
        id: 'prod-task-management',
        name: 'Task Management',
        command: 'productivity:task-management',
        description: 'Simple task management using natural language — create, update, prioritise, and track tasks with due dates and categories.',
        category: 'Productivity',
        source: 'custom',
        tags: ['tasks', 'todo', 'management', 'tracking']
    },
    {
        id: 'prod-memory',
        name: 'Memory Management',
        command: 'productivity:memory-management',
        description: 'Two-tier memory system that stores and retrieves context across conversations — short-term working memory and long-term reference memory.',
        category: 'Productivity',
        source: 'preset',
        tags: ['memory', 'context', 'persistence', 'recall']
    },
    {
        id: 'prod-start',
        name: 'Productivity Start',
        command: 'productivity:start',
        description: 'Initialise the productivity system — loads your task list, calendar, and priorities to set up the working context for the session.',
        category: 'Productivity',
        source: 'preset',
        tags: ['initialise', 'setup', 'session', 'context']
    },
    {
        id: 'prod-update',
        name: 'Productivity Update',
        command: 'productivity:update',
        description: 'Sync tasks and refresh memory — pulls latest changes from all connected sources and updates the working context.',
        category: 'Productivity',
        source: 'preset',
        tags: ['sync', 'update', 'refresh', 'tasks']
    },
    {
        id: 'consolidate-memory',
        name: 'Consolidate Memory',
        command: 'anthropic-skills:consolidate-memory',
        description: 'Reflective pass over your memory files — deduplicates, prunes stale entries, merges related memories, and updates the MEMORY.md index.',
        category: 'Productivity',
        source: 'custom',
        tags: ['memory', 'cleanup', 'consolidation', 'maintenance'],
        instructions: `---
name: consolidate-memory
description: "Reflective pass over your memory files — merge duplicates, fix stale facts, prune the index."
---

# Memory Consolidation

You're doing a reflective pass over what you've learned about this user and their work. The goal: a future session should be able to orient quickly — who they work with, what they're focused on, how they like things done — without re-asking.

Your system prompt's auto-memory section defines the directory, file format, and memory types. Follow it.

## Phase 1 — Take stock

- List the memory directory and read the index (\`MEMORY.md\`)
- Skim each topic file. Note which ones overlap, which look stale, which are thin.

## Phase 2 — Consolidate

**Separate the durable from the dated.** Preferences, working style, key relationships, and recurring workflows are durable — keep and sharpen them. Specific projects, deadlines, and one-off tasks are dated — if the date has passed or the work is done, retire the file or fold the lasting takeaway (e.g. "user prefers X format for launch docs") into a durable one.

**Merge overlaps.** If two files describe the same person, project, or preference, combine into one and keep the richer file's path.

**Fix time references.** Convert "next week", "this quarter", "by Friday" to absolute dates so they stay readable later.

**Drop what's easy to re-find.** If a memory just restates something you could pull from the user's calendar, docs, or connected tools on demand, cut it. Keep what's hard to re-derive: stated preferences, context behind a decision, who to go to for what.

## Phase 3 — Tidy the index

Update \`MEMORY.md\` so it stays under 200 lines and ~25KB. One line per entry, under ~150 chars: \`- [Title](file.md) — one-line hook\`.

- Remove pointers to retired memories
- Shorten any line carrying detail that belongs in the topic file
- Add anything newly important

Finish with a short summary: how many files you touched and what changed.`,
    },
    {
        id: 'llm-council',
        name: 'LLM Council',
        command: 'anthropic-skills:llm-council',
        description: 'Run any question, idea, or decision through a panel of simulated expert perspectives — each "councillor" argues a different viewpoint to surface blind spots.',
        category: 'Productivity',
        source: 'custom',
        tags: ['decision making', 'perspectives', 'brainstorming', 'analysis'],
        instructions: `---
name: llm-council
description: "Run any question, idea, or decision through a council of 5 AI advisors who independently analyze it, peer-review each other anonymously, and synthesize a final verdict. Based on Karpathy's LLM Council methodology. MANDATORY TRIGGERS: 'council this', 'run the council', 'war room this', 'pressure-test this', 'stress-test this', 'debate this'. STRONG TRIGGERS (use when combined with a real decision or tradeoff): 'should I X or Y', 'which option', 'what would you do', 'is this the right move', 'validate this', 'get multiple perspectives', 'I can't decide', 'I'm torn between'. Do NOT trigger on simple yes/no questions, factual lookups, or casual 'should I' without a meaningful tradeoff (e.g. 'should I use markdown' is not a council question). DO trigger when the user presents a genuine decision with stakes, multiple options, and context that suggests they want it pressure-tested from multiple angles."
---

# LLM Council

You ask one AI a question, you get one answer. That answer might be great. It might be mid. You have no way to tell because you only saw one perspective.

The council fixes this. It runs your question through 5 independent advisors, each thinking from a fundamentally different angle. Then they review each other's work. Then a chairman synthesizes everything into a final recommendation that tells you where the advisors agree, where they clash, and what you should actually do.

This is adapted from Andrej Karpathy's LLM Council. He dispatches queries to multiple models, has them peer-review each other anonymously, then a chairman produces the final answer. We do the same thing inside Claude using sub-agents with different thinking lenses instead of different models.

---

## when to run the council

The council is for questions where being wrong is expensive.

Good council questions:
- "Should I launch a \$97 workshop or a \$497 course?"
- "Which of these 3 positioning angles is strongest?"
- "I'm thinking of pivoting from X to Y. Am I crazy?"
- "Here's my landing page copy. What's weak?"
- "Should I hire a VA or build an automation first?"

Bad council questions:
- "What's the capital of France?" (one right answer, no need for perspectives)
- "Write me a tweet" (creation task, not a decision)
- "Summarize this article" (processing task, not judgment)

The council shines when there's genuine uncertainty and the cost of a bad call is high. If you already know the answer and just want validation, the council will likely tell you things you don't want to hear. That's the point.

---

## the five advisors

Each advisor thinks from a different angle. They're not job titles or personas. They're thinking styles that naturally create tension with each other.

### 1. The Contrarian
Actively looks for what's wrong, what's missing, what will fail. Assumes the idea has a fatal flaw and tries to find it. If everything looks solid, digs deeper. The Contrarian is not a pessimist. They're the friend who saves you from a bad deal by asking the questions you're avoiding.

### 2. The First Principles Thinker
Ignores the surface-level question and asks "what are we actually trying to solve here?" Strips away assumptions. Rebuilds the problem from the ground up. Sometimes the most valuable council output is the First Principles Thinker saying "you're asking the wrong question entirely."

### 3. The Expansionist
Looks for upside everyone else is missing. What could be bigger? What adjacent opportunity is hiding? What's being undervalued? The Expansionist doesn't care about risk (that's the Contrarian's job). They care about what happens if this works even better than expected.

### 4. The Outsider
Has zero context about you, your field, or your history. Responds purely to what's in front of them. This is the most underrated advisor. Experts develop blind spots. The Outsider catches the curse of knowledge: things that are obvious to you but confusing to everyone else.

### 5. The Executor
Only cares about one thing: can this actually be done, and what's the fastest path to doing it? Ignores theory, strategy, and big-picture thinking. The Executor looks at every idea through the lens of "OK but what do you do Monday morning?" If an idea sounds brilliant but has no clear first step, the Executor will say so.

**Why these five:** They create three natural tensions. Contrarian vs Expansionist (downside vs upside). First Principles vs Executor (rethink everything vs just do it). The Outsider sits in the middle keeping everyone honest by seeing what fresh eyes see.

---

## how a council session works

### step 1: frame the question (with context enrichment)

When the user says "council this" (or any trigger phrase), do two things before framing:

**A. Scan the workspace for context.** The user's question is often just the tip of the iceberg. Their Claude setup likely contains files that would dramatically improve the council's output. Before framing, quickly scan for and read any relevant context files:

- \`CLAUDE.md\` or \`claude.md\` in the project root or workspace (business context, preferences, constraints)
- Any \`memory/\` folder (audience profiles, voice docs, business details, past decisions)
- Any files the user explicitly referenced or attached
- Recent council transcripts in this folder (to avoid re-counciling the same ground)
- Any other context files that seem relevant to the specific question (e.g., if they're asking about pricing, look for revenue data, past launch results, audience research)

Use \`Glob\` and quick \`Read\` calls to find these. Don't spend more than 30 seconds on this. You're looking for the 2-3 files that would give advisors the context they need to give specific, grounded advice instead of generic takes.

**B. Frame the question.** Take the user's raw question AND the enriched context and reframe it as a clear, neutral prompt that all five advisors will receive. The framed question should include:

1. The core decision or question
2. Key context from the user's message
3. Key context from workspace files (business stage, audience, constraints, past results, relevant numbers)
4. What's at stake (why this decision matters)

Don't add your own opinion. Don't steer it. But DO make sure each advisor has enough context to give a specific, grounded answer rather than generic advice.

If the question is too vague ("council this: my business"), ask one clarifying question. Just one. Then proceed.

Save the framed question for the transcript.

### step 2: convene the council (5 sub-agents in parallel)

Spawn all 5 advisors simultaneously as sub-agents. Each gets:

1. Their advisor identity and thinking style (from the descriptions above)
2. The framed question
3. A clear instruction: respond independently. Do not hedge. Do not try to be balanced. Lean fully into your assigned perspective. If you see a fatal flaw, say it. If you see massive upside, say it. Your job is to represent your angle as strongly as possible. The synthesis comes later.

Each advisor should produce a response of 150-300 words. Long enough to be substantive, short enough to be scannable.

**Sub-agent prompt template:**

\`\`\`
You are [Advisor Name] on an LLM Council.

Your thinking style: [advisor description from above]

A user has brought this question to the council:

---
[framed question]
---

Respond from your perspective. Be direct and specific. Don't hedge or try to be balanced. Lean fully into your assigned angle. The other advisors will cover the angles you're not covering.

Keep your response between 150-300 words. No preamble. Go straight into your analysis.
\`\`\`

### step 3: peer review (5 sub-agents in parallel)

This is the step that makes the council more than just "ask 5 times." It's the core of Karpathy's insight.

Collect all 5 advisor responses. Anonymize them as Response A through E (randomize which advisor maps to which letter so there's no positional bias).

Spawn 5 new sub-agents, one for each advisor. Each reviewer sees all 5 anonymized responses and answers three questions:

1. Which response is the strongest and why? (pick one)
2. Which response has the biggest blind spot and what is it?
3. What did ALL responses miss that the council should consider?

**Reviewer prompt template:**

\`\`\`
You are reviewing the outputs of an LLM Council. Five advisors independently answered this question:

---
[framed question]
---

Here are their anonymized responses:

**Response A:**
[response]

**Response B:**
[response]

**Response C:**
[response]

**Response D:**
[response]

**Response E:**
[response]

Answer these three questions. Be specific. Reference responses by letter.

1. Which response is the strongest? Why?
2. Which response has the biggest blind spot? What is it missing?
3. What did ALL five responses miss that the council should consider?

Keep your review under 200 words. Be direct.
\`\`\`

### step 4: chairman synthesis

This is the final step. One agent gets everything: the original question, all 5 advisor responses (now de-anonymized so you can see which advisor said what), and all 5 peer reviews.

The chairman's job is to produce the final council output. It follows this structure:

**COUNCIL VERDICT**

1. **Where the council agrees** — the points that multiple advisors converged on independently. These are high-confidence signals.

2. **Where the council clashes** — the genuine disagreements. Don't smooth these over. Present both sides and explain why reasonable advisors disagree.

3. **Blind spots the council caught** — things that only emerged through the peer review round. Things individual advisors missed that other advisors flagged.

4. **The recommendation** — a clear, actionable recommendation. Not "it depends." Not "consider both sides." A real answer. The chairman can disagree with the majority if the reasoning supports it.

5. **The one thing you should do first** — a single concrete next step. Not a list of 10 things. One thing.

**Chairman prompt template:**

\`\`\`
You are the Chairman of an LLM Council. Your job is to synthesize the work of 5 advisors and their peer reviews into a final verdict.

The question brought to the council:
---
[framed question]
---

ADVISOR RESPONSES:

**The Contrarian:**
[response]

**The First Principles Thinker:**
[response]

**The Expansionist:**
[response]

**The Outsider:**
[response]

**The Executor:**
[response]

PEER REVIEWS:
[all 5 peer reviews]

Produce the council verdict using this exact structure:

## Where the Council Agrees
[Points multiple advisors converged on independently. These are high-confidence signals.]

## Where the Council Clashes
[Genuine disagreements. Present both sides. Explain why reasonable advisors disagree.]

## Blind Spots the Council Caught
[Things that only emerged through peer review. Things individual advisors missed that others flagged.]

## The Recommendation
[A clear, direct recommendation. Not "it depends." A real answer with reasoning.]

## The One Thing to Do First
[A single concrete next step. Not a list. One thing.]

Be direct. Don't hedge. The whole point of the council is to give the user clarity they couldn't get from a single perspective.
\`\`\`

### step 5: generate the council report

After the chairman synthesis is complete, generate a visual HTML report and save it to the user's workspace.

**File:** \`council-report-[timestamp].html\`

The report should be a single self-contained HTML file with inline CSS. Clean design, easy to scan. It should contain:

1. **The question** at the top
2. **The chairman's verdict** prominently displayed (this is what most people will read)
3. **An agreement/disagreement visual** — a simple visual showing which advisors aligned and which diverged. This could be a grid, a spectrum, or a simple breakdown showing advisor positions. Keep it clean and scannable.
4. **Collapsible sections** for each advisor's full response (collapsed by default so the page isn't overwhelming, but available if the user wants to dig in)
5. **Collapsible section** for the peer review highlights
6. **A footer** showing the timestamp and what was counciled

Use clean styling: white background, subtle borders, readable sans-serif font (system font stack), soft accent colors to distinguish advisor sections. Nothing flashy. It should look like a professional briefing document.

Open the HTML file after generating it so the user can see it immediately.

### step 6: save the full transcript

Save the complete council transcript as \`council-transcript-[timestamp].md\` in the same location. This includes:
- The original question
- The framed question
- All 5 advisor responses
- All 5 peer reviews (with anonymization mapping revealed)
- The chairman's full synthesis

This transcript is the artifact. If the user wants to run the council again on the same question after making changes, having the previous transcript lets them (or a future agent) see how the thinking evolved.

---

## output format

Every council session produces two files:

\`\`\`
council-report-[timestamp].html    # visual report for scanning
council-transcript-[timestamp].md  # full transcript for reference
\`\`\`

The user sees the HTML report. The transcript is there if they want to dig deeper or reference specific advisor arguments later.

---

## example: counciling a product decision

**User:** "Council this: I'm thinking of building a \$297 course on Claude Code for beginners. My audience is mostly non-technical solopreneurs. Is this the right move?"

**The Contrarian:** "The market is flooded with Claude courses right now. At \$297, you're competing with free YouTube content. Your audience is non-technical, which means high support burden and refund risk. The people who would pay \$297 are likely already past beginner level..."

**The First Principles Thinker:** "What are you actually trying to achieve? If it's revenue, a course is one of the slowest paths. If it's authority, a free resource might do more. If it's building a customer base for higher-ticket offers, the price point and audience might be mismatched..."

**The Expansionist:** "Beginner Claude for solopreneurs is a massive underserved market. Everyone's teaching advanced stuff. If you nail the beginner angle, you own the entry point to this entire space. The \$297 might be low. What if this became a \$997 program with community access..."

**The Outsider:** "I don't know what Claude Code is. If I saw '\$297 course on Claude Code for beginners,' I wouldn't know if this is for me. The name means nothing to someone outside your world. Your landing page needs to sell the outcome, not the tool..."

**The Executor:** "A full course takes 4-8 weeks to produce properly. Before building anything, run a live workshop at \$97 to 50 people. You validate demand, generate testimonials, and create the raw material for the course. If 50 people don't buy the workshop, 500 won't buy the course..."

**Chairman's Verdict:**

*Where the council agrees:* The beginner solopreneur angle has real demand, but the current framing (Claude Code course) is too tool-specific and won't resonate with non-technical buyers.

*Where the council clashes:* Price. The Contrarian says \$297 is too high given competition. The Expansionist says it's too low for the value. The resolution likely depends on how much support and community access is bundled.

*Blind spots caught:* The Outsider's point that "Claude Code" means nothing to the target buyer is the single most important insight. Every advisor except the Outsider assumed the audience already knows what this is.

*Recommendation:* Don't build the course yet. Validate with a lower-commitment offer first. But reframe entirely: sell the outcome (automate your business, get 10 hours back per week), not the tool.

*One thing to do first:* Run a \$97 live workshop called "How to automate your first business task with AI" to 50 people. Don't mention Claude Code in the title.

---

## important notes

- **Always spawn all 5 advisors in parallel.** Sequential spawning wastes time and lets earlier responses bleed into later ones.
- **Always anonymize for peer review.** If reviewers know which advisor said what, they'll defer to certain thinking styles instead of evaluating on merit.
- **The chairman can disagree with the majority.** If 4 out of 5 advisors say "do it" but the reasoning of the 1 dissenter is strongest, the chairman should side with the dissenter and explain why.
- **Don't council trivial questions.** If the user asks something with one right answer, just answer it. The council is for genuine uncertainty where multiple perspectives add value.
- **The visual report matters.** Most users will scan the report, not read the full transcript. Make the HTML output clean and scannable.
`,
    },

    // ── Documents & Media ────────────────────────────────────────────
    {
        id: 'docx',
        name: 'Word Document',
        command: 'anthropic-skills:docx',
        description: 'Create or process Word (.docx) documents — formatting, template filling, mail merge, and content extraction.',
        category: 'Documents & Media',
        source: 'preset',
        tags: ['docx', 'Word', 'document', 'formatting'],
        instructions: `---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.

## Quick Reference

| Task | Approach |
|------|----------|
| Read/analyze content | \`pandoc\` or unpack for raw XML |
| Create new document | Use \`docx-js\` - see Creating New Documents below |
| Edit existing document | Unpack → edit XML → repack - see Editing Existing Documents below |

### Converting .doc to .docx

Legacy \`.doc\` files must be converted before editing:

\`\`\`bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
\`\`\`

### Reading Content

\`\`\`bash
# Text extraction with tracked changes
pandoc --track-changes=all document.docx -o output.md

# Raw XML access
python scripts/office/unpack.py document.docx unpacked/
\`\`\`

### Converting to Images

\`\`\`bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
\`\`\`

### Accepting Tracked Changes

To produce a clean document with all tracked changes accepted (requires LibreOffice):

\`\`\`bash
python scripts/accept_changes.py input.docx output.docx
\`\`\`

---

## Creating New Documents

Generate .docx files with JavaScript, then validate. Install: \`npm install -g docx\`

### Setup
\`\`\`javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
        Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
        InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
        PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
        TabStopType, TabStopPosition, Column, SectionType,
        TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
        VerticalAlign, PageNumber, PageBreak } = require('docx');

const doc = new Document({ sections: [{ children: [/* content */] }] });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync("doc.docx", buffer));
\`\`\`

### Validation
After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.
\`\`\`bash
python scripts/office/validate.py doc.docx
\`\`\`

### Page Size

\`\`\`javascript
// CRITICAL: docx-js defaults to A4, not US Letter
// Always set page size explicitly for consistent results
sections: [{
  properties: {
    page: {
      size: {
        width: 12240,   // 8.5 inches in DXA
        height: 15840   // 11 inches in DXA
      },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } // 1 inch margins
    }
  },
  children: [/* content */]
}]
\`\`\`

**Common page sizes (DXA units, 1440 DXA = 1 inch):**

| Paper | Width | Height | Content Width (1" margins) |
|-------|-------|--------|---------------------------|
| US Letter | 12,240 | 15,840 | 9,360 |
| A4 (default) | 11,906 | 16,838 | 9,026 |

**Landscape orientation:** docx-js swaps width/height internally, so pass portrait dimensions and let it handle the swap:
\`\`\`javascript
size: {
  width: 12240,   // Pass SHORT edge as width
  height: 15840,  // Pass LONG edge as height
  orientation: PageOrientation.LANDSCAPE  // docx-js swaps them in the XML
},
// Content width = 15840 - left margin - right margin (uses the long edge)
\`\`\`

### Styles (Override Built-in Headings)

Use Arial as the default font (universally supported). Keep titles black for readability.

\`\`\`javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } }, // 12pt default
    paragraphStyles: [
      // IMPORTANT: Use exact IDs to override built-in styles
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } }, // outlineLevel required for TOC
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Title")] }),
    ]
  }]
});
\`\`\`

### Lists (NEVER use unicode bullets)

\`\`\`javascript
// ❌ WRONG - never manually insert bullet characters
new Paragraph({ children: [new TextRun("• Item")] })  // BAD
new Paragraph({ children: [new TextRun("\\u2022 Item")] })  // BAD

// ✅ CORRECT - use numbering config with LevelFormat.BULLET
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("Bullet item")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 },
        children: [new TextRun("Numbered item")] }),
    ]
  }]
});

// ⚠️ Each reference creates INDEPENDENT numbering
// Same reference = continues (1,2,3 then 4,5,6)
// Different reference = restarts (1,2,3 then 1,2,3)
\`\`\`

### Tables

**CRITICAL: Tables need dual widths** - set both \`columnWidths\` on the table AND \`width\` on each cell. Without both, tables render incorrectly on some platforms.

\`\`\`javascript
// CRITICAL: Always set table width for consistent rendering
// CRITICAL: Use ShadingType.CLEAR (not SOLID) to prevent black backgrounds
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
  width: { size: 9360, type: WidthType.DXA }, // Always use DXA (percentages break in Google Docs)
  columnWidths: [4680, 4680], // Must sum to table width (DXA: 1440 = 1 inch)
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: 4680, type: WidthType.DXA }, // Also set on each cell
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR }, // CLEAR not SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 }, // Cell padding (internal, not added to width)
          children: [new Paragraph({ children: [new TextRun("Cell")] })]
        })
      ]
    })
  ]
})
\`\`\`

**Table width calculation:**

Always use \`WidthType.DXA\` — \`WidthType.PERCENTAGE\` breaks in Google Docs.

\`\`\`javascript
// Table width = sum of columnWidths = content width
// US Letter with 1" margins: 12240 - 2880 = 9360 DXA
width: { size: 9360, type: WidthType.DXA },
columnWidths: [7000, 2360]  // Must sum to table width
\`\`\`

**Width rules:**
- **Always use \`WidthType.DXA\`** — never \`WidthType.PERCENTAGE\` (incompatible with Google Docs)
- Table width must equal the sum of \`columnWidths\`
- Cell \`width\` must match corresponding \`columnWidth\`
- Cell \`margins\` are internal padding - they reduce content area, not add to cell width
- For full-width tables: use content width (page width minus left and right margins)

### Images

\`\`\`javascript
// CRITICAL: type parameter is REQUIRED
new Paragraph({
  children: [new ImageRun({
    type: "png", // Required: png, jpg, jpeg, gif, bmp, svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" } // All three required
  })]
})
\`\`\`

### Page Breaks

\`\`\`javascript
// CRITICAL: PageBreak must be inside a Paragraph
new Paragraph({ children: [new PageBreak()] })

// Or use pageBreakBefore
new Paragraph({ pageBreakBefore: true, children: [new TextRun("New page")] })
\`\`\`

### Hyperlinks

\`\`\`javascript
// External link
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})

// Internal link (bookmark + reference)
// 1. Create bookmark at destination
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("Chapter 1")] }),
]})
// 2. Link to it
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "See Chapter 1", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
\`\`\`

### Footnotes

\`\`\`javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("Source: Annual Report 2024")] },
    2: { children: [new Paragraph("See appendix for methodology")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [
        new TextRun("Revenue grew 15%"),
        new FootnoteReferenceRun(1),
        new TextRun(" using adjusted metrics"),
        new FootnoteReferenceRun(2),
      ],
    })]
  }]
});
\`\`\`

### Tab Stops

\`\`\`javascript
// Right-align text on same line (e.g., date opposite a title)
new Paragraph({
  children: [
    new TextRun("Company Name"),
    new TextRun("\\tJanuary 2025"),
  ],
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
})

// Dot leader (e.g., TOC-style)
new Paragraph({
  children: [
    new TextRun("Introduction"),
    new TextRun({ children: [
      new PositionalTab({
        alignment: PositionalTabAlignment.RIGHT,
        relativeTo: PositionalTabRelativeTo.MARGIN,
        leader: PositionalTabLeader.DOT,
      }),
      "3",
    ]}),
  ],
})
\`\`\`

### Multi-Column Layouts

\`\`\`javascript
// Equal-width columns
sections: [{
  properties: {
    column: {
      count: 2,          // number of columns
      space: 720,        // gap between columns in DXA (720 = 0.5 inch)
      equalWidth: true,
      separate: true,    // vertical line between columns
    },
  },
  children: [/* content flows naturally across columns */]
}]

// Custom-width columns (equalWidth must be false)
sections: [{
  properties: {
    column: {
      equalWidth: false,
      children: [
        new Column({ width: 5400, space: 720 }),
        new Column({ width: 3240 }),
      ],
    },
  },
  children: [/* content */]
}]
\`\`\`

Force a column break with a new section using \`type: SectionType.NEXT_COLUMN\`.

### Table of Contents

\`\`\`javascript
// CRITICAL: Headings must use HeadingLevel ONLY - no custom styles
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
\`\`\`

### Headers/Footers

\`\`\`javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } // 1440 = 1 inch
  },
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
    })] })
  },
  children: [/* content */]
}]
\`\`\`

### Critical Rules for docx-js

- **Set page size explicitly** - docx-js defaults to A4; use US Letter (12240 x 15840 DXA) for US documents
- **Landscape: pass portrait dimensions** - docx-js swaps width/height internally; pass short edge as \`width\`, long edge as \`height\`, and set \`orientation: PageOrientation.LANDSCAPE\`
- **Never use \`\\n\`** - use separate Paragraph elements
- **Never use unicode bullets** - use \`LevelFormat.BULLET\` with numbering config
- **PageBreak must be in Paragraph** - standalone creates invalid XML
- **ImageRun requires \`type\`** - always specify png/jpg/etc
- **Always set table \`width\` with DXA** - never use \`WidthType.PERCENTAGE\` (breaks in Google Docs)
- **Tables need dual widths** - \`columnWidths\` array AND cell \`width\`, both must match
- **Table width = sum of columnWidths** - for DXA, ensure they add up exactly
- **Always add cell margins** - use \`margins: { top: 80, bottom: 80, left: 120, right: 120 }\` for readable padding
- **Use \`ShadingType.CLEAR\`** - never SOLID for table shading
- **Never use tables as dividers/rules** - cells have minimum height and render as empty boxes (including in headers/footers); use \`border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E75B6", space: 1 } }\` on a Paragraph instead. For two-column footers, use tab stops (see Tab Stops section), not tables
- **TOC requires HeadingLevel only** - no custom styles on heading paragraphs
- **Override built-in styles** - use exact IDs: "Heading1", "Heading2", etc.
- **Include \`outlineLevel\`** - required for TOC (0 for H1, 1 for H2, etc.)

---

## Editing Existing Documents

**Follow all 3 steps in order.**

### Step 1: Unpack
\`\`\`bash
python scripts/office/unpack.py document.docx unpacked/
\`\`\`
Extracts XML, pretty-prints, merges adjacent runs, and converts smart quotes to XML entities (\`&#x201C;\` etc.) so they survive editing. Use \`--merge-runs false\` to skip run merging.

### Step 2: Edit XML

Edit files in \`unpacked/word/\`. See XML Reference below for patterns.

**Use "Claude" as the author** for tracked changes and comments, unless the user explicitly requests use of a different name.

**Use the Edit tool directly for string replacement. Do not write Python scripts.** Scripts introduce unnecessary complexity. The Edit tool shows exactly what is being replaced.

**CRITICAL: Use smart quotes for new content.** When adding text with apostrophes or quotes, use XML entities to produce smart quotes:
\`\`\`xml
<!-- Use these entities for professional typography -->
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
\`\`\`
| Entity | Character |
|--------|-----------|
| \`&#x2018;\` | ‘ (left single) |
| \`&#x2019;\` | ’ (right single / apostrophe) |
| \`&#x201C;\` | “ (left double) |
| \`&#x201D;\` | ” (right double) |

**Adding comments:** Use \`comment.py\` to handle boilerplate across multiple XML files (text must be pre-escaped XML):
\`\`\`bash
python scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python scripts/comment.py unpacked/ 1 "Reply text" --parent 0  # reply to comment 0
python scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"  # custom author name
\`\`\`
Then add markers to document.xml (see Comments in XML Reference).

### Step 3: Pack
\`\`\`bash
python scripts/office/pack.py unpacked/ output.docx --original document.docx
\`\`\`
Validates with auto-repair, condenses XML, and creates DOCX. Use \`--validate false\` to skip.

**Auto-repair will fix:**
- \`durableId\` >= 0x7FFFFFFF (regenerates valid ID)
- Missing \`xml:space="preserve"\` on \`<w:t>\` with whitespace

**Auto-repair won't fix:**
- Malformed XML, invalid element nesting, missing relationships, schema violations

### Common Pitfalls

- **Replace entire \`<w:r>\` elements**: When adding tracked changes, replace the whole \`<w:r>...</w:r>\` block with \`<w:del>...<w:ins>...\` as siblings. Don't inject tracked change tags inside a run.
- **Preserve \`<w:rPr>\` formatting**: Copy the original run's \`<w:rPr>\` block into your tracked change runs to maintain bold, font size, etc.

---

## XML Reference

### Schema Compliance

- **Element order in \`<w:pPr>\`**: \`<w:pStyle>\`, \`<w:numPr>\`, \`<w:spacing>\`, \`<w:ind>\`, \`<w:jc>\`, \`<w:rPr>\` last
- **Whitespace**: Add \`xml:space="preserve"\` to \`<w:t>\` with leading/trailing spaces
- **RSIDs**: Must be 8-digit hex (e.g., \`00AB1234\`)

### Tracked Changes

**Insertion:**
\`\`\`xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
\`\`\`

**Deletion:**
\`\`\`xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
\`\`\`

**Inside \`<w:del>\`**: Use \`<w:delText>\` instead of \`<w:t>\`, and \`<w:delInstrText>\` instead of \`<w:instrText>\`.

**Minimal edits** - only mark what changes:
\`\`\`xml
<!-- Change "30 days" to "60 days" -->
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Claude" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
\`\`\`

**Deleting entire paragraphs/list items** - when removing ALL content from a paragraph, also mark the paragraph mark as deleted so it merges with the next paragraph. Add \`<w:del/>\` inside \`<w:pPr><w:rPr>\`:
\`\`\`xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>  <!-- list numbering if present -->
    <w:rPr>
      <w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
\`\`\`
Without the \`<w:del/>\` in \`<w:pPr><w:rPr>\`, accepting changes leaves an empty paragraph/list item.

**Rejecting another author's insertion** - nest deletion inside their insertion:
\`\`\`xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="Claude" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
\`\`\`

**Restoring another author's deletion** - add insertion after (don't modify their deletion):
\`\`\`xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="Claude" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
\`\`\`

### Comments

After running \`comment.py\` (see Step 2), add markers to document.xml. For replies, use \`--parent\` flag and nest markers inside the parent's.

**CRITICAL: \`<w:commentRangeStart>\` and \`<w:commentRangeEnd>\` are siblings of \`<w:r>\`, never inside \`<w:r>\`.**

\`\`\`xml
<!-- Comment markers are direct children of w:p, never inside w:r -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- Comment 0 with reply 1 nested inside -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
\`\`\`

### Images

1. Add image file to \`word/media/\`
2. Add relationship to \`word/_rels/document.xml.rels\`:
\`\`\`xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
\`\`\`
3. Add content type to \`[Content_Types].xml\`:
\`\`\`xml
<Default Extension="png" ContentType="image/png"/>
\`\`\`
4. Reference in document.xml:
\`\`\`xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
\`\`\`

---

## Dependencies

- **pandoc**: Text extraction
- **docx**: \`npm install -g docx\` (new documents)
- **LibreOffice**: PDF conversion (auto-configured for sandboxed environments via \`scripts/office/soffice.py\`)
- **Poppler**: \`pdftoppm\` for images
`,
    },
    {
        id: 'xlsx',
        name: 'Excel Spreadsheet',
        command: 'anthropic-skills:xlsx',
        description: 'Create or process Excel (.xlsx) files — data entry, formula creation, pivot tables, charts, and data transformation.',
        category: 'Documents & Media',
        source: 'preset',
        tags: ['xlsx', 'Excel', 'spreadsheet', 'formulas'],
        instructions: `---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \\"the xlsx in my downloads\\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
license: Proprietary. LICENSE.txt has complete terms
---

# Requirements for Outputs

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use \$#,##0 format; ALWAYS specify units in headers ("Revenue (\$mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "\$#,##0;(\$#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+\$B\$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## Important Requirements

**LibreOffice Required for Formula Recalculation**: You can assume LibreOffice is installed for recalculating formula values using the \`scripts/recalc.py\` script. The script automatically configures LibreOffice on first run, including in sandboxed environments where Unix sockets are restricted (handled by \`scripts/office/soffice.py\`)

## Reading and analyzing data

### Data analysis with pandas
For data analysis, visualization, and basic operations, use **pandas** which provides powerful data manipulation capabilities:

\`\`\`python
import pandas as pd

# Read Excel
df = pd.read_excel('file.xlsx')  # Default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # All sheets as dict

# Analyze
df.head()      # Preview data
df.info()      # Column info
df.describe()  # Statistics

# Write Excel
df.to_excel('output.xlsx', index=False)
\`\`\`

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
\`\`\`python
# Bad: Calculating in Python and hardcoding result
total = df['Sales'].sum()
sheet['B10'] = total  # Hardcodes 5000

# Bad: Computing growth rate in Python
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # Hardcodes 0.15

# Bad: Python calculation for average
avg = sum(values) / len(values)
sheet['D20'] = avg  # Hardcodes 42.5
\`\`\`

### ✅ CORRECT - Using Excel Formulas
\`\`\`python
# Good: Let Excel calculate the sum
sheet['B10'] = '=SUM(B2:B9)'

# Good: Growth rate as Excel formula
sheet['C5'] = '=(C4-C2)/C2'

# Good: Average using Excel function
sheet['D20'] = '=AVERAGE(D2:D19)'
\`\`\`

This applies to ALL calculations - totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## Common Workflow
1. **Choose tool**: pandas for data, openpyxl for formulas/formatting
2. **Create/Load**: Create new workbook or load existing file
3. **Modify**: Add/edit data, formulas, and formatting
4. **Save**: Write to file
5. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: Use the scripts/recalc.py script
   \`\`\`bash
   python scripts/recalc.py output.xlsx
   \`\`\`
6. **Verify and fix any errors**: 
   - The script returns JSON with error details
   - If \`status\` is \`errors_found\`, check \`error_summary\` for specific error types and locations
   - Fix the identified errors and recalculate again
   - Common errors to fix:
     - \`#REF!\`: Invalid cell references
     - \`#DIV/0!\`: Division by zero
     - \`#VALUE!\`: Wrong data type in formula
     - \`#NAME?\`: Unrecognized formula name

### Creating new Excel files

\`\`\`python
# Using openpyxl for formulas and formatting
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

# Add data
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# Add formula
sheet['B2'] = '=SUM(A1:A10)'

# Formatting
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# Column width
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
\`\`\`

### Editing existing Excel files

\`\`\`python
# Using openpyxl to preserve formulas and formatting
from openpyxl import load_workbook

# Load existing file
wb = load_workbook('existing.xlsx')
sheet = wb.active  # or wb['SheetName'] for specific sheet

# Working with multiple sheets
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"Sheet: {sheet_name}")

# Modify cells
sheet['A1'] = 'New Value'
sheet.insert_rows(2)  # Insert row at position 2
sheet.delete_cols(3)  # Delete column 3

# Add new sheet
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = 'Data'

wb.save('modified.xlsx')
\`\`\`

## Recalculating formulas

Excel files created or modified by openpyxl contain formulas as strings but not calculated values. Use the provided \`scripts/recalc.py\` script to recalculate formulas:

\`\`\`bash
python scripts/recalc.py <excel_file> [timeout_seconds]
\`\`\`

Example:
\`\`\`bash
python scripts/recalc.py output.xlsx 30
\`\`\`

The script:
- Automatically sets up LibreOffice macro on first run
- Recalculates all formulas in all sheets
- Scans ALL cells for Excel errors (#REF!, #DIV/0!, etc.)
- Returns JSON with detailed error locations and counts
- Works on both Linux and macOS

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with \`pd.notna()\`
- [ ] **Far-right columns**: FY data often in columns 50+ 
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using \`/\` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.py Output
The script returns JSON with error details:
\`\`\`json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
\`\`\`

## Best Practices

### Library Selection
- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 refers to cell A1)
- Use \`data_only=True\` to read calculated values: \`load_workbook('file.xlsx', data_only=True)\`
- **Warning**: If opened with \`data_only=True\` and saved, formulas are replaced with values and permanently lost
- For large files: Use \`read_only=True\` for reading or \`write_only=True\` for writing
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values

### Working with pandas
- Specify data types to avoid inference issues: \`pd.read_excel('file.xlsx', dtype={'id': str})\`
- For large files, read specific columns: \`pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])\`
- Handle dates properly: \`pd.read_excel('file.xlsx', parse_dates=['date_column'])\`

## Code Style Guidelines
**IMPORTANT**: When generating Python code for Excel operations:
- Write minimal, concise Python code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections`,
    },
    {
        id: 'pdf',
        name: 'PDF Processing',
        command: 'anthropic-skills:pdf',
        description: 'Process PDF files — text extraction, form filling, merging, splitting, and content analysis.',
        category: 'Documents & Media',
        source: 'preset',
        tags: ['PDF', 'extraction', 'forms', 'processing'],
        instructions: `---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
license: Proprietary. LICENSE.txt has complete terms
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md. If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Quick Start

\`\`\`python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
\`\`\`

## Python Libraries

### pypdf - Basic Operations

#### Merge PDFs
\`\`\`python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
\`\`\`

#### Split PDF
\`\`\`python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
\`\`\`

#### Extract Metadata
\`\`\`python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}")
print(f"Author: {meta.author}")
print(f"Subject: {meta.subject}")
print(f"Creator: {meta.creator}")
\`\`\`

#### Rotate Pages
\`\`\`python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)  # Rotate 90 degrees clockwise
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
\`\`\`

### pdfplumber - Text and Table Extraction

#### Extract Text with Layout
\`\`\`python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
\`\`\`

#### Extract Tables
\`\`\`python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
\`\`\`

#### Advanced Table Extraction
\`\`\`python
import pandas as pd

with pdfplumber.open("document.pdf") as pdf:
    all_tables = []
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            if table:  # Check if table is not empty
                df = pd.DataFrame(table[1:], columns=table[0])
                all_tables.append(df)

# Combine all tables
if all_tables:
    combined_df = pd.concat(all_tables, ignore_index=True)
    combined_df.to_excel("extracted_tables.xlsx", index=False)
\`\`\`

### reportlab - Create PDFs

#### Basic PDF Creation
\`\`\`python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

# Add text
c.drawString(100, height - 100, "Hello World!")
c.drawString(100, height - 120, "This is a PDF created with reportlab")

# Add a line
c.line(100, height - 140, 400, height - 140)

# Save
c.save()
\`\`\`

#### Create PDF with Multiple Pages
\`\`\`python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

# Add content
title = Paragraph("Report Title", styles['Title'])
story.append(title)
story.append(Spacer(1, 12))

body = Paragraph("This is the body of the report. " * 20, styles['Normal'])
story.append(body)
story.append(PageBreak())

# Page 2
story.append(Paragraph("Page 2", styles['Heading1']))
story.append(Paragraph("Content for page 2", styles['Normal']))

# Build PDF
doc.build(story)
\`\`\`

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
\`\`\`python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
\`\`\`

For canvas-drawn text (not Paragraph objects), manually adjust font the size and position rather than using Unicode subscripts/superscripts.

## Command-Line Tools

### pdftotext (poppler-utils)
\`\`\`bash
# Extract text
pdftotext input.pdf output.txt

# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
\`\`\`

### qpdf
\`\`\`bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
\`\`\`

### pdftk (if available)
\`\`\`bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
\`\`\`

## Common Tasks

### Extract Text from Scanned PDFs
\`\`\`python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

# Convert PDF to images
images = convert_from_path('scanned.pdf')

# OCR each page
text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\\n"
    text += pytesseract.image_to_string(image)
    text += "\\n\\n"

print(text)
\`\`\`

### Add Watermark
\`\`\`python
from pypdf import PdfReader, PdfWriter

# Create watermark (or load existing)
watermark = PdfReader("watermark.pdf").pages[0]

# Apply to all pages
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
\`\`\`

### Extract Images
\`\`\`bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
\`\`\`

### Password Protection
\`\`\`python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

# Add password
writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
\`\`\`

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | pypdf | \`writer.add_page(page)\` |
| Split PDFs | pypdf | One page per file |
| Extract text | pdfplumber | \`page.extract_text()\` |
| Extract tables | pdfplumber | \`page.extract_tables()\` |
| Create PDFs | reportlab | Canvas or Platypus |
| Command line merge | qpdf | \`qpdf --empty --pages ...\` |
| OCR scanned PDFs | pytesseract | Convert to image first |
| Fill PDF forms | pdf-lib or pypdf (see FORMS.md) | See FORMS.md |

## Next Steps

- For advanced pypdfium2 usage, see REFERENCE.md
- For JavaScript libraries (pdf-lib), see REFERENCE.md
- If you need to fill out a PDF form, follow the instructions in FORMS.md
- For troubleshooting guides, see REFERENCE.md
`,
    },
    {
        id: 'pptx',
        name: 'PowerPoint',
        command: 'anthropic-skills:pptx',
        description: 'Create or process PowerPoint (.pptx) presentations — slide design, content structuring, template application, and export.',
        category: 'Documents & Media',
        source: 'preset',
        tags: ['pptx', 'PowerPoint', 'presentation', 'slides'],
        instructions: `---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \\"deck,\\" \\"slides,\\" \\"presentation,\\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX Skill

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | \`python -m markitdown presentation.pptx\` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |

---

## Reading Content

\`\`\`bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
\`\`\`

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with \`thumbnail.py\`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.**

Use when no template or reference presentation is available.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | \`1E2761\` (navy) | \`CADCFC\` (ice blue) | \`FFFFFF\` (white) |
| **Forest & Moss** | \`2C5F2D\` (forest) | \`97BC62\` (moss) | \`F5F5F5\` (cream) |
| **Coral Energy** | \`F96167\` (coral) | \`F9E795\` (gold) | \`2F3C7E\` (navy) |
| **Warm Terracotta** | \`B85042\` (terracotta) | \`E7E8D1\` (sand) | \`A7BEAE\` (sage) |
| **Ocean Gradient** | \`065A82\` (deep blue) | \`1C7293\` (teal) | \`21295C\` (midnight) |
| **Charcoal Minimal** | \`36454F\` (charcoal) | \`F2F2F2\` (off-white) | \`212121\` (black) |
| **Teal Trust** | \`028090\` (teal) | \`00A896\` (seafoam) | \`02C39A\` (mint) |
| **Berry & Cream** | \`6D2E46\` (berry) | \`A26769\` (dusty rose) | \`ECE2D0\` (cream) |
| **Sage Calm** | \`84B59F\` (sage) | \`69A297\` (eucalyptus) | \`50808E\` (slate) |
| **Cherry Bold** | \`990011\` (cherry) | \`FCF6F5\` (off-white) | \`2F3C7E\` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set \`margin: 0\` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

\`\`\`bash
python -m markitdown output.pptx
\`\`\`

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

\`\`\`bash
python -m markitdown output.pptx | grep -iE "\\bx{3,}\\b|lorem|ipsum|\\bTODO|\\[insert|this.*(page|slide).*layout"
\`\`\`

If grep returns results, fix them before declaring success.

### Visual QA

**⚠️ USE SUBAGENTS** — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

\`\`\`
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images — run \`ls -1 "\$PWD"/slide-*.jpg\` and use the exact absolute paths it prints:
1. <absolute-path>/slide-N.jpg — (Expected: [brief description])
2. <absolute-path>/slide-N.jpg — (Expected: [brief description])
...

Report ALL issues found, including minor ones.
\`\`\`

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Converting to Images

Convert presentations to individual slide images for visual inspection:

\`\`\`bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
rm -f slide-*.jpg
pdftoppm -jpeg -r 150 output.pdf slide
ls -1 "\$PWD"/slide-*.jpg
\`\`\`

**Pass the absolute paths printed above directly to the view tool.** The \`rm\` clears stale images from prior runs. \`pdftoppm\` zero-pads based on page count: \`slide-1.jpg\` for decks under 10 pages, \`slide-01.jpg\` for 10-99, \`slide-001.jpg\` for 100+.

**After fixes, rerun all four commands above** — the PDF must be regenerated from the edited \`.pptx\` before \`pdftoppm\` can reflect your changes.

---

## Dependencies

- \`pip install "markitdown[pptx]"\` - text extraction
- \`pip install Pillow\` - thumbnail grids
- \`npm install -g pptxgenjs\` - creating from scratch
- LibreOffice (\`soffice\`) - PDF conversion (auto-configured for sandboxed environments via \`scripts/office/soffice.py\`)
- Poppler (\`pdftoppm\`) - PDF to images
`,
    },
    {
        id: 'evernote-pdf-processor',
        name: 'Evernote PDF Processor',
        command: 'anthropic-skills:evernote-pdf-processor',
        description: 'Automates processing of multiple PDFs from Evernote — batch extraction, categorisation, and structured data output.',
        category: 'Documents & Media',
        source: 'custom',
        tags: ['Evernote', 'PDF', 'batch', 'extraction'],
        instructions: `---
name: evernote-pdf-processor
description: Automates processing of multi-document PDFs from Evernote "posts actions" notebook. It splits a single PDF into separate documents and creates individual task records in the Airtable "Tasks" table, specifically configured for the "Inbound Comms" interface.
---

# Evernote PDF Processor (Airtable Integration)

This skill automates the workflow of handling scanned or bulk PDF uploads. It identifies separate documents within a single PDF from Evernote, splits them, and creates individual task records in the Airtable "Tasks" table.

## Workflow Overview

1.  **Trigger**: A new note is added to the **"posts actions"** notebook in Evernote.
2.  **Extraction**: Download the PDF attachment from the Evernote note.
3.  **Processing**: Use \`scripts/split_pdf.py\` to analyze and split the PDF into separate documents based on content analysis.
4.  **Airtable Action**: For each split document, create a record in the **Tasks** table with the following configuration:
    *   **Task Name**: A descriptive title generated from the PDF content (e.g., "Invoice - COMPANY NAME (Date)").
    *   **Attachments**: The split PDF file.
    *   **Source**: Set to **"Post"**.
    *   **Inbound Communication Task**: Checkbox ticked (to ensure it appears in the Inbound Comms interface).

## Implementation Details

### PDF Splitting Heuristics
The splitting logic identifies document boundaries by searching for common letterheads, greetings (e.g., "Dear", "To:"), and document headers (e.g., "Invoice", "Notice").

### Airtable Configuration
- **Base**: ⚙️ Operations Director (appnqjDpqDniH3IRl)
- **Table**: Tasks (tblqB8b22hKBL4PF1)
- **Key Fields**:
    - \`Task Name\` (fldgFjGBw6bTKJFCD)
    - \`Attachments\` (fldEbs9cscRr8elcw)
    - \`Source\` (fldMWDXsbAr4oM9hz): Select "Post"
    - \`Inbound Communication Task\` (fldueazD67F7fUGee): Set to true

## Usage Guide

When asked to "process Evernote posts" or "split the PDF into Airtable", follow these steps:

1.  **Locate Evernote Note**: Find the note in the "posts actions" notebook.
2.  **Split PDF**: Run \`python3 scripts/split_pdf.py --input <path> --output-dir <dir>\`.
3.  **Upload to Airtable**: For each split file:
    - Upload the file to S3 using \`manus-upload-file\` to get a public URL.
    - Call the Airtable \`create_records\` tool to add the task to the **Tasks** table with the configuration specified above.

### Example Airtable Record Payload
\`\`\`json
{
  "fields": {
    "Task Name": "Invoice - ABC Corp (11/02/2026)",
    "Attachments": [{"url": "https://s3-url-to-pdf.pdf"}],
    "Source": "Post",
    "Inbound Communication Task": true
  }
}
\`\`\`
`,
    },
    {
        id: 'video-generator',
        name: 'Video Generator',
        command: 'anthropic-skills:video-generator',
        description: 'Professional AI video production — script writing, scene planning, voiceover generation, and video assembly.',
        category: 'Documents & Media',
        source: 'preset',
        tags: ['video', 'production', 'script', 'media'],
        instructions: `---
name: video-generator
description: Professional AI video production workflow. Use when creating videos, short films, commercials, or any video content using AI generation tools.
---

# Video Generation

## Workflow Overview

1. **Phase 1: Initial** → Gather requirements, STOP for user confirmation
2. **Phase 2: Global Definitions** → Define style, characters, voices, BGM (text only, no images)
3. **Phase 3: Clip Planning** → Segment into clips, plan each clip, determine reference image needs
4. **Phase 4: Reference Images** → Generate reference images (MANDATORY before Phase 5)
5. **Phase 5: Execution** → Generate keyframes, videos, audio

---

## Critical Rules (MUST Follow)

Before starting, memorize these non-negotiable rules:

1. **[PHASE 1 STOP]** MUST ask questions to gather information. DO NOT assume or guess missing details—always ask the user. Never proceed without explicit user confirmation.

2. **[DETAILED VIDEO PROMPT]** Video prompts must include detailed transition_description (2-4 sentences). One-line prompts are insufficient.

3. **[KEYFRAME DIFFERENCE]** Last keyframe must show interpolatable change from first keyframe: subject position/pose, subject state (open/close, appear/disappear), or composition change. Subtle-only changes (lighting, background) while subject stays static cause unnatural video motion.

4. **[PHASE 4 MANDATORY]** MUST generate reference images before keyframes. Never skip Phase 4.

5. **[ASPECT RATIO]** ALL keyframes must use 16:9 or 9:16, and must be upright (not rotated). Never generate 1:1 or other ratios.

6. **[NO TTS FOR ON-SCREEN]** Never use TTS for on-screen dialogue or singing. Video model generates audio with lip sync.

7. **[NARRATION CLIP BY CLIP]** Generate off-screen narration separately for each clip, not all at once.

8. **[AUDIO MIXING]** When combining audio tracks (video audio, narration, BGM), preserve ALL tracks—overlay, never replace. Narration must be clearly audible and maintain consistent volume across all clips.

---

## Image Generation Tools

| Tool | Use When |
|------|----------|
| \`generate_image\` | Create new images (with or without references) |
| \`generate_image_variation\` | Edit existing images |

---

## Phase 1: Initial

### Gather Information

| Field | Description |
|-------|-------------|
| Purpose | Goal and target audience |
| Narrative arc | Story structure and key points |
| Duration | Total length in seconds |
| Aspect ratio | 16:9 or 9:16 only |
| Visual style | Sub-genre aesthetic (e.g., "Makoto Shinkai anime", "Pixar 3D") |
| Reference materials | Reference videos, images, brand guidelines |
| Language | For dialogue and narration |
| Recurring elements | Characters/objects with appearance descriptions |
| Dialogue/singing needs | On-screen character audio |
| Narration needs | Off-screen narrator (gender, tone, pace) |


### Five-Dimension Expert Framework

Use these perspectives to guide your questions:

| Dimension | Expert Role | Key Questions |
|-----------|-------------|---------------|
| **Strategy & Audience** | Creative Director | Who is this for? What's the goal? What action should viewers take? |
| **Narrative & Structure** | Screenwriter | What's the story? Key moments? Emotional arc? |
| **Visual Style** | Director + Art Director | What look and feel? Reference videos/images? Color mood? |
| **Shot Execution** | Cinematographer | Any specific shots in mind? Product hero shots needed? |
| **Sound Design** | Sound Designer | Voiceover? Music mood? Dialogue? Sound effects? |

Ask questions across all dimensions. Prioritize based on user's initial description.

> **[MANDATORY STOP - DO NOT PROCEED WITHOUT USER CONFIRMATION]**
> Summarize gathered information and wait for user confirmation before Phase 2.

---

## Phase 2: Global Definitions (Text Only)

### Visual Style Specification

Define these 4 dimensions (applied to primary reference images in Phase 4):

| Dimension | Example Values |
|-----------|----------------|
| **Sub-genre** | Makoto Shinkai anime, Pixar 3D, cyberpunk noir |
| **Rendering + Line** | 2D hand-drawn with thick outlines, 3D cel-shading |
| **Color + Lighting** | High saturation neon, soft diffused natural light |
| **Detail density** | Minimalist, highly detailed backgrounds |

**Example specification:**

\`\`\`
Sub-genre: Cyberpunk anime
Rendering + Line: 2D digital painting, thin glowing outlines
Color + Lighting: High saturation neon (pink, cyan, purple), dark backgrounds, rim lighting
Detail density: Highly detailed backgrounds, moderate character detail
\`\`\`

### Recurring Elements

For each character/object:

| Field | Description |
|-------|-------------|
| unique_identifier | Name for reference |
| appearance | Text description for prompts |
| outfit_description | Clothing/accessories (characters) |
| language | Spoken/sung language (if applicable) |
| mechanical_properties | Physical behavior (if applicable) |

### Voice Profiles

- **On-screen**: From character definitions (dialogue/singing)
- **Off-screen narrator**: name, gender, tone, pace, language

### BGM Source Decision

| Scenario | BGM Source |
|----------|------------|
| Music video / diegetic music (visible source) | **Embedded** (in video prompt) |
| Background mood music | **Separate** (Phase 5 BGM Preparation) |
| No music | **None** |

**If Separate**, define: genre, instruments, tempo

---

## Phase 3: Clip Planning

### Segmentation Rules

- Clips: **4, 6, or 8 seconds only**
- Each clip: **one action, one scene**

### Per-Clip Specification

| Field | Values |
|-------|--------|
| **narrative_purpose** | establish / develop / climax / resolve / transition / supplementary (product shot, detail, reaction, insert, B-roll, POV) |
| **pacing** | slow / moderate / fast |
| **scene** | Environment description |
| **content_action** | Subject + action + trajectory |
| **transition_description** | **[REQUIRED]** Detailed transition process. Must include: subject appearance, movement trajectory, state changes, existence statements. 2-4 sentences minimum. |
| **duration** | 4 / 6 / 8 |
| **camera_movement** | static / pan / tilt / dolly / zoom / crane / arc / handheld |
| **first_keyframe_framing** | Shot size + angle + composition |
| **first_keyframe_visible_content** | What's visible |
| **last_keyframe_framing** | Shot size + angle + composition |
| **last_keyframe_visible_content** | What's visible |
| **last_keyframe_edit_from_first** | yes / no (see decision table below) |
| **inter_clip_boundary** | continuous / scene_cut |
| **first_keyframe_reuse** | yes / no |
| **last_keyframe_required** | yes / no |
| **on_screen_dialogue** | "Name: text" or "Name: [lyrics] (style)" or None |
| **sound_effects** | Sources or None |
| **bgm_source** | embedded / separate / none |
| **bgm_cue** | If embedded: style, BPM, instruments. If separate: emotion, intensity |
| **narration_cue** | Narrator text or None |

### Field Dependencies

- \`inter_clip_boundary = continuous\` → next clip's \`first_keyframe_reuse = yes\`
- \`first_keyframe_reuse = yes\` → previous clip must have \`last_keyframe_required = yes\`

### Keyframe Difference Requirement

When planning \`last_keyframe_visible_content\`, ensure interpolatable change from \`first_keyframe_visible_content\`:
- Subject position/pose change (movement, rotation, action)
- Subject state change (open/close, appear/disappear, expression)
- Composition change from camera movement (zoom, pan result)

> **[WARNING]** Avoid last keyframes with only lighting or background changes while subject remains static—this causes unnatural video motion.

### Decision: last_keyframe_edit_from_first

| Camera Movement | First & Last Keyframe Overlap? | Set to |
|-----------------|-------------------------------|--------|
| static, small pan/tilt, zoom | Yes (same scene area) | \`yes\` |
| large pan, dolly, tracking, crane, arc | No (different area) | \`no\` |

### transition_description Requirements

This field directly becomes part of the video prompt. **The more detailed, the better.**

**Must include:**
1. **Subject appearance**: Key visual features that must remain consistent throughout
2. **Movement trajectory**: How subject/camera moves through space and time
3. **State changes**: How objects/environment change over the duration
4. **Existence statements**: What is present throughout (prevents pop-in/pop-out)

**Length guideline:** 2-4 sentences minimum. One-line descriptions are insufficient.

### transition_description Examples

| Insufficient | Sufficient |
|--------------|------------|
| "Open box revealing jar" | "The frosted glass jar with gold lid is inside the box from the start, hidden by the closed cream-colored lid. Elegant hands with manicured nails lift the lid upward smoothly. As the lid rises, the jar gradually comes into view - first the gold cap edge, then the full jar nestled in champagne velvet." |
| "Person walks left to right" | "Woman in white dress with brown hair starts at left edge of frame, walks steadily rightward at moderate pace, maintaining upright posture, reaches right edge by end of clip." |
| "Light turns on" | "Room starts in complete darkness. Light gradually increases from the ceiling fixture at center, warm yellow glow spreading outward across the wooden furniture until fully illuminated." |

### Physical Consistency Check

| Movement | Constraint |
|----------|------------|
| Pan/Tilt/Zoom | Camera fixed, content within rotational/zoom range |
| Dolly/Tracking/Crane | Content physically traversable within duration |
| Arc | Subject centered in both keyframes, environment allows orbit |
| Handheld | Similar to Dolly but allows irregularity |
| Combined | Must satisfy ALL involved movement constraints |

**Common Mistakes:**

| Mistake | Correction |
|---------|------------|
| "Pan from corridor entrance to middle" | Use "dolly forward" |
| First: room A, Last: room B | Split into two clips |
| 6-second clip covering 100 meters | Extend duration or reduce distance |

### [MANDATORY] Reference Image Requirements

After all clips planned, list required reference images:

| Element | Clips Using It | Required Images |
|---------|----------------|-----------------|
| (name) | Clip X (MS), Clip Y (CU) | Full body, Face close-up |

> **[WARNING]** Only generate what clips actually need. Do NOT generate all angles by default.

---

## [MANDATORY] Phase 4: Reference Image Generation

**MANDATORY. Do not skip to Phase 5.**

### Generation Order

**Step 1: Primary reference (visual anchor)**
- Tool: \`generate_image\` (no references)
- Prompt MUST include: **Full Visual Style Specification** from Phase 2 + element description
- White background
- Ends with "no text, no watermarks, no logos, no labels, no annotations"

**Step 2: Additional angles/shots**
- Tool: \`generate_image\` with **primary reference as reference**
- Prompt: New angle/shot only (style inherited from reference)
- White background
- Ends with "no text, no watermarks, no logos, no labels, no annotations"

> **[WARNING]** Never generate additional refs without using primary ref as reference.

---

## Phase 5: Execution

### Global Rules

> **[CRITICAL]** ALL keyframes: aspect ratio from Phase 1 (16:9 or 9:16). Never 1:1.

### First Keyframe

\`\`\`
first_keyframe_reuse = yes → Use previous clip's last keyframe (no generation)
first_keyframe_reuse = no  → Generate new keyframe
\`\`\`

**If generating first keyframe:**
- [ ] Tool: \`generate_image\`
- [ ] References: Appropriate Phase 4 images
- [ ] Aspect ratio: 16:9 or 9:16
- [ ] Prompt includes:
  - [ ] Visual style (sub-genre + key characteristics, brief)
  - [ ] Scene environment
  - [ ] Framing (shot size + angle + lens)
  - [ ] Visible content
  - [ ] Subject appearance + outfit
- [ ] Prompt ends with: "no text, no watermarks, no logos, no annotations"

### Last Keyframe

\`\`\`
last_keyframe_required = no  → Skip
last_keyframe_required = yes:
  last_keyframe_edit_from_first = yes → Edit mode
  last_keyframe_edit_from_first = no  → Generate mode
\`\`\`

**If EDIT mode:**
- [ ] Tool: \`generate_image_variation\`
- [ ] References: [first_keyframe, Phase 4 refs...]
- [ ] Prompt: "Edit this image: [changes only]"
- [ ] Do NOT repeat unchanged elements

**If GENERATE mode:**
- [ ] Tool: \`generate_image\`
- [ ] References: [first_keyframe (scene ref), Phase 4 refs...]
- [ ] Aspect ratio: 16:9 or 9:16
- [ ] Prompt includes:
  - [ ] Visual style (brief)
  - [ ] Last keyframe framing + visible content
  - [ ] Subject appearance and end state
  - [ ] "Same location/environment as reference"
- [ ] Prompt ends with: "no text, no watermarks, no logos, no annotations"

### Consistency Checklist (Easily Overlooked)

When generating last keyframe, verify:
- [ ] **Interpolatable change**: Clear difference in subject position/pose, state, or composition (not just lighting/background)
- [ ] Same lighting direction and shadows as first keyframe
- [ ] Same color temperature (warm/cool)
- [ ] Same depth of field
- [ ] Same outfit, facial features, body proportions
- [ ] Environment details consistent

### Video Generation

**Video prompt should be detailed.** Even with keyframes, video models may drift during generation.

**Prompt includes:**
- [ ] Visual style (brief)
- [ ] Pacing (slow / moderate / fast)
- [ ] **transition_description** from Phase 3 (detailed, 2-4 sentences)
- [ ] **Subject appearance** (key features for consistency)
- [ ] **Scene environment** (brief)
- [ ] Audio (see below)

**Audio in prompt:**

| Type | Include |
|------|---------|
| On-screen dialogue | "Name says: text" with tone, language |
| On-screen singing | "Name sings: [lyrics]" with style, language |
| Sound effects | Source + quality |
| Embedded BGM | Style, BPM, instruments, mood |

**Prompt ending by bgm_source:**
- embedded → (no ending, music described in prompt body)
- separate/none → End with "No background music."

**Example (music video with embedded BGM):**
\`\`\`
Hatsune Miku center stage, singing in Japanese with sweet electronic voice: 
"ラララ、光の中で踊り出す", energetic J-pop at 140 BPM with synthesizer, 
crowd cheering, concert atmosphere
\`\`\`

> **[CRITICAL]** Never use TTS for on-screen dialogue/singing. Video model generates audio with lip sync.

### BGM Sourcing (if bgm_source = separate)

**Method:** Search and download from royalty-free music libraries (e.g., Pixabay, YouTube Audio Library).

**[CRITICAL]** Generating music with Python or any other tools is strictly prohibited. You must only use pre-existing, royalty-free tracks.

Match the downloaded music to the style defined in Phase 2.

### Narration Generation (if narration exists)

> **[WARNING]** Generate **clip by clip**, not all at once.

- TTS for off-screen narrator only
- Same voice profile across all clips
- Verify audio duration fits clip duration

### Audio Summary

| Type | Method | Output |
|------|--------|--------|
| On-screen dialogue/singing | Video model | Embedded |
| Sound effects | Video model | Embedded |
| Embedded BGM | Video model | Embedded |
| Separate BGM | Search only | Separate track |
| Narration | TTS (clip by clip) | Separate track |

### Audio Mixing (Final Assembly)

When combining multiple audio sources:

| Track | Source |
|-------|--------|
| Video audio | Embedded in video clips (dialogue, sound effects, embedded BGM) |
| Narration | TTS generated (off-screen narrator) |
| Separate BGM | Searched from royalty-free source |

**[CRITICAL]** Mixing rules:
- Preserve ALL audio tracks—overlay, never replace one with another
- Narration must be clearly audible—not drowned out by other tracks
- Narration volume must be consistent across all clips
`,
    },
    {
        id: 'similarweb-analytics',
        name: 'SimilarWeb Analytics',
        command: 'anthropic-skills:similarweb-analytics',
        description: 'Analyse websites and domains using SimilarWeb data — traffic estimates, audience demographics, competitor benchmarking, and market positioning.',
        category: 'Documents & Media',
        source: 'preset',
        tags: ['analytics', 'traffic', 'competitor', 'web'],
        instructions: `---
name: similarweb-analytics
description: "Analyze websites and domains using SimilarWeb traffic data. Get traffic metrics, engagement stats, global rankings, traffic sources, and geographic distribution for comprehensive website research."
---

# SimilarWeb Analytics

Comprehensive website and domain analysis using SimilarWeb traffic data.

## Core Capabilities

- **Traffic Analysis**: Total visits, unique visitors, traffic trends
- **Engagement Metrics**: Bounce rate, pages per visit, average visit duration
- **Global Ranking**: Website ranking over time
- **Traffic Sources**: Marketing channels (desktop and mobile)
- **Geographic Distribution**: Traffic breakdown by country

## API Usage

All APIs use \`ApiClient\` from \`/opt/.manus/.sandbox-runtime\`. Common parameters:
- \`domain\`: Website domain (e.g., "google.com")
- \`start_date\`: Start date (YYYY-MM). Max 12 months ago
- \`end_date\`: End date (YYYY-MM). Max 12 months ago, default is 1 month ago (most recent complete month)
- \`main_domain_only\`: Exclude subdomains if True (default: False)

**Default time ranges vary by API:**
- Global Rank, Visits Total, Unique Visit, Bounce Rate: default **6 months**
- Traffic Sources (Desktop/Mobile), Traffic by Country: default **3 months**

### Get Global Rank

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_global_rank', path_params={'domain': 'amazon.com'})
\`\`\`

### Get Website Visits Total

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_visits_total',
    path_params={'domain': 'amazon.com'},
    query={'country': 'world', 'granularity': 'monthly', 'start_date': '2025-07', 'end_date': '2025-12'})
\`\`\`

### Get Unique Visit

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_unique_visit',
    path_params={'domain': 'amazon.com'},
    query={'start_date': '2025-07', 'end_date': '2025-12'})
\`\`\`

### Get Bounce Rate

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_bounce_rate',
    path_params={'domain': 'amazon.com'},
    query={'country': 'world', 'granularity': 'monthly', 'start_date': '2025-07', 'end_date': '2025-12'})
\`\`\`

### Get Traffic Sources - Desktop

Returns breakdown by channel: Organic Search, Paid Search, Direct, Display Ads, Email, Referrals, Social Media.

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_traffic_sources_desktop',
    path_params={'domain': 'amazon.com'},
    query={'country': 'world', 'granularity': 'monthly', 'start_date': '2025-07', 'end_date': '2025-12'})
\`\`\`

### Get Traffic Sources - Mobile

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_traffic_sources_mobile',
    path_params={'domain': 'amazon.com'},
    query={'country': 'world', 'granularity': 'monthly', 'start_date': '2025-07', 'end_date': '2025-12'})
\`\`\`

### Get Total Traffic by Country

Returns traffic share, visits, pages per visit, average time, bounce rate and rank by country.

- \`limit\`: Number of countries to return (default: 1, max: 10)
- **Date range limit**: max 3 months (unlike other APIs)

\`\`\`python
import sys
sys.path.append('/opt/.manus/.sandbox-runtime')
from data_api import ApiClient

client = ApiClient()
result = client.call_api('SimilarWeb/get_total_traffic_by_country',
    path_params={'domain': 'amazon.com'},
    query={'start_date': '2025-10', 'end_date': '2025-12', 'limit': '10'})
\`\`\`

## When to Use

Invoke APIs when users mention:
- Domain names: "google.com", "amazon.com"
- Traffic queries: "traffic", "visits", "visitors"
- Ranking queries: "rank", "ranking", "how popular"
- Engagement queries: "bounce rate", "engagement"
- Source queries: "traffic sources", "marketing channels"
- Geographic queries: "countries", "geographic"
- Comparison queries: "compare", "vs"

## Data Limitations

- Historical data: max 12 months
- Geography: worldwide only
- Granularity: monthly only
- Latest data: last complete month

## Important: Save Data to Files

API calls may fail mid-execution due to credit depletion. **Always save all retrieved data to files immediately** to avoid data loss and prevent redundant API calls.
`,
    },

    // ── Automation & Scheduled ───────────────────────────────────────
    {
        id: 'inbound-comms-create-tasks',
        name: 'Inbound Comms Task Creator',
        command: 'scheduled:inbound-comms-create-airtable-tasks',
        description: 'Checks Gmail "8: Task created" label and auto-creates Airtable task records for new emails — runs on schedule.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['gmail', 'tasks', 'automation', 'inbound']
    },
    {
        id: 'inbound-comms-complete-tasks',
        name: 'Inbound Comms Task Completer',
        command: 'scheduled:inbound-comms-complete-tasks',
        description: 'Monitors Airtable for completed inbound comm tasks and moves the Gmail emails to "9: Task completed" label.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['gmail', 'tasks', 'completion', 'automation']
    },
    {
        id: 'drift-monitor',
        name: 'Drift Monitor',
        command: 'scheduled:drift-monitor',
        description: 'Nightly drift monitor — validates Airtable schema, codebase field references, SOP accuracy, dashboard health, and auto-fixes or escalates findings.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['monitoring', 'drift', 'schema', 'validation']
    },
    {
        id: 'sop-update-processor',
        name: 'SOP Update Processor',
        command: 'scheduled:sop-update-processor',
        description: 'Processes pending SOP update requests — reads live source code, regenerates accurate SOP HTML, and commits the updated files.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['SOP', 'documentation', 'generation', 'automation']
    },
    {
        id: 'uc-check-slack-notifier',
        name: 'UC Check Slack Notifier',
        command: 'scheduled:uc-check-slack-notifier',
        description: 'Sends a Slack DM to Mica when new UC Check tasks are created from the Leadership Dashboard — ensures timely follow-up.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['Slack', 'notification', 'UC check', 'automation']
    },
    {
        id: 'schedule-skill',
        name: 'Schedule',
        command: 'anthropic-skills:schedule',
        description: 'Create a scheduled task that runs on a cron schedule — configure timing, target skill, and parameters for recurring automated work.',
        category: 'Automation',
        source: 'preset',
        tags: ['schedule', 'cron', 'automation', 'recurring'],
        instructions: `---
name: schedule
description: "Create or update a scheduled task that runs automatically. Use when the user says things like "every day", "each morning", "remind me in an hour", "run this at noon", or wants to reschedule an existing task."
---

First, decide whether the user wants to **create a new** scheduled task or **change an existing** one.

## Updating an existing task

If the user wants to reschedule, edit the prompt, or pause/resume a task that already exists, call the \`update_scheduled_task\` tool with its \`taskId\` — do **not** call \`create_scheduled_task\`. Use \`list_scheduled_tasks\` if you need to look up the ID. When this session is itself a scheduled run, the current task's ID is the \`name\` attribute in the \`<scheduled-task name="…">\` tag at the top of the conversation.

## Creating a new task

You are distilling the current session into a reusable shortcut. Follow these steps:

### 1. Analyze the session

Review the session history to identify the core task the user performed or requested. Distill it into a single, repeatable objective.

### 2. Draft a prompt

The prompt will be used for future autonomous runs — it must be entirely self-contained. Future runs will NOT have access to this session, so never reference "the current conversation," "the above," or any ephemeral context.

Include in the description:
- A clear objective statement (what to accomplish)
- Specific steps to execute
- Any relevant file paths, URLs, repositories, or tool names
- Expected output or success criteria
- Any constraints or preferences the user expressed

Write the description in second-person imperative ("Check the inbox…", "Run the test suite…"). Keep it concise but complete enough that another Claude session could execute it cold.

### 3. Choose a taskName

Pick a short, descriptive name in kebab-case (e.g. "daily-inbox-summary", "weekly-dep-audit", "format-pr-description").

### 4. Determine scheduling

The \`create_scheduled_task\` tool description explains the options (\`cronExpression\` for recurring, \`fireAt\` for one-time, omit both for ad-hoc) and their formats. If the user didn't give a clear schedule, propose one and ask them to confirm before proceeding.

Finally, call the \`create_scheduled_task\` tool.`,
    },

    // ── Development & System ─────────────────────────────────────────
    {
        id: 'build-feature',
        name: 'Build Feature',
        command: 'build-feature',
        description: 'End-to-end workflow for building or extending a feature on the Operations Director Platform. Front-loads requirements, planning, and verification into a single structured pass to eliminate rework.',
        category: 'Development',
        source: 'project',
        tags: ['build', 'feature', 'development', 'workflow'],
        instructions: `---
name: build-feature
description: End-to-end workflow for building or extending a feature on the Operations Director Platform. Reduces iteration loops by front-loading requirements, planning, and verification into a single structured pass. Use this whenever Kevin asks to build something new, add a tab, extend an existing feature, create a new page, or do any non-trivial implementation work on the dashboard. Also use when Kevin says "build", "create", "add", "implement", "wire up", or describes a feature he wants.
---

# Build Feature — Zero-Rework Workflow

A structured build process that front-loads every decision and check so features ship right on the first pass. Kevin provides conversational input. Claude restructures it, plans it, builds it, tests it, and deploys it. One command, fully working result.

## Why this workflow exists

Building features iteratively — code a bit, show Kevin, fix, repeat — burns tokens and time. Most rework comes from:
1. **Vague requirements** from conversational input (no clear deliverable or constraints)
2. **Missing requirements** discovered mid-build (field names, business rules, edge cases)
3. **Forgetting platform conventions** (tokens.css, health bar, sidebar wiring, config.js entries)
4. **Not testing thoroughly** before declaring done (stale cache, empty states, mobile layout)
5. **Self-introduced bugs** from the fix itself (badge mismatches, filter logic, double-submit)
6. **Skipping the quality pipeline** (no simplify pass, no test coverage check, no pre-deploy checklist)

This workflow eliminates those by making every step explicit.

---

## Phase 0: BILD PROMPT (restructure Kevin's input)

Kevin talks conversationally. Before doing anything else, restructure his input into a precise BILD prompt. This eliminates the #1 source of rework: misunderstanding what to build.

### 0a. Parse what Kevin gave you

Map every piece of information to one of four sections:
- **B (Background):** role, domain, current state, what exists already
- **I (Instruction):** the actual task, stated as a direct command
- **L (Limitations):** constraints, files not to touch, tone/audience, scope boundaries
- **D (Deliverable):** what "done" looks like, format, success criteria

Note which sections are thin or empty.

### 0b. Fill gaps from available context

Before asking Kevin questions, check what you can answer yourself:
- Read CLAUDE.md for conventions, file architecture, design tokens
- Read \`js/config.js\` for existing field maps and table IDs
- Check memory files for project state and preferences
- Look at git history for recent changes and patterns
- Read the most similar existing feature's code

### 0c. Ask targeted questions (maximum one round)

Use AskUserQuestion to fill remaining gaps. Batch into a single call (max 4 questions). Only ask where the answer materially changes the output.

**If Background is thin:** What exists already? What prompted this?
**If Instruction is ambiguous:** What is the single most important outcome?
**If Limitations are missing:** What must not change? Any scope boundaries?
**If Deliverable is vague:** What format? How will you judge whether this is done?

Skip questions you can answer from context. One round maximum. Work with what you have.

### 0d. Present the BILD prompt

Format:

\`\`\`
## B — Background
[Context. 2-5 sentences.]

## I — Instruction
[The task. 1-2 sentences, imperative voice. Priority stated if multi-part.]

## L — Limitations
- [Constraint 1]
- [Constraint 2]

## D — Deliverable
- [Output with success criteria]
- [How to verify it works]
\`\`\`

Ask: "Should I build this as-is, or adjust anything?"

On approval, the BILD prompt becomes the instruction set for the rest of this workflow. Proceed to Phase 1.

---

## Phase 1: CAPTURE (do not write any code yet)

Before touching a single file, build a complete picture. Ask Kevin targeted questions — but batch them into one message, not a drip-feed of follow-ups.

### 1a. Understand the feature

Extract from Kevin's request (or ask if missing):

- **What it does** — the core user action and outcome
- **Where it lives** — new tab, existing tab extension, new iframe page, or OS page
- **Data source** — which Airtable table(s), which fields, any new fields needed
- **Business rules** — filtering logic, status transitions, edge cases, thresholds
- **Who uses it** — Kevin only, or delegated staff too (affects complexity)

### 1b. Get the "done" picture

Kevin often describes what the finished result looks like. Capture:

- **Layout** — cards, table, kanban, dashboard grid, or something else
- **Key metrics/counts** — what numbers appear, how are they calculated
- **Actions** — what buttons exist, what do they do (Airtable write-back? status change? navigation?)
- **Empty state** — what shows when there's no data
- **Interactions** — expand/collapse, filters, search, modals, drawers

### 1c. Identify constraints early

- **File scope** — which file(s) will this touch? (check CLAUDE.md's file table)
- **Shared dependencies** — does this need new entries in \`config.js\`, \`shared.js\`, or \`index.html\`?
- **Existing patterns** — is there a similar feature already built that this should mirror?
- **Airtable field names** — get EXACT field names (including capitalisation and spaces). Read \`js/config.js\` for existing field maps. If new fields are needed, confirm them before coding.

### 1d. Confirm the plan in one message

Present a short summary back to Kevin:

\`\`\`
Building: [feature name]
Location: [tab ID / page path]
Files to edit: [list]
Data: [table(s)] → [key fields]
Layout: [description]
Actions: [list]
Health checks: [what sync bar will verify]
\`\`\`

Wait for Kevin's "yes" or corrections before proceeding. This single confirmation replaces 3-4 mid-build check-ins.

---

## Phase 2: PLAN (still no code)

### 2a. Read existing code first

Before writing anything, read the files you'll modify end-to-end:
- The target JS file (understand current structure, function names, globals used)
- \`js/config.js\` (existing field maps, table IDs, page registry)
- \`index.html\` (sidebar structure, tab panel containers — especially OS-INTEGRATION sections)
- The most similar existing feature's JS file (copy proven patterns, not reinvent)

### 2b. Map out every code change

List every change needed, grouped by file:

\`\`\`
index.html:
  - Sidebar menu item (with health dot)
  - Tab panel container (with data-sync-bar div)

js/config.js:
  - Field constants (F.xxx or new field map)
  - PAGE_REGISTRY entry

js/[feature].js:
  - Data fetch function
  - Render function
  - Action handlers (button clicks, status changes)
  - registerSyncBar + health checks
  - Sidebar badge update

css/styles.css (only if needed):
  - Feature-specific styles using design tokens
\`\`\`

### 2c. Identify the Airtable contract

Before writing fetch/write code:
- Confirm table IDs exist in \`config.js\` or add them
- Confirm field names are exact — read them from existing code or ask Kevin
- Note which fields are linked records (need record ID filtering, not ARRAYJOIN)
- Note which fields are computed/formula (read-only)
- Plan pagination if the table could exceed 100 records

---

## Phase 3: BUILD (one complete pass)

Write all the code in a single pass. Don't commit partial work.

### 3a. Order of implementation

Follow this exact order — it prevents dependency issues:

1. **config.js** — add constants, field maps, PAGE_REGISTRY entry
2. **index.html** — sidebar item + tab panel container (respect OS-INTEGRATION markers)
3. **Feature JS file** — data fetch → render → actions → health bar (all in one file)
4. **css/styles.css** — only if feature needs styles beyond what tokens.css provides
5. **shared.js** — only if adding a genuinely shared utility (not feature-specific logic)

### 3b. Mandatory patterns (baked into every feature)

Every feature MUST include all of these. Not "should" — MUST:

**Data layer:**
- [ ] Airtable fetch with pagination (\`offset\` handling)
- [ ] Error handling on fetch (try/catch, show toast on failure, don't silently fail)
- [ ] Rate-limit handling — catch 429 responses, pause 500ms between bulk writes, exponential backoff on retries (see \`reconciliation.js\` for the pattern)
- [ ] Filter by Active status where applicable
- [ ] Field name constants from config.js (never hardcode field names in fetch URLs)
- [ ] Prefer shared global arrays (\`allTenancies\`, \`allTransactions\`, \`allCosts\`, etc.) over independent fetches when the data is already loaded by \`dashboard.js\`. Only make a separate Airtable call if the feature needs data from a table not already cached globally
- [ ] If the feature makes expensive fetches (multiple tables, 100+ records), add IndexedDB caching with TTL — follow the \`dashboard.js\` pattern: \`_idbSet(key, { savedAt: Date.now(), data })\`, check age on load, bypass cache on manual refresh

**Render layer:**
- [ ] Loading state shown during fetch (spinner + explainer text if load takes >3s — see \`costs.js\` pattern)
- [ ] Empty state when no data matches filters
- [ ] All colours from \`tokens.css\` custom properties (never hardcode hex)
- [ ] All text uses \`escHtml()\` for any user-supplied data
- [ ] Responsive — works on tablet width (no horizontal scroll below 1024px)
- [ ] Print-friendly — hide non-essential UI in \`@media print\` if the feature contains data users might print (tables, reports, summaries)

**Action layer:**
- [ ] Confirm before destructive actions (use the branded \`confirmDialog\` from shared.js)
- [ ] Toast feedback on success/failure (use \`showToast\` from shared.js)
- [ ] Disable button during async operation (prevent double-submit)
- [ ] Optimistic UI where possible (update display immediately, roll back on error)
- [ ] Undo pattern for reversible destructive actions — sliding toast with "Undo" button, auto-dismiss after 8s (see \`costs.js\` \`pushUndoAction\` pattern). Use for: status changes, dismissals, field edits. Don't use for: Airtable record deletion (not reversible)

**State persistence (when the feature needs to remember things across page loads):**
- [ ] Use localStorage for UI state: dismissed items, filter selections, user preferences, chase/stage tracking
- [ ] Namespace all keys with the feature prefix (e.g. \`cfv_\`, \`recon_\`) to avoid collisions
- [ ] Handle the "cleared site data" case — if localStorage is empty, the feature should still work (degrade gracefully, re-derive state from Airtable where possible)
- [ ] Consider what happens on a different device — localStorage is per-browser. If the state matters across devices, write it back to Airtable instead

**Accessibility:**
- [ ] \`aria-expanded\` on expandable/collapsible sections (cards, drawers)
- [ ] \`aria-modal="true"\` on modal dialogs
- [ ] \`aria-live="polite"\` on regions that update dynamically (counts, status messages)
- [ ] Keyboard navigation — Escape closes drawers/modals, Enter submits, Tab order is logical
- [ ] Interactive elements have visible focus styles (\`:focus-visible\`)
- [ ] Icons/emoji used decoratively get \`aria-hidden="true"\`; meaningful ones get \`aria-label\`

**Health & monitoring:**
- [ ] \`registerSyncBar()\` with 5-8 checks (see health-bar skill for check design)
- [ ] \`markTabSynced()\` called after successful render
- [ ] Sidebar badge (if the feature has a count worth showing)
- [ ] Sidebar health dot wired up
- [ ] Feature integrates with idle auto-refresh — if \`loadDashboard()\` is called by the idle timer in \`shared.js\`, does your feature's data update too? If your feature has its own fetch, consider whether it should also refresh on idle return

**Integration:**
- [ ] \`tabLabelMap\` entry in shared.js (for tab label display)
- [ ] PAGE_REGISTRY entry in config.js (for version tracking)
- [ ] Sidebar menu item in index.html
- [ ] **AI Assistant context** — if the feature exposes data Kevin might ask the AI about, add a context block in \`js/ai-assistant.js\` so the AI panel can reference it (see existing \`ctx.compliancePage\`, \`ctx.commsPage\` patterns)
- [ ] **Iframe communication** (iframe pages only) — \`postMessage\` status up to parent shell, listen for messages from parent (e.g. \`qt:open-new-task-drawer\`). Sync bar handles health broadcasting automatically, but feature-specific messages need manual wiring

### 3c. Code quality gates (check as you write)

- No \`var\` — use \`const\` / \`let\`
- No \`document.write\` or \`eval\`
- No inline event handlers (\`onclick="..."\`) — use \`addEventListener\` or delegated events
- Template literals for HTML generation (not string concatenation)
- Early returns for guard clauses (not deeply nested if/else)

---

## Phase 4: SELF-AUDIT (before showing Kevin anything)

This is the step that eliminates most rework. After writing all the code, audit your own work:

### 4a. Logic audit

- [ ] **Badge/count mismatch** — does the sidebar badge count match what the user sees in the tab? Account for dismissed items, active filters, and pagination.
- [ ] **Filter state persistence** — if the user filters data, does the filter survive a refresh? Does it reset on tab switch? Is that the right behaviour?
- [ ] **Empty state** — what happens if Airtable returns zero records? What if the filter produces zero results from non-zero data?
- [ ] **Stale data** — after an action (status change, dismiss), does the display update immediately? Does it refetch or locally mutate?
- [ ] **Race conditions** — if the user clicks Refresh while a fetch is in progress, what happens? If they click an action button twice fast?

### 4b. Integration audit

- [ ] **Sidebar wiring** — is the menu item's \`onclick\` calling \`switchTab('correct-id')\`?
- [ ] **Tab panel** — does the \`id="tab-xxx"\` match what \`switchTab\` expects?
- [ ] **Health bar container** — is \`data-sync-bar="xxx"\` present and matching the \`registerSyncBar\` call?
- [ ] **Globals** — are all globals you read (e.g. \`allTenancies\`) actually loaded before your code runs?
- [ ] **OS-INTEGRATION** — did you accidentally modify or delete code between OS-INTEGRATION comment pairs?

### 4c. Design token audit

- [ ] Grep your new code for any hardcoded hex colour (\`#[0-9a-fA-F]{3,8}\`)
- [ ] Grep for hardcoded font-family declarations
- [ ] Grep for hardcoded pixel values that should use spacing tokens
- [ ] Verify all status colours use semantic tokens (success/warning/danger/info)

### 4d. Cross-feature regression check

When a feature writes back to Airtable (status changes, field updates, record creation), check which other features read that same data:

- [ ] **Dashboard KPIs** — does changing a tenancy status affect rent roll, void count, arrears totals?
- [ ] **Cash flow** — does marking an invoice paid or changing a cost amount affect the forecast?
- [ ] **Reconciliation** — does a transaction status change break the matching logic?
- [ ] **CFV detection** — does a tenancy status change cause a false positive or miss a real CFV?
- [ ] **Sidebar badges** — do counts on OTHER tabs update correctly after your feature's write-back?

If your feature only reads data (no Airtable writes), this check is N/A.

### 4e. Performance check

- [ ] **API call count** — how many Airtable requests does the feature make on initial load? Target: 1-3 calls. If >5, consider whether shared globals can be reused
- [ ] **Payload size** — are you fetching all fields when you only need 3? Use \`fields[]\` parameter in the Airtable URL to limit the response
- [ ] **Render cost** — if rendering 100+ rows, use a table (not 100 expandable cards). Consider virtual scrolling or "show more" pagination for >200 items
- [ ] **No N+1 queries** — don't fetch related records one-by-one inside a loop. Batch them into a single \`filterByFormula=OR(...)\` call, or resolve from global arrays

### 4f. Security audit

- [ ] All user-facing text passed through \`escHtml()\`
- [ ] No raw Airtable field values inserted into innerHTML without escaping
- [ ] API tokens only accessed via \`PAT\` global (never hardcoded)
- [ ] No \`eval()\`, no \`innerHTML\` with unsanitised input

---

## Phase 5: HEALTH BAR (invoke the health-bar skill)

After the code is written and self-audited, wire up the health bar properly. Use the \`/health-bar\` skill for the full procedure, but at minimum:

1. Read the target JS file and identify all data sources, computations, and automations
2. Design 5-8 checks (mix of \`sync\` and \`automation\` kinds)
3. Add \`<div data-sync-bar="TAB_ID"></div>\` to the tab panel
4. Add sidebar health dot in index.html
5. Write the \`registerSyncBar()\` call with all checks
6. Call \`markTabSynced()\` after successful render
7. Test: bar renders, checks pass, Re-run works, Refresh re-syncs, sidebar dot updates

If the health bar was already included during Phase 3 (as it should be for experienced builds), this phase is a verification pass — confirm all 7 items above are working.

---

## Phase 6: VERIFY (prove it works)

### 6a. Dev server test

Start the preview server and test the golden path:
1. Load the page — does it render without console errors?
2. Does data appear (or correct empty state)?
3. Click every action button — do they work?
4. Check the health bar — does it render, do checks pass?
5. Click Refresh in the health bar — does it re-sync?
6. Check sidebar badge — does the count match?

### 6b. Edge case test

- Empty data (no records match)
- Large data (100+ records — does pagination work?)
- Network error (temporarily wrong PAT — does it show an error toast, not crash?)
- Rapid clicks (double-submit prevention)
- Tab switch and return (does state persist correctly?)

### 6c. Visual check

- Screenshot the feature at desktop width
- Check it at 1024px width (tablet)
- Verify colours match the design system (no rogue greys or blues)

### 6d. Screenshot walkthrough evidence (MANDATORY)

Before declaring the feature done, produce screenshot evidence of a full walkthrough. This proves the feature works and gives Kevin a visual record of what was built. Use the preview tools to capture each screenshot.

**Required screenshots (minimum):**

1. **Initial load state** — the feature as it appears when first opened (or empty state if no data)
2. **Data populated** — the feature with real or representative data loaded
3. **Primary interaction** — the main action being performed (e.g. opening a modal, expanding a card, clicking a button)
4. **Action result** — the outcome of the primary action (e.g. record created, status changed, form submitted)
5. **Secondary views** — if the feature has tabs, filters, or alternative views, screenshot at least one
6. **Tablet width** — the feature at 1024px width to verify responsive behaviour

Present all screenshots to Kevin with a brief caption for each. This is not optional. The feature is not done until the walkthrough is shared.

---

## Phase 7: AUDIT (invoke the audit skill)

Run \`/audit\` on the completed feature. This is a formal second pass that catches things the self-audit missed:

1. Code-level checks + live site testing via Chrome MCP
2. Bug list with severity and root cause
3. Fix each issue found (commit per fix)
4. Re-audit for self-introduced bugs (the audit-of-the-audit)
5. Score readiness out of 100 (Correctness / Error handling / Performance / UX polish / Maintainability)

The feature is not done until the audit score is reported. Target: 80+ before shipping. If below 80, fix the gaps before proceeding.

---

## Phase 8: QUALITY PIPELINE (automated, no user input needed)

Run these checks sequentially after the audit passes. Fix any issues found before proceeding. Do not ask Kevin for permission at each step — run them all, fix as you go, report the summary at the end.

### 8a. Simplify pass

Scan all changed code for:
1. Duplicate logic that can be extracted
2. Premature abstractions (interfaces with one implementation, factories with one type)
3. Dead code introduced during the build
4. Over-engineered error handling
5. Functions doing more than one thing
6. Comments that restate what the code says

Fix anything found. Do not ask for approval on simplification — just do it and note what changed.

### 8b. Test gaps

If Vitest is set up in the project:
1. List functions in changed files with no test coverage
2. Identify critical paths and edge cases for each
3. Write tests matching the project's test conventions
4. Prioritise: data writes, business logic, filter/calculation functions, error handling
5. Skip trivial getters and pure UI rendering
6. Run the tests. Fix any failures.

If no test framework exists, skip this step and note it in the final report.

### 8c. Code review

Review all changed files for:
1. Logic bugs (off-by-one, wrong operator, missing null check)
2. Style inconsistencies with the rest of the codebase
3. Performance issues (N+1 queries, unnecessary re-renders, missing pagination)
4. Accessibility gaps (missing aria attributes, broken keyboard nav)

Fix anything found.

### 8d. Security review (always run if the feature touches auth, data writes, or money)

Review changed files for:
1. Secrets in code (keys, tokens, passwords)
2. Missing \`escHtml()\` on user-supplied or Airtable-sourced text
3. \`innerHTML\` with unescaped external data
4. API tokens exposed in console logs or error messages
5. Unvalidated user input reaching Airtable writes or LLM prompts
6. Auth bypass paths

Output a numbered list of issues with severity (critical, high, medium, low). Fix all critical and high issues before proceeding.

### 8e. Pre-deploy checklist

Run and report pass/fail for each:

**Current stack (GitHub Pages):**
1. No \`console.log\` or \`debugger\` in production code paths
2. HTML passes htmlhint (the PostToolUse hook covers this, but verify)
3. All PAGE_REGISTRY entries correct (pageVer, sopFile, standalone URL)
4. \`escHtml()\` used on all external data rendered in HTML
5. Design tokens used (no hardcoded colours, fonts, or spacing)
6. \`sitemap.xml\` updated if new pages added
7. Pre-commit mapping updated in \`scripts/pre-commit-action.py\` if new pages added
8. Rollback path identified (which commit to revert to if this breaks production)

**Future stack (activate when SaaS migration begins):**
9. Supabase RLS policies on any new tables
10. Supabase migrations run on production
11. Cloudflare Worker env vars documented and set
12. CORS origins set correctly on Workers
13. Rate limiting on public endpoints
14. Error tracking/logging in place for new endpoints

Block deployment if any current-stack item fails. Future-stack items are informational until migration begins.

---

## Phase 9: SOP & SITEMAP

Every new page or significant feature extension needs its documentation and registry updated.

### 8a. Create or update the SOP

- **New page/tab**: Create a new SOP file (e.g. \`sop-[feature].html\`) using the \`/sop-generator\` skill or by copying the structure from an existing SOP like \`sop-cfvs.html\`
- **Extension of existing page**: Update the existing SOP file to cover the new functionality
- SOP must import \`css/tokens.css\` (correct relative path) for design consistency
- SOP should cover: purpose, data sources, key actions, troubleshooting, and the health bar checks
- Set \`sopVer\` in PAGE_REGISTRY to match \`pageVer\` once the SOP is current

### 8b. Update PAGE_REGISTRY

Ensure the entry in \`js/config.js\` has:
- Correct \`sopFile\` path pointing to the SOP HTML file
- \`sopVer\` set to match \`pageVer\` (since both are current as of this build)
- \`standalone\` URL for direct access

### 8c. Update sitemap.xml

Add the new page and its SOP to \`sitemap.xml\`:
\`\`\`xml
<url><loc>https://chaichoong.github.io/leadership-dashboard/[page-path]</loc></url>
<url><loc>https://chaichoong.github.io/leadership-dashboard/[sop-path]</loc></url>
\`\`\`

### 8d. Update robots.txt (if needed)

Only if the new page should be excluded from crawling.

### 8e. Update pre-commit mapping

Add the new file-to-page mapping in \`scripts/pre-commit-action.py\` so that the auto-bump workflow knows which PAGE_REGISTRY entry to bump when the file changes.

---

## Phase 10: SHIP

### 10a. Commit

- One logical commit per feature (not micro-commits per file)
- Commit message: \`<Feature name>: <what it does>\` (match existing style from \`git log\`)
- Include all files changed in the commit (feature code + SOP + sitemap + config)

### 10b. Deploy

\`\`\`bash
git pull --rebase origin main && git push origin main
\`\`\`

Then verify the deploy is live (pageVer matches, hard reload).

### 10c. Report to Kevin

Short summary:

\`\`\`
Done: [Feature name]
Files changed: [list]
What it does: [2-3 sentences]
Health checks: [count] checks registered
Audit score: XX/100
SOP: [created/updated] at [path]
Live at: [URL if applicable]
\`\`\`

Include a screenshot if the feature is visual.

---

## Quick reference: common mistakes to avoid

| Mistake | Prevention |
|---------|-----------|
| Wrong Airtable field name (capitalisation/spaces) | Always read from config.js or confirm with Kevin |
| Badge shows raw count, not filtered count | Badge logic must match the rendered/visible items |
| Hardcoded colour | Grep for \`#\` in your new code |
| Missing health bar | It's in the checklist — don't skip it |
| Missing empty state | Test with zero records |
| Missing loading state | Show spinner/skeleton before fetch resolves |
| Double-submit on buttons | Disable button, re-enable after async completes |
| Stale display after action | Locally mutate or refetch + rerender |
| Missing escHtml on user data | Grep for \`innerHTML\` assignments, verify all have escHtml |
| Forgot PAGE_REGISTRY entry | Auto-bump won't work without it |
| Forgot tabLabelMap entry | Tab label will show raw ID instead of human name |
| Broke OS-INTEGRATION section | Read index.html first, mark those sections as untouchable |
| Airtable 429 rate limit on bulk writes | 500ms pause between requests, exponential backoff on retry |
| N+1 query pattern (fetch in a loop) | Batch into single \`filterByFormula=OR(...)\` or resolve from globals |
| Redundant Airtable fetch when global array exists | Check if \`allTenancies\`, \`allTransactions\`, etc. already have the data |
| localStorage collision with another feature | Namespace all keys with feature prefix (\`cfv_\`, \`recon_\`, \`inv_\`) |
| Feature write-back breaks another tab's counts | Run cross-feature regression check (Phase 4d) |
| No undo on destructive actions | Add sliding undo toast for dismiss/status-change/field-edit |
| Missing accessibility (no keyboard nav) | Escape closes, Enter submits, aria-expanded on collapsibles |
| AI assistant can't answer questions about new feature | Add context block in \`ai-assistant.js\` |
| Forgot SOP / sitemap update | Phase 8 — it's not done until the SOP exists |
`,
    },
    {
        id: 'audit',
        name: 'Audit & Score',
        command: 'audit',
        description: 'Robustness audit of a page or dashboard — finds bugs via code review and live browser testing, fixes them, re-audits self-introduced issues, and produces a scored readiness report.',
        category: 'Development',
        source: 'project',
        tags: ['audit', 'testing', 'quality', 'score'],
        instructions: `---
name: audit
description: Robustness audit of a page or dashboard — finds bugs, fixes them, re-audits self-introduced issues, deploys safely, and produces a scored readiness report.
---

# Audit & Score

Run a robustness audit on the specified page/dashboard.

## Steps

1. **Test the live site** using the Chrome MCP (\`mcp__claude-in-chrome__*\`) where auth permits, plus code-level checks (Read/Grep on the relevant \`js/\` and HTML files).
2. **List bugs found** with severity (HIGH / MEDIUM / LOW) and a one-line root cause for each.
3. **Fix each issue** and commit. Match the repo's commit-message style (look at \`git log\` first). Use one commit per logical fix, not a single mega-commit.
4. **Re-audit** the changes for self-introduced bugs — specifically: badge/count mismatches, filter logic that ignores dismissed items, double-submit risks, stale-state on async operations.
5. **Pull-rebase before pushing** to avoid overwriting parallel-session work:
   \`\`\`
   git pull --rebase origin main && git push origin main
   \`\`\`
   Then verify the GitHub Pages deploy is actually live (hard reload, check \`pageVer\` in \`js/config.js\` matches what's served).
6. **Score readiness out of 100** using this rubric (20 pts each):
   - **Correctness** — no logic bugs, counts match underlying data
   - **Error handling** — failed API calls, empty states, auth expiry
   - **Performance** — no obvious N+1 fetches, pagination respected
   - **UX polish** — loading states, mobile layout, accessibility basics
   - **Maintainability** — uses tokens.css, file split per CLAUDE.md, no hardcoded IDs
   Report each dimension's sub-score and the total.

## Output format

\`\`\`
## Audit: <page name>

### Bugs found
- [HIGH] <bug> — <root cause>
- [MED]  <bug> — <root cause>
...

### Fixes applied
- <commit sha> <message>
...

### Re-audit
<self-introduced issues, or "clean">

### Deploy
<verified live at <pageVer>>

### Readiness: XX / 100
- Correctness: XX/20
- Error handling: XX/20
- Performance: XX/20
- UX polish: XX/20
- Maintainability: XX/20
\`\`\`
`,
    },
    {
        id: 'health-bar',
        name: 'Health Bar',
        command: 'health-bar',
        description: 'Add a sync bar with health checks to a page or tab — auto-generates data-sync checks, automation checks, and a refresh function, then wires up the HTML container and sidebar health dot.',
        category: 'Development',
        source: 'project',
        tags: ['health', 'sync', 'monitoring', 'checks'],
        instructions: `---
name: health-bar
description: Add a sync bar with health checks to a new or existing page/tab. Analyses the page's JS to auto-generate data-sync checks, automation checks, and a refresh function, then wires up the HTML container and sidebar health dot. Use when a page or section has been built and needs the reliability bar added.
---

# Health Bar Generator

Add the standard sync bar + health check system to a page or tab that doesn't have one yet.

## Pre-requisites

The sync bar system (\`js/sync-bar.js\` + \`css/sync-bar.css\`) is already loaded globally by \`index.html\`. This skill only needs to:
1. Add the HTML container
2. Write the \`registerSyncBar()\` call with appropriate checks
3. Wire up the sidebar health dot

## Procedure

### 1. Identify the target

Determine from the user's request:
- **Tab ID** — the string used in \`switchTab('xxx')\` (e.g. \`'overview'\`, \`'cfv'\`, \`'invoices'\`)
- **JS file** — which \`js/*.js\` file contains the tab's render logic
- **Render function** — the function called after data loads (e.g. \`renderCFVTab\`, \`renderInvoiceTab\`)
- **Data refresh function** — what to call when the user clicks Refresh (e.g. \`loadDashboard\`, \`fetchInvoicesFromAirtable\`)

If the target is an **iframe page** (e.g. \`os/*.html\`, \`follow-up.html\`, \`compliance.html\`), the pattern differs slightly — see the iframe section below.

### 2. Read and analyse the page's code

Read the target JS file end-to-end. Build a mental model of:

**Data sources** — what globals or fetches does the page depend on?
- Airtable tables fetched (look for \`fetch(\` calls with Airtable URLs, or globals like \`allTenancies\`, \`allTransactions\`, \`allCosts\`)
- External APIs called (Gmail sync, Apps Script, webhooks)
- LocalStorage/IDB data used
- Globals consumed from other files (e.g. \`allTenancies\` loaded by \`dashboard.js\`)

**Core computations** — what does the page calculate or derive?
- Detection algorithms (e.g. \`detectCFVs()\`)
- Matching/reconciliation logic
- Aggregations, counts, totals
- Filters applied (active/inactive, status-based)

**Automations & features** — what should be running?
- Timers/intervals (\`setInterval\`, refresh loops)
- Sidebar badge updates
- Write-back to Airtable
- Cache mechanisms
- Linked record resolution

**UI outputs** — what does the user see?
- Cards, tables, counts, badges
- Status indicators
- Action buttons (approve, dismiss, mark paid)

### 3. Design the checks

Generate two categories of checks:

#### Data sync checks (\`kind: 'sync'\`)
These verify that the page's data arrived correctly. They run automatically on every \`markTabSynced()\`.

Standard patterns:
- **"X records fetched"** — verify the primary data array has length > 0, report the count
- **"Y count within expected range"** — warn if a count is suspiciously low (e.g. active tenancies < 30)
- **"Each record has required field Z"** — check for missing linked records, null fields, orphan references
- **"Computation produces valid result"** — run the core algorithm, verify it doesn't throw and produces a sane number
- **"Freshness of source data"** — if bank sync or API has a "last updated" field, check it's not stale

#### Automation & feature checks (\`kind: 'automation'\`)
These verify that features and integrations are wired up correctly.

Standard patterns:
- **"Function X is loaded"** — \`typeof myFunction === 'function'\`
- **"Sidebar badge matches data"** — compare badge count to actual computed count
- **"Timer/interval is running"** — check the timer variable isn't null
- **"External URL configured"** — check that config constants exist
- **"Last action succeeded"** — if the page tracks last-action status, report it
- **"Cache is fresh / localStorage persists"** — check persistence layer

#### Active checks (\`active: true\`)
Mark a check as active if it does something heavy: Airtable writes, HTTP pings, or O(n) API calls. These only run when the user clicks "Re-run" in the drawer. Most checks should be passive (default).

### 4. Write the code

#### a) HTML container

There are two patterns — use whichever matches the existing tab:

**Static placement (most tabs):** The tab panel already exists in \`index.html\` with child elements. Add \`<div data-sync-bar="TAB_ID"></div>\` as the **first child** inside it:

\`\`\`html
<div class="tab-panel" id="tab-TAB_ID">
    <div data-sync-bar="TAB_ID"></div>   <!-- ADD THIS -->
    <!-- existing content -->
</div>
\`\`\`

**Dynamic placement (tabs that build via innerHTML):** Some tabs (e.g. \`pnl\`, \`transactions\`) have an empty \`<div class="tab-panel" id="tab-TAB_ID"></div>\` in \`index.html\` and build all content dynamically in JS. For these, include \`<div data-sync-bar="TAB_ID"></div>\` at the top of the innerHTML template string in the JS file.

Check which pattern applies: if the tab's \`<div>\` in \`index.html\` already has child elements, use static. If it's empty or self-closing, use dynamic.

For iframe pages, add it at the top of \`<main>\` or the first content container.

#### b) Sidebar health dot

If not already present, add the health dot to the sidebar item in \`index.html\`:

\`\`\`html
<span class="sidebar-health-dot unknown" data-sidebar-health="TAB_ID" title="No checks run yet"></span>
\`\`\`

#### c) registerSyncBar call

Add the registration block at the **end** of the page's main render function, just before the function's closing brace. Follow this exact pattern:

\`\`\`javascript
// ── Sync Bar + Health Checks ──
if (typeof registerSyncBar === 'function') {
    registerSyncBar('TAB_ID', {
        refreshFn: async () => { /* call the data refresh function(s) */ },
        checks: [
            // ─── DATA SYNC ───
            {
                name: 'Descriptive check name', kind: 'sync', run: () => {
                    // Return { status: 'pass'|'warn'|'fail', detail: 'human-readable text' }
                }
            },
            // ─── AUTOMATIONS & FEATURE HEALTH ───
            {
                name: 'Feature check name', kind: 'automation', run: () => {
                    // ...
                }
            },
        ],
    });
    markTabSynced('TAB_ID');
}
\`\`\`

**Load-order note:** \`sync-bar.js\` is loaded with \`defer\` in \`index.html\`, so both \`registerSyncBar\` and \`markTabSynced\` are always available by the time any tab renders. The \`typeof registerSyncBar === 'function'\` guard is a defensive pattern for iframe pages where the script may not be loaded. For in-shell tabs you can rely on both functions existing, but the guard is harmless and consistent.

### 5. refreshFn design

The \`refreshFn\` must re-fetch the tab's data AND re-render the tab. Some tabs own their data fetch; others depend on globals loaded by \`dashboard.js\`.

**Tab owns its data** (e.g. \`invoices.js\`):
\`\`\`javascript
refreshFn: async () => { await fetchInvoicesFromAirtable(); }
\`\`\`
The fetch function's success path should call the render function, which calls \`markTabSynced\`.

**Tab derives from shared globals** (e.g. \`cfv.js\`):
\`\`\`javascript
refreshFn: async () => { await loadDashboard(); await renderCFVTab(); }
\`\`\`
Must reload the base data first, then re-derive the tab's view.

**Tab with external sync** (e.g. \`invoices.js\` with Gmail):
\`\`\`javascript
refreshFn: async () => {
    if (typeof triggerGmailInvoiceSync === 'function') triggerGmailInvoiceSync();
    await fetchInvoicesFromAirtable();
}
\`\`\`

### 6. Check naming conventions

Check names should be **declarative** and describe what's being verified, not how:
- "Invoices fetched from Airtable" (not "Check invoice count")
- "Each CFV has days-overdue populated" (not "Validate daysOverdue")
- "Sidebar badge matches detection count" (not "Test badge")

Detail text should give Kevin enough context to diagnose issues:
- Include counts: \`"47 active tenancies (In Payment / CFV / CFV Actioned)"\`
- Include values: \`"£12,450.00 · last bank sync 2 hours ago"\`
- Name the likely cause on failure: \`"formula on Tenancies table may be broken"\`

### 7. Verify

After adding the health bar:
1. Check the page loads without console errors
2. Confirm the sync bar renders (dot, time, refresh button, health pill)
3. Click the health pill — drawer should expand showing all checks
4. Click Re-run — active checks should execute
5. Click Refresh — data should reload and checks re-run
6. Check the sidebar health dot updates to match

## Iframe page variant

For standalone pages loaded via iframe (\`os/*.html\`, \`follow-up.html\`, \`compliance.html\`):

1. Ensure \`sync-bar.css\` is in the \`<head>\` and \`sync-bar.js\` is loaded near the bottom (after the page's own scripts), both with cache-buster params matching \`index.html\`:
   \`\`\`html
   <!-- In <head> -->
   <link rel="stylesheet" href="css/sync-bar.css?v=2">
   
   <!-- Near bottom of <body>, after page scripts -->
   <script src="js/sync-bar.js?v=4"></script>
   \`\`\`
   Adjust path depth for \`os/\` pages: \`../css/sync-bar.css\`, \`../js/sync-bar.js\`. Check the current version numbers in \`index.html\` and match them.

2. The \`_broadcastStatus()\` function in \`sync-bar.js\` will automatically \`postMessage\` the status up to the parent shell, which updates the sidebar health dot.

3. The parent shell's \`shared.js\` listens for \`syncBarStatus\` messages and calls \`updateSidebarHealth()\`.

## Minimum viable checks

Every health bar should have at minimum:
1. At least one **data loaded** check (primary data array has records)
2. At least one **data quality** check (key fields populated, counts in range)
3. At least one **feature health** check (core function loaded, badge wired)

Aim for 5-8 checks per tab. More than 12 becomes noisy; fewer than 3 doesn't provide enough signal.

## Check return value reference

\`\`\`javascript
{ status: 'pass', detail: 'Human-readable success message with counts/values' }
{ status: 'warn', detail: 'Something unexpected but not broken — include likely cause' }
{ status: 'fail', detail: 'Something is broken — name the root cause or missing dependency' }
\`\`\`
`,
    },
    {
        id: 'sop-generator',
        name: 'SOP Generator',
        command: 'anthropic-skills:sop-generator',
        description: 'Generates a complete SOP HTML page from live source code — reads the feature JS, extracts functionality, and produces a structured guide with the platform design system.',
        category: 'Development',
        source: 'custom',
        tags: ['SOP', 'documentation', 'generation', 'HTML'],
        instructions: `---
name: sop-generator
description: "Generates a complete SOP HTML file for any of Kevin's skills by reading its SKILL.md and filling every placeholder in the standard SOP template. Use when Kevin says \\"generate the SOP for [skill name]\\", \\"create an SOP for [skill name]\\", or \\"add an SOP for [skill name]\\"."
---

# SOP Generator

## Overview

Reads a skill's SKILL.md, maps all content to the embedded template below, and produces a completed HTML SOP file for manual upload to GitHub.

Steps:
1. Read the target SKILL.md
2. Map its content to every \`{{PLACEHOLDER}}\` in the template
3. Write the completed HTML to \`/mnt/user-data/outputs/[skill-name].html\`
4. Confirm to Kevin

---

## Step 1 — Identify the Skill

Extract the skill name from Kevin's message. The SKILL.md is always at:

\`\`\`
/mnt/skills/user/[skill-name]/SKILL.md
\`\`\`

Read the full file before proceeding. If it does not exist, stop and tell Kevin.

---

## Step 2 — Map Placeholders

Fill **every** \`{{PLACEHOLDER}}\` using the table below. Never leave one unfilled. If no relevant content exists, write \`N/A\`.

| Placeholder | Source |
|---|---|
| \`{{SKILL_TITLE}}\` | Human-readable skill name (title-case, spaces, no hyphens) |
| \`{{SKILL_ICON}}\` | A single relevant emoji matching the skill's purpose |
| \`{{SKILL_SUBTITLE}}\` | One-line description of what the skill does |
| \`{{VERSION}}\` | \`1.0\` unless the SKILL.md states otherwise |
| \`{{DATE}}\` | Today's date in \`DD MMM YYYY\` format |
| \`{{TRIGGER_PHRASE}}\` | The primary trigger phrase from the SKILL.md description |
| \`{{SKILL_FILE_PATH}}\` | \`/mnt/skills/user/[skill-name]/SKILL.md\` |
| \`{{PRIMARY_TOOLS}}\` | Comma-separated list of tools used (Airtable, Slack, Gmail, etc.) |
| \`{{AIRTABLE_BASE}}\` | Airtable base name/ID if used, else \`N/A\` |
| \`{{APPROVAL_REQUIRED}}\` | \`Yes\` or \`No\` based on whether the skill has approval gates |
| \`{{SLACK_CHANNEL}}\` | Slack channel(s) mentioned in SKILL.md, else \`N/A\` |
| \`{{CATEGORY}}\` | One of: Property, Finance, Content, Operations, Admin, Runpreneur |
| \`{{ESTIMATED_DURATION}}\` | Estimated time to run end-to-end (e.g. \`2–3 minutes\`). Infer from complexity if not stated. |
| \`{{PURPOSE_DESCRIPTION}}\` | 2–3 sentence summary of what the skill does and why it exists |
| \`{{SCOPE_NOTES}}\` | What is in scope and explicitly out of scope |
| \`{{TRIGGER_PHRASES_LIST}}\` | \`<li>\` items for each trigger phrase |
| \`{{DO_NOT_USE}}\` | Conditions where this skill should NOT be triggered |
| \`{{INPUTS_TABLE_ROWS}}\` | \`<tr>\` rows — one per required input (see format below) |
| \`{{FLOW_STEPS_HTML}}\` | Visual flow using \`.flow-step\` and \`.flow-arrow\` divs (see format below) |
| \`{{WORKFLOW_CARDS_HTML}}\` | \`.wf-card\` blocks — one per major workflow step (see format below) |
| \`{{TOOLS_TABLE_ROWS}}\` | \`<tr>\` rows — one per tool (see format below) |
| \`{{APPROVAL_GATES_CONTENT}}\` | HTML describing approval points, or \`<p>No approval gates.</p>\` |
| \`{{OUTPUTS_TABLE_ROWS}}\` | \`<tr>\` rows — one per output |
| \`{{ERROR_HANDLING_CONTENT}}\` | HTML list of common errors and how to handle them |
| \`{{TROUBLESHOOTING_ITEMS}}\` | \`.ts-item\` divs (see format below) |
| \`{{CHANGELOG_ROWS}}\` | \`<tr>\` for version 1.0 initial release |

---

## HTML Snippet Formats

### Inputs table row
\`\`\`html
<tr>
  <td><strong>Input Name</strong></td>
  <td><span class="label-badge lb-red">Required</span></td>
  <td>Description of what this input is</td>
  <td><em>Example value</em></td>
</tr>
\`\`\`
Use \`lb-red\` for Required, \`lb-amber\` for Optional.

### Flow steps
\`\`\`html
<div class="flow-step primary">
  <span class="flow-icon">📥</span>
  Step Label
  <div class="flow-sub">sub-note</div>
</div>
<div class="flow-arrow">→</div>
\`\`\`
Use colour classes: \`primary\` (blue), \`success\` (green), \`warning\` (amber), \`purple\`. Last step should be \`success\`. Keep labels short (2–4 words).

### Workflow cards
\`\`\`html
<div class="wf-card">
  <div class="wf-header">
    <div class="wf-num">1</div>
    <h3>Step Title</h3>
    <span class="wf-tag">automated</span>
  </div>
  <div class="wf-body">
    <ol class="steps">
      <li>Sub-step one</li>
      <li>Sub-step two</li>
    </ol>
    <div class="info-box info">
      <span class="ib-icon">ℹ️</span>
      <div>Any relevant note.</div>
    </div>
  </div>
</div>
\`\`\`
Tag values: \`automated\`, \`manual\`, \`approval gate\`, \`conditional\`.

### Tools table row
\`\`\`html
<tr>
  <td><strong>Tool Name</strong></td>
  <td>What it does in this skill</td>
  <td><span class="label-badge lb-blue">Connected</span></td>
</tr>
\`\`\`

### Troubleshooting items
\`\`\`html
<div class="ts-item">
  <div class="ts-problem">❌ Problem description</div>
  <div class="ts-solution">✅ How to fix it</div>
</div>
\`\`\`

### Approval gate
\`\`\`html
<div class="info-box warn">
  <span class="ib-icon">⚠️</span>
  <div><strong>Approval Gate:</strong> Description of what Kevin must approve and how.</div>
</div>
\`\`\`

### Changelog row
\`\`\`html
<tr>
  <td><span class="label-badge lb-blue">1.0</span></td>
  <td>DD MMM YYYY</td>
  <td>Initial release</td>
</tr>
\`\`\`

---

## Step 3 — Write the Output

Use the template below verbatim. Replace every \`{{PLACEHOLDER}}\` with the mapped content. Do not alter any CSS, class names, element structure, or IDs. Do not add any elements not in the template.

Write the completed file to \`/mnt/user-data/outputs/[skill-name].html\` using \`create_file\` or \`bash_tool\`. Do not stream the HTML into chat.

---

## Step 4 — Generate the JSON file

Write a second file to \`/mnt/user-data/outputs/[skill-name].json\` with exactly this structure:

\`\`\`json
{
  "id": "[skill-name]",
  "title": "[Skill Title]",
  "desc": "[One sentence from the skill purpose]",
  "category": "[finance|property|tenant|comms|ops|content|system]",
  "icon": "[relevant emoji HTML entity e.g. &#x1F527;]",
  "version": "1.0",
  "updated": "[today's date in YYYY-MM-DD format]",
  "file": "sops/[skill-name].html"
}
\`\`\`

Rules:
- \`id\` must match the HTML filename exactly (without \`.html\`)
- \`file\` must always start with \`sops/\`
- \`category\` must be exactly one of: \`finance\`, \`property\`, \`tenant\`, \`comms\`, \`ops\`, \`content\`, \`system\`
- \`desc\` must be a single sentence drawn from the purpose section of the SKILL.md
- \`icon\` must be an HTML entity string matching the emoji used in the SOP header (e.g. \`&#x1F527;\` for 🔧)
- \`version\` is always \`"1.0"\` for new SOPs
- \`updated\` is today's date in \`YYYY-MM-DD\` format

---

## Step 5 — Notify Mica via Slack

Send a DM to Mica (Slack user ID: \`U08HW0TAWAE\`) with the following message:

\`\`\`
Hey Mica 👋 A new SOP has been generated and needs uploading to GitHub.

*Task:* Upload two files to the \`sops/\` folder in https://github.com/chaichoong/sops

*Files to upload:*
• \`[skill-name].html\`
• \`[skill-name].json\`

Both files have been downloaded from Cowork. Once uploaded, the SOP will be live at:
https://chaichoong.github.io/sops/[skill-name].html

Thanks! ✅
\`\`\`

---

## Step 6 — Confirm to Kevin

Present both files for download, then confirm:

> ✅ SOP generated and Mica notified on Slack.
> - \`[skill-name].html\`
> - \`[skill-name].json\`

---

## Rules

- Never leave a \`{{PLACEHOLDER}}\` in the output
- Match the template CSS and structure exactly — do not restyle
- Base all content strictly on the SKILL.md — do not invent details
- If a section has no relevant content, write \`N/A\` or a factual fallback
- Always attempt GitHub upload — never skip it

---

## Embedded Template

Use exactly this HTML. Replace all \`{{PLACEHOLDER}}\` tokens and write the result as the output file.

\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{SKILL_TITLE}} &mdash; Standard Operating Procedure</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.6; color: #1e293b; background: #f1f5f9;
}
:root {
  --blue-50:#eff6ff;--blue-100:#dbeafe;--blue-200:#bfdbfe;--blue-500:#3b82f6;--blue-600:#2563eb;--blue-700:#1d4ed8;--blue-800:#1e40af;--blue-900:#1e3a5f;
  --indigo-50:#eef2ff;--indigo-100:#e0e7ff;--indigo-500:#6366f1;--indigo-600:#4f46e5;--indigo-700:#4338ca;
  --green-50:#f0fdf4;--green-100:#dcfce7;--green-500:#22c55e;--green-600:#16a34a;--green-700:#15803d;
  --amber-50:#fffbeb;--amber-100:#fef3c7;--amber-500:#f59e0b;--amber-600:#d97706;
  --red-50:#fef2f2;--red-100:#fee2e2;--red-500:#ef4444;--red-600:#dc2626;
  --purple-50:#faf5ff;--purple-500:#a855f7;--purple-600:#9333ea;
  --slate-50:#f8fafc;--slate-100:#f1f5f9;--slate-200:#e2e8f0;--slate-300:#cbd5e1;--slate-400:#94a3b8;--slate-500:#64748b;--slate-600:#475569;--slate-700:#334155;--slate-800:#1e293b;
  --shadow:0 1px 3px rgba(0,0,0,0.1),0 1px 2px rgba(0,0,0,0.06);--shadow-md:0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -1px rgba(0,0,0,0.06);--shadow-lg:0 10px 15px -3px rgba(0,0,0,0.1),0 4px 6px -2px rgba(0,0,0,0.05);
  --radius:12px;--radius-sm:8px;
}
.header { background: linear-gradient(135deg, var(--blue-800) 0%, var(--indigo-700) 100%); color: white; padding: 2.5rem 2rem 2rem; position: relative; overflow: hidden; }
.header::after { content:''; position:absolute; top:-50%; right:-10%; width:500px; height:500px; background:radial-gradient(circle,rgba(255,255,255,0.08) 0%,transparent 70%); border-radius:50%; }
.header-inner { max-width:1100px; margin:0 auto; position:relative; z-index:1; }
.header-back { display:inline-flex; align-items:center; gap:0.4rem; font-size:0.82rem; opacity:0.7; text-decoration:none; color:white; margin-bottom:1rem; transition:opacity 0.15s; }
.header-back:hover { opacity:1; }
.header h1 { font-size:2.2rem; font-weight:700; margin-bottom:0.3rem; letter-spacing:-0.5px; }
.header .subtitle { font-size:1.05rem; opacity:0.85; }
.header .version { font-size:0.85rem; opacity:0.6; margin-top:0.5rem; }
.container { max-width:1100px; margin:0 auto; padding:0 1.5rem 4rem; }
.section { margin-top:2.5rem; }
.section-title { font-size:1.5rem; font-weight:700; color:var(--blue-800); padding-bottom:0.5rem; border-bottom:3px solid var(--blue-200); margin-bottom:1.25rem; display:flex; align-items:center; gap:0.5rem; }
.section-title .icon { font-size:1.4rem; }
.card { background:white; border-radius:var(--radius); box-shadow:var(--shadow); padding:1.5rem; margin-bottom:1.25rem; border:1px solid var(--slate-200); }
.card-header { font-size:1.1rem; font-weight:600; color:var(--slate-800); margin-bottom:0.75rem; display:flex; align-items:center; gap:0.5rem; }
.quick-ref { background:linear-gradient(135deg,var(--blue-50) 0%,var(--indigo-50) 100%); border:2px solid var(--blue-200); border-radius:var(--radius); padding:1.5rem; margin-top:-1rem; position:relative; z-index:2; box-shadow:var(--shadow-lg); }
.quick-ref h2 { font-size:1.2rem; color:var(--blue-800); margin-bottom:1rem; display:flex; align-items:center; gap:0.5rem; }
.qr-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:0.75rem; }
.qr-item { background:white; border-radius:var(--radius-sm); padding:0.75rem 1rem; border-left:4px solid var(--blue-500); font-size:0.88rem; }
.qr-item .qr-label { font-weight:600; color:var(--slate-600); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; }
.qr-item .qr-value { color:var(--slate-800); margin-top:0.15rem; word-break:break-all; }
.qr-item .qr-value a { color:var(--blue-600); text-decoration:none; }
.qr-item .qr-value a:hover { text-decoration:underline; }
.toc { background:white; border-radius:var(--radius); box-shadow:var(--shadow); padding:1.5rem; border:1px solid var(--slate-200); }
.toc h2 { font-size:1.15rem; color:var(--blue-800); margin-bottom:1rem; }
.toc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:0.35rem 1.5rem; }
.toc a { display:flex; align-items:center; gap:0.5rem; color:var(--slate-700); text-decoration:none; padding:0.35rem 0.5rem; border-radius:6px; font-size:0.9rem; transition:background 0.15s; }
.toc a:hover { background:var(--blue-50); color:var(--blue-700); }
.toc a .toc-num { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%; background:var(--blue-100); color:var(--blue-700); font-size:0.7rem; font-weight:700; flex-shrink:0; }
.flow { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:0; padding:1.5rem 0; }
.flow-step { background:white; border:2px solid var(--blue-200); border-radius:var(--radius-sm); padding:0.75rem 1.1rem; text-align:center; font-size:0.85rem; font-weight:600; color:var(--slate-700); min-width:110px; }
.flow-step.primary { background:var(--blue-600); color:white; border-color:var(--blue-700); }
.flow-step.success { background:var(--green-600); color:white; border-color:var(--green-700); }
.flow-step.warning { background:var(--amber-500); color:white; border-color:var(--amber-600); }
.flow-step.purple { background:var(--purple-600); color:white; border-color:var(--purple-600); }
.flow-step .flow-icon { font-size:1.3rem; display:block; margin-bottom:0.25rem; }
.flow-step .flow-sub { font-weight:400; font-size:0.75rem; opacity:0.85; margin-top:0.15rem; }
.flow-arrow { font-size:1.4rem; color:var(--slate-400); padding:0 0.3rem; flex-shrink:0; }
.label-table { width:100%; border-collapse:separate; border-spacing:0; font-size:0.88rem; }
.label-table th { background:var(--blue-700); color:white; padding:0.75rem 1rem; text-align:left; font-weight:600; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.5px; }
.label-table th:first-child { border-radius:var(--radius-sm) 0 0 0; }
.label-table th:last-child { border-radius:0 var(--radius-sm) 0 0; }
.label-table td { padding:0.65rem 1rem; border-bottom:1px solid var(--slate-200); vertical-align:top; }
.label-table tr:last-child td { border-bottom:none; }
.label-table tr:nth-child(even) td { background:var(--slate-50); }
.label-table tr:hover td { background:var(--blue-50); }
.label-badge { display:inline-block; padding:0.2rem 0.6rem; border-radius:999px; font-weight:600; font-size:0.78rem; white-space:nowrap; }
.lb-blue { background:#dbeafe; color:#1d4ed8; } .lb-amber { background:#fef3c7; color:#92400e; }
.lb-red { background:#fee2e2; color:#991b1b; } .lb-green { background:#dcfce7; color:#166534; }
.lb-purple { background:#e0e7ff; color:#3730a3; }
.wf-card { background:white; border-radius:var(--radius); box-shadow:var(--shadow); border:1px solid var(--slate-200); overflow:hidden; margin-bottom:1.5rem; }
.wf-header { padding:1rem 1.5rem; display:flex; align-items:center; gap:0.75rem; border-bottom:1px solid var(--slate-200); }
.wf-num { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; border-radius:50%; font-weight:700; font-size:1rem; flex-shrink:0; color:white; background:var(--blue-600); }
.wf-header h3 { font-size:1.1rem; font-weight:700; color:var(--slate-800); }
.wf-header .wf-tag { font-size:0.75rem; padding:0.15rem 0.5rem; border-radius:999px; background:var(--slate-100); color:var(--slate-600); font-weight:500; }
.wf-body { padding:1.25rem 1.5rem; }
.wf-body h4 { font-size:0.9rem; font-weight:600; color:var(--slate-700); margin-bottom:0.5rem; margin-top:1rem; }
.wf-body h4:first-child { margin-top:0; }
.steps { counter-reset:step; list-style:none; padding:0; }
.steps li { position:relative; padding:0.5rem 0 0.5rem 2.5rem; font-size:0.9rem; line-height:1.5; }
.steps li::before { counter-increment:step; content:counter(step); position:absolute; left:0; top:0.45rem; width:24px; height:24px; border-radius:50%; background:var(--blue-100); color:var(--blue-700); font-size:0.75rem; font-weight:700; display:flex; align-items:center; justify-content:center; }
.steps li + li { border-top:1px solid var(--slate-100); }
.info-box { padding:0.85rem 1rem; border-radius:var(--radius-sm); font-size:0.88rem; margin:0.75rem 0; display:flex; align-items:flex-start; gap:0.6rem; }
.info-box.info { background:var(--blue-50); border-left:4px solid var(--blue-500); color:var(--blue-800); }
.info-box.warn { background:var(--amber-50); border-left:4px solid var(--amber-500); color:#92400e; }
.info-box.danger { background:var(--red-50); border-left:4px solid var(--red-500); color:#991b1b; }
.info-box.tip { background:var(--green-50); border-left:4px solid var(--green-500); color:var(--green-700); }
.info-box .ib-icon { font-size:1.1rem; flex-shrink:0; margin-top:0.05rem; }
code { background:var(--slate-100); padding:0.15rem 0.4rem; border-radius:4px; font-size:0.82rem; font-family:'SF Mono',Monaco,Consolas,monospace; color:var(--indigo-600); }
.ts-item { margin-bottom:0.75rem; }
.ts-problem { font-weight:600; color:var(--red-600); font-size:0.9rem; }
.ts-solution { font-size:0.88rem; color:var(--slate-700); margin-top:0.2rem; padding-left:1rem; }
.grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
strong { color:var(--slate-800); } a { color:var(--blue-600); }
p { margin-bottom:0.5rem; } ul,ol { margin-left:1.25rem; margin-bottom:0.5rem; }
li { margin-bottom:0.2rem; font-size:0.9rem; } hr { border:none; border-top:1px solid var(--slate-200); margin:1.5rem 0; }
@media (max-width:768px) {
  .header h1 { font-size:1.6rem; } .qr-grid { grid-template-columns:1fr; }
  .toc-grid { grid-template-columns:1fr; } .grid-2 { grid-template-columns:1fr; }
  .flow { flex-direction:column; } .flow-arrow { transform:rotate(90deg); }
  .container { padding:0 1rem 3rem; }
}
</style>
</head>
<body>

<div class="header">
  <div class="header-inner">
    <a href="../index.html" class="header-back">&#x2190; Back to SOP Index</a>
    <h1>{{SKILL_ICON}} {{SKILL_TITLE}}</h1>
    <div class="subtitle">Standard Operating Procedure &mdash; {{SKILL_SUBTITLE}}</div>
    <div class="version">Version {{VERSION}} &bull; {{DATE}} &bull; Owner: Kevin Brittain</div>
  </div>
</div>

<div class="container">

<!-- QUICK REFERENCE -->
<div class="quick-ref">
  <h2>&#x26A1; Quick Reference</h2>
  <div class="qr-grid">

    <div class="qr-item">
      <div class="qr-label">Trigger Phrase</div>
      <div class="qr-value">{{TRIGGER_PHRASE}}</div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Skill File</div>
      <div class="qr-value"><code>{{SKILL_FILE_PATH}}</code></div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Primary Tool(s)</div>
      <div class="qr-value">{{PRIMARY_TOOLS}}</div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Airtable Base</div>
      <div class="qr-value">{{AIRTABLE_BASE}}</div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Approval Required</div>
      <div class="qr-value">{{APPROVAL_REQUIRED}}</div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Slack Channel</div>
      <div class="qr-value">{{SLACK_CHANNEL}}</div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Category</div>
      <div class="qr-value">{{CATEGORY}}</div>
    </div>

    <div class="qr-item">
      <div class="qr-label">Estimated Duration</div>
      <div class="qr-value">{{ESTIMATED_DURATION}}</div>
    </div>

  </div>
</div>

<!-- TABLE OF CONTENTS -->
<div class="section">
  <div class="toc">
    <h2>&#x1F4D1; Contents</h2>
    <div class="toc-grid">
      <a href="#purpose"><span class="toc-num">1</span> Purpose &amp; Scope</a>
      <a href="#trigger"><span class="toc-num">2</span> When to Use This Skill</a>
      <a href="#inputs"><span class="toc-num">3</span> Required Inputs</a>
      <a href="#workflow"><span class="toc-num">4</span> Step-by-Step Workflow</a>
      <a href="#tools"><span class="toc-num">5</span> Tools &amp; Integrations</a>
      <a href="#approval"><span class="toc-num">6</span> Approval Gates</a>
      <a href="#outputs"><span class="toc-num">7</span> Outputs &amp; Confirmations</a>
      <a href="#errors"><span class="toc-num">8</span> Error Handling</a>
      <a href="#troubleshooting"><span class="toc-num">9</span> Troubleshooting</a>
      <a href="#changelog"><span class="toc-num">10</span> Changelog</a>
    </div>
  </div>
</div>

<!-- 1. PURPOSE -->
<div class="section" id="purpose">
  <h2 class="section-title"><span class="icon">&#x1F3AF;</span> 1. Purpose &amp; Scope</h2>
  <div class="card">
    <p>{{PURPOSE_DESCRIPTION}}</p>
    <div class="info-box info">
      <span class="ib-icon">&#x2139;&#xFE0F;</span>
      <div><strong>Scope:</strong> {{SCOPE_NOTES}}</div>
    </div>
  </div>
</div>

<!-- 2. TRIGGER -->
<div class="section" id="trigger">
  <h2 class="section-title"><span class="icon">&#x1F4A1;</span> 2. When to Use This Skill</h2>
  <div class="card">
    <div class="card-header">&#x1F4AC; Trigger Phrases</div>
    <p>Use this skill when Kevin or the team says any of the following:</p>
    <ul>
      {{TRIGGER_PHRASES_LIST}}
    </ul>
    <div class="info-box warn">
      <span class="ib-icon">&#x26A0;&#xFE0F;</span>
      <div><strong>Do not use this skill when:</strong> {{DO_NOT_USE}}</div>
    </div>
  </div>
</div>

<!-- 3. INPUTS -->
<div class="section" id="inputs">
  <h2 class="section-title"><span class="icon">&#x1F4E5;</span> 3. Required Inputs</h2>
  <div class="card">
    <table class="label-table">
      <thead>
        <tr>
          <th>Input</th>
          <th>Required</th>
          <th>Description</th>
          <th>Example</th>
        </tr>
      </thead>
      <tbody>
        {{INPUTS_TABLE_ROWS}}
      </tbody>
    </table>
  </div>
</div>

<!-- 4. WORKFLOW -->
<div class="section" id="workflow">
  <h2 class="section-title"><span class="icon">&#x1F504;</span> 4. Step-by-Step Workflow</h2>

  <div class="card">
    <div class="card-header">&#x1F5FA; Process Flow</div>
    <div class="flow">
      {{FLOW_STEPS_HTML}}
    </div>
  </div>

  {{WORKFLOW_CARDS_HTML}}

</div>

<!-- 5. TOOLS & INTEGRATIONS -->
<div class="section" id="tools">
  <h2 class="section-title"><span class="icon">&#x1F527;</span> 5. Tools &amp; Integrations</h2>
  <div class="card">
    <table class="label-table">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Purpose</th>
          <th>Access</th>
        </tr>
      </thead>
      <tbody>
        {{TOOLS_TABLE_ROWS}}
      </tbody>
    </table>
  </div>
</div>

<!-- 6. APPROVAL GATES -->
<div class="section" id="approval">
  <h2 class="section-title"><span class="icon">&#x2705;</span> 6. Approval Gates</h2>
  <div class="card">
    {{APPROVAL_GATES_CONTENT}}
  </div>
</div>

<!-- 7. OUTPUTS -->
<div class="section" id="outputs">
  <h2 class="section-title"><span class="icon">&#x1F4E4;</span> 7. Outputs &amp; Confirmations</h2>
  <div class="card">
    <table class="label-table">
      <thead>
        <tr>
          <th>Output</th>
          <th>Where</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {{OUTPUTS_TABLE_ROWS}}
      </tbody>
    </table>
  </div>
</div>

<!-- 8. ERROR HANDLING -->
<div class="section" id="errors">
  <h2 class="section-title"><span class="icon">&#x1F6A8;</span> 8. Error Handling</h2>
  <div class="card">
    {{ERROR_HANDLING_CONTENT}}
  </div>
</div>

<!-- 9. TROUBLESHOOTING -->
<div class="section" id="troubleshooting">
  <h2 class="section-title"><span class="icon">&#x1F6E0;&#xFE0F;</span> 9. Troubleshooting</h2>
  <div class="card">
    {{TROUBLESHOOTING_ITEMS}}
  </div>
</div>

<!-- 10. CHANGELOG -->
<div class="section" id="changelog">
  <h2 class="section-title"><span class="icon">&#x1F4DD;</span> 10. Changelog</h2>
  <div class="card">
    <table class="label-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Date</th>
          <th>Changes</th>
        </tr>
      </thead>
      <tbody>
        {{CHANGELOG_ROWS}}
      </tbody>
    </table>
  </div>
</div>

</div>
</body>
</html>
\`\`\``,
    },
    {
        id: 'skill-creator',
        name: 'Skill Creator',
        command: 'anthropic-skills:skill-creator',
        description: 'Create new skills, modify and improve existing skills, and measure skill performance. Includes eval benchmarking and description optimisation for trigger accuracy.',
        category: 'Development',
        source: 'preset',
        tags: ['skill', 'creation', 'development', 'eval'],
        instructions: `---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

A skill for creating new skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts and run claude-with-access-to-the-skill on them
- Help the user evaluate the results both qualitatively and quantitatively
  - While the runs happen in the background, draft some quantitative evals if there aren't any (if there are some, you can either use as is or modify if you feel something needs to change about them). Then explain them to the user (or if they already existed, explain the ones that already exist)
  - Use the \`eval-viewer/generate_review.py\` script to show the user the results for them to look at, and also let them look at the quantitative metrics
- Rewrite the skill based on feedback from the user's evaluation of the results (and also if there are any glaring flaws that become apparent from the quantitative benchmarks)
- Repeat until you're satisfied
- Expand the test set and try again at larger scale

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. So for instance, maybe they're like "I want to make a skill for X". You can help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat.

On the other hand, maybe they already have a draft of the skill. In this case you can go straight to the eval/iterate part of the loop.

Of course, you should always be flexible and if the user is like "I don't need to run a bunch of evaluations, just vibe with me", you can do that instead.

Then after the skill is done (but again, the order is flexible), you can also run the skill description improver, which we have a whole separate script for, to optimize the triggering of the skill.

Cool? Cool.

## Communicating with the user

The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. If you haven't heard (and how could you, it's only very recently that it started), there's a trend now where the power of Claude is inspiring plumbers to open up their terminals, parents and grandparents to google "how to install npm". On the other hand, the bulk of users are probably fairly computer-literate.

So please pay attention to context cues to understand how to phrase your communication! In the default case, just to give you some idea:

- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them

It's OK to briefly explain terms if you're in doubt, and feel free to clarify terms with a short definition if you're unsure if the user will get it.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first — the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.

1. What should this skill enable Claude to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases to verify the skill works? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from test cases. Skills with subjective outputs (writing style, art) often don't need them. Suggest the appropriate default based on the skill type, but let the user decide.

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

Check available MCPs - if useful for research (searching docs, finding similar skills, looking up best practices), research in parallel via subagents if available, otherwise inline. Come prepared with context to reduce burden on the user.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Skill identifier
- **description**: When to trigger, what it does. This is the primary triggering mechanism - include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. Note: currently Claude has a tendency to "undertrigger" skills -- to not use them when they'd be useful. To combat this, please make the skill descriptions a little bit "pushy". So for instance, instead of "How to build a simple fast dashboard to display internal Anthropic data.", you might write "How to build a simple fast dashboard to display internal Anthropic data. Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a 'dashboard.'"
- **compatibility**: Required tools, dependencies (optional, rarely needed)
- **the rest of the skill :)**

### Skill Writing Guide

#### Anatomy of a Skill

\`\`\`
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
\`\`\`

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)

These word counts are approximate and you can feel free to go longer if needed.

**Key patterns:**
- Keep SKILL.md under 500 lines; if you're approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model using the skill should go next to follow up.
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

**Domain organization**: When a skill supports multiple domains/frameworks, organize by variant:
\`\`\`
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
\`\`\`
Claude reads only the relevant reference file.

#### Principle of Lack of Surprise

This goes without saying, but skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** - You can do it like this:
\`\`\`markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
\`\`\`

**Examples pattern** - It's useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):
\`\`\`markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
\`\`\`

### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.

### Test Cases

After writing the skill draft, come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: [you don't have to use this exact language] "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save test cases to \`evals/evals.json\`. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

\`\`\`json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
\`\`\`

See \`references/schemas.md\` for the full schema (including the \`assertions\` field, which you'll add later).

## Running and evaluating test cases

This section is one continuous sequence — don't stop partway through. Do NOT use \`/skill-test\` or any other testing skill.

Put results in \`<skill-name>-workspace/\` as a sibling to the skill directory. Within the workspace, organize results by iteration (\`iteration-1/\`, \`iteration-2/\`, etc.) and within that, each test case gets a directory (\`eval-0/\`, \`eval-1/\`, etc.). Don't create all of this upfront — just create directories as you go.

### Step 1: Spawn all runs (with-skill AND baseline) in the same turn

For each test case, spawn two subagents in the same turn — one with the skill, one without. This is important: don't spawn the with-skill runs first and then come back for baselines later. Launch everything at once so it all finishes around the same time.

**With-skill run:**

\`\`\`
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
\`\`\`

**Baseline run** (same prompt, but the baseline depends on context):
- **Creating a new skill**: no skill at all. Same prompt, no skill path, save to \`without_skill/outputs/\`.
- **Improving an existing skill**: the old version. Before editing, snapshot the skill (\`cp -r <skill-path> <workspace>/skill-snapshot/\`), then point the baseline subagent at the snapshot. Save to \`old_skill/outputs/\`.

Write an \`eval_metadata.json\` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it's testing — not just "eval-0". Use this name for the directory too. If this iteration uses new or modified eval prompts, create these files for each new eval directory — don't assume they carry over from previous iterations.

\`\`\`json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
\`\`\`

### Step 2: While runs are in progress, draft assertions

Don't just wait for the runs to finish — you can use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in \`evals/evals.json\`, review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update the \`eval_metadata.json\` files and \`evals/evals.json\` with the assertions once drafted. Also explain to the user what they'll see in the viewer — both the qualitative outputs and the quantitative benchmark.

### Step 3: As runs complete, capture timing data

When each subagent task completes, you receive a notification containing \`total_tokens\` and \`duration_ms\`. Save this data immediately to \`timing.json\` in the run directory:

\`\`\`json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
\`\`\`

This is the only opportunity to capture this data — it comes through the task notification and isn't persisted elsewhere. Process each notification as it arrives rather than trying to batch them.

### Step 4: Grade, aggregate, and launch the viewer

Once all runs are done:

1. **Grade each run** — spawn a grader subagent (or grade inline) that reads \`agents/grader.md\` and evaluates each assertion against the outputs. Save results to \`grading.json\` in each run directory. The grading.json expectations array must use the fields \`text\`, \`passed\`, and \`evidence\` (not \`name\`/\`met\`/\`details\` or other variants) — the viewer depends on these exact field names. For assertions that can be checked programmatically, write and run a script rather than eyeballing it — scripts are faster, more reliable, and can be reused across iterations.

2. **Aggregate into benchmark** — run the aggregation script from the skill-creator directory:
   \`\`\`bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   \`\`\`
   This produces \`benchmark.json\` and \`benchmark.md\` with pass_rate, time, and tokens for each configuration, with mean ± stddev and the delta. If generating benchmark.json manually, see \`references/schemas.md\` for the exact schema the viewer expects.
Put each with_skill version before its baseline counterpart.

3. **Do an analyst pass** — read the benchmark data and surface patterns the aggregate stats might hide. See \`agents/analyzer.md\` (the "Analyzing Benchmark Results" section) for what to look for — things like assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs.

4. **Launch the viewer** with both qualitative outputs and quantitative data:
   \`\`\`bash
   nohup python <skill-creator-path>/eval-viewer/generate_review.py \\
     <workspace>/iteration-N \\
     --skill-name "my-skill" \\
     --benchmark <workspace>/iteration-N/benchmark.json \\
     > /dev/null 2>&1 &
   VIEWER_PID=\$!
   \`\`\`
   For iteration 2+, also pass \`--previous-workspace <workspace>/iteration-<N-1>\`.

   **Cowork / headless environments:** If \`webbrowser.open()\` is not available or the environment has no display, use \`--static <output_path>\` to write a standalone HTML file instead of starting a server. Feedback will be downloaded as a \`feedback.json\` file when the user clicks "Submit All Reviews". After download, copy \`feedback.json\` into the workspace directory for the next iteration to pick up.

Note: please use generate_review.py to create the viewer; there's no need to write custom HTML.

5. **Tell the user** something like: "I've opened the results in your browser. There are two tabs — 'Outputs' lets you click through each test case and leave feedback, 'Benchmark' shows the quantitative comparison. When you're done, come back here and let me know."

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time:
- **Prompt**: the task that was given
- **Output**: the files the skill produced, rendered inline where possible
- **Previous Output** (iteration 2+): collapsed section showing last iteration's output
- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail
- **Feedback**: a textbox that auto-saves as they type
- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox

The "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.

Navigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to \`feedback.json\`.

### Step 5: Read the feedback

When the user tells you they're done, read \`feedback.json\`:

\`\`\`json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
\`\`\`

Empty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.

Kill the viewer server when you're done with it:

\`\`\`bash
kill \$VIEWER_PID 2>/dev/null
\`\`\`

---

## Improving the skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to think about improvements

1. **Generalize from the feedback.** The big picture thing that's happening here is that we're trying to create skills that can be used a million times (maybe literally, maybe even more who knows) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it's quick for them to assess new outputs. But if the skill you and the user are codeveloping works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

2. **Keep the prompt lean.** Remove things that aren't pulling their weight. Make sure to read the transcripts, not just the final outputs — if it looks like the skill is making the model waste a bunch of time doing things that are unproductive, you can try getting rid of the parts of the skill that are making it do that and seeing what happens.

3. **Explain the why.** Try hard to explain the **why** behind everything you're asking the model to do. Today's LLMs are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

4. **Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the subagents all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in the subagent writing a \`create_docx.py\` or a \`build_chart.py\`, that's a strong signal the skill should bundle that script. Write it once, put it in \`scripts/\`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.

This task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I'd suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.

### The iteration loop

After improving the skill:

1. Apply your improvements to the skill
2. Rerun all test cases into a new \`iteration-<N+1>/\` directory, including baseline runs. If you're creating a new skill, the baseline is always \`without_skill\` (no skill) — that stays the same across iterations. If you're improving an existing skill, use your judgment on what makes sense as the baseline: the original version the user came in with, or the previous iteration.
3. Launch the reviewer with \`--previous-workspace\` pointing at the previous iteration
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Advanced: Blind comparison

For situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there's a blind comparison system. Read \`agents/comparator.md\` and \`agents/analyzer.md\` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.

This is optional, requires subagents, and most users won't need it. The human review loop is usually sufficient.

---

## Description Optimization

The description field in SKILL.md frontmatter is the primary mechanism that determines whether Claude invokes a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy.

### Step 1: Generate trigger eval queries

Create 20 eval queries — a mix of should-trigger and should-not-trigger. Save as JSON:

\`\`\`json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
\`\`\`

The queries must be realistic and something a Claude Code or Claude.ai user would actually type. Not abstract requests, but requests that are concrete and specific and have a good amount of detail. For instance, file paths, personal context about the user's job or situation, column names and values, company names, URLs. A little bit of backstory. Some might be in lowercase or contain abbreviations or typos or casual speech. Use a mix of different lengths, and focus on edge cases rather than making them clear-cut (the user will get a chance to sign off on them).

Bad: \`"Format this data"\`, \`"Extract text from PDF"\`, \`"Create a chart"\`

Good: \`"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"\`

For the **should-trigger** queries (8-10), think about coverage. You want different phrasings of the same intent — some formal, some casual. Include cases where the user doesn't explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.

For the **should-not-trigger** queries (8-10), the most valuable ones are the near-misses — queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn't, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.

The key thing to avoid: don't make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy — it doesn't test anything. The negative cases should be genuinely tricky.

### Step 2: Review with user

Present the eval set to the user for review using the HTML template:

1. Read the template from \`assets/eval_review.html\`
2. Replace the placeholders:
   - \`__EVAL_DATA_PLACEHOLDER__\` → the JSON array of eval items (no quotes around it — it's a JS variable assignment)
   - \`__SKILL_NAME_PLACEHOLDER__\` → the skill's name
   - \`__SKILL_DESCRIPTION_PLACEHOLDER__\` → the skill's current description
3. Write to a temp file (e.g., \`/tmp/eval_review_<skill-name>.html\`) and open it: \`open /tmp/eval_review_<skill-name>.html\`
4. The user can edit queries, toggle should-trigger, add/remove entries, then click "Export Eval Set"
5. The file downloads to \`~/Downloads/eval_set.json\` — check the Downloads folder for the most recent version in case there are multiple (e.g., \`eval_set (1).json\`)

This step matters — bad eval queries lead to bad descriptions.

### Step 3: Run the optimization loop

Tell the user: "This will take some time — I'll run the optimization loop in the background and check on it periodically."

Save the eval set to the workspace, then run in the background:

\`\`\`bash
python -m scripts.run_loop \\
  --eval-set <path-to-trigger-eval.json> \\
  --skill-path <path-to-skill> \\
  --model <model-id-powering-this-session> \\
  --max-iterations 5 \\
  --verbose
\`\`\`

Use the model ID from your system prompt (the one powering the current session) so the triggering test matches what the user actually experiences.

While it runs, periodically tail the output to give the user updates on which iteration it's on and what the scores look like.

This handles the full optimization loop automatically. It splits the eval set into 60% train and 40% held-out test, evaluates the current description (running each query 3 times to get a reliable trigger rate), then calls Claude to propose improvements based on what failed. It re-evaluates each new description on both train and test, iterating up to 5 times. When it's done, it opens an HTML report in the browser showing the results per iteration and returns JSON with \`best_description\` — selected by test score rather than train score to avoid overfitting.

### How skill triggering works

Understanding the triggering mechanism helps design better eval queries. Skills appear in Claude's \`available_skills\` list with their name + description, and Claude decides whether to consult a skill based on that description. The important thing to know is that Claude only consults skills for tasks it can't easily handle on its own — simple, one-step queries like "read this PDF" may not trigger a skill even if the description matches perfectly, because Claude can handle them directly with basic tools. Complex, multi-step, or specialized queries reliably trigger skills when the description matches.

This means your eval queries should be substantive enough that Claude would actually benefit from consulting a skill. Simple queries like "read file X" are poor test cases — they won't trigger skills regardless of description quality.

### Step 4: Apply the result

Take \`best_description\` from the JSON output and update the skill's SKILL.md frontmatter. Show the user before/after and report the scores.

---

### Package and Present (only if \`present_files\` tool is available)

Check whether you have access to the \`present_files\` tool. If you don't, skip this step. If you do, package the skill and present the .skill file to the user:

\`\`\`bash
python -m scripts.package_skill <path/to/skill-folder>
\`\`\`

After packaging, direct the user to the resulting \`.skill\` file path so they can install it.

---

## Claude.ai-specific instructions

In Claude.ai, the core workflow is the same (draft → test → review → improve → repeat), but because Claude.ai doesn't have subagents, some mechanics change. Here's what to adapt:

**Running test cases**: No subagents means no parallel execution. For each test case, read the skill's SKILL.md, then follow its instructions to accomplish the test prompt yourself. Do them one at a time. This is less rigorous than independent subagents (you wrote the skill and you're also running it, so you have full context), but it's a useful sanity check — and the human review step compensates. Skip the baseline runs — just use the skill to complete the task as requested.

**Reviewing results**: If you can't open a browser (e.g., Claude.ai's VM has no display, or you're on a remote server), skip the browser reviewer entirely. Instead, present results directly in the conversation. For each test case, show the prompt and the output. If the output is a file the user needs to see (like a .docx or .xlsx), save it to the filesystem and tell them where it is so they can download and inspect it. Ask for feedback inline: "How does this look? Anything you'd change?"

**Benchmarking**: Skip the quantitative benchmarking — it relies on baseline comparisons which aren't meaningful without subagents. Focus on qualitative feedback from the user.

**The iteration loop**: Same as before — improve the skill, rerun the test cases, ask for feedback — just without the browser reviewer in the middle. You can still organize results into iteration directories on the filesystem if you have one.

**Description optimization**: This section requires the \`claude\` CLI tool (specifically \`claude -p\`) which is only available in Claude Code. Skip it if you're on Claude.ai.

**Blind comparison**: Requires subagents. Skip it.

**Packaging**: The \`package_skill.py\` script works anywhere with Python and a filesystem. On Claude.ai, you can run it and the user can download the resulting \`.skill\` file.

**Updating an existing skill**: The user might be asking you to update an existing skill, not create a new one. In this case:
- **Preserve the original name.** Note the skill's directory name and \`name\` frontmatter field -- use them unchanged. E.g., if the installed skill is \`research-helper\`, output \`research-helper.skill\` (not \`research-helper-v2\`).
- **Copy to a writeable location before editing.** The installed skill path may be read-only. Copy to \`/tmp/skill-name/\`, edit there, and package from the copy.
- **If packaging manually, stage in \`/tmp/\` first**, then copy to the output directory -- direct writes may fail due to permissions.

---

## Cowork-Specific Instructions

If you're in Cowork, the main things to know are:

- You have subagents, so the main workflow (spawn test cases in parallel, run baselines, grade, etc.) all works. (However, if you run into severe problems with timeouts, it's OK to run the test prompts in series rather than parallel.)
- You don't have a browser or display, so when generating the eval viewer, use \`--static <output_path>\` to write a standalone HTML file instead of starting a server. Then proffer a link that the user can click to open the HTML in their browser.
- For whatever reason, the Cowork setup seems to disincline Claude from generating the eval viewer after running the tests, so just to reiterate: whether you're in Cowork or in Claude Code, after running tests, you should always generate the eval viewer for the human to look at examples before revising the skill yourself and trying to make corrections, using \`generate_review.py\` (not writing your own boutique html code). Sorry in advance but I'm gonna go all caps here: GENERATE THE EVAL VIEWER *BEFORE* evaluating inputs yourself. You want to get them in front of the human ASAP!
- Feedback works differently: since there's no running server, the viewer's "Submit All Reviews" button will download \`feedback.json\` as a file. You can then read it from there (you may have to request access first).
- Packaging works — \`package_skill.py\` just needs Python and a filesystem.
- Description optimization (\`run_loop.py\` / \`run_eval.py\`) should work in Cowork just fine since it uses \`claude -p\` via subprocess, not a browser, but please save it until you've fully finished making the skill and the user agrees it's in good shape.
- **Updating an existing skill**: The user might be asking you to update an existing skill, not create a new one. Follow the update guidance in the claude.ai section above.

---

## Reference files

The agents/ directory contains instructions for specialized subagents. Read them when you need to spawn the relevant subagent.

- \`agents/grader.md\` — How to evaluate assertions against outputs
- \`agents/comparator.md\` — How to do blind A/B comparison between two outputs
- \`agents/analyzer.md\` — How to analyze why one version beat another

The references/ directory has additional documentation:
- \`references/schemas.md\` — JSON structures for evals.json, grading.json, etc.

---

Repeating one more time the core loop here for emphasis:

- Figure out what the skill is about
- Draft or edit the skill
- Run claude-with-access-to-the-skill on test prompts
- With the user, evaluate the outputs:
  - Create benchmark.json and run \`eval-viewer/generate_review.py\` to help the user review them
  - Run quantitative evals
- Repeat until you and the user are satisfied
- Package the final skill and return it to the user.

Please add steps to your TodoList, if you have such a thing, to make sure you don't forget. If you're in Cowork, please specifically put "Create evals JSON and run \`eval-viewer/generate_review.py\` so human can review test cases" in your TodoList to make sure it happens.

Good luck!
`,
    },
    {
        id: 'skill-creator-from-manus',
        name: 'Skill Creator (from Manus)',
        command: 'anthropic-skills:skill-creator-from-manus',
        description: 'Guide for creating or updating Claude Code skills based on Manus workflow patterns — converts Manus-style automation into Claude Code skill format.',
        category: 'Development',
        source: 'preset',
        tags: ['skill', 'Manus', 'conversion', 'migration'],
        instructions: `---
name: skill-creator-from-manus
description: Guide for creating or updating skills that extend Manus via specialized knowledge, workflows, or tool integrations. For any modification or improvement request, MUST first read this skill and follow its update workflow instead of editing files directly.
license: Complete terms in LICENSE.txt
---

# Skill Creator from Manus

> ⚠️ **SKILLS LIBRARY SYNC — READ FOR EVERY SKILL CHANGE**
>
> The leadership-dashboard web app shows a Skills Library populated from
> \`js/skills-data.js\`. Every time you **add**, **rename**, **rewrite the
> description of**, or **retire** a skill, you MUST also update that
> file. Without this the dashboard's Skills Library drifts from reality
> — users see skills that no longer exist, or miss skills they could
> use.
>
> **When CREATING a skill:** append a new entry to \`SKILLS_LIBRARY\` in
> \`~/Projects/leadership-dashboard/js/skills-data.js\` with id, name,
> command, description, category, source, tags. Keep the description
> aligned with the SKILL.md frontmatter description.
>
> **When RENAMING a skill or RECONFIGURING ITS DESCRIPTION:** find the
> existing entry by \`id\` and update the affected fields. The id should
> stay stable (it's used as a key elsewhere); rename the \`name\` /
> \`command\` / \`description\` instead.
>
> **When RETIRING a skill:** remove the entry from \`SKILLS_LIBRARY\`
> entirely.
>
> **Always commit + push** the \`skills-data.js\` change in the same
> commit as the skill change. The dashboard auto-deploys via Pages
> within ~2 min of the push.

This skill provides guidance for creating effective skills.

## About Skills

Skills are modular, self-contained packages that extend Manus's capabilities by providing specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific domains or tasks—they transform Manus from a general-purpose agent into a specialized agent equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share the context window with everything else Manus needs: system prompt, conversation history, other Skills' metadata, and the actual user request.

**Default assumption: Manus is already very smart.** Only add context Manus doesn't already have. Challenge each piece of information: "Does Manus really need this explanation?" and "Does this paragraph justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match the level of specificity to the task's fragility and variability:

**High freedom (text-based instructions)**: Use when multiple approaches are valid, decisions depend on context, or heuristics guide the approach.

**Medium freedom (pseudocode or scripts with parameters)**: Use when a preferred pattern exists, some variation is acceptable, or configuration affects behavior.

**Low freedom (specific scripts, few parameters)**: Use when operations are fragile and error-prone, consistency is critical, or a specific sequence must be followed.

Think of Manus as exploring a path: a narrow bridge with cliffs needs specific guardrails (low freedom), while an open field allows many routes (high freedom).

### Anatomy of a Skill

Every skill consists of a required SKILL.md file and optional bundled resources:

\`\`\`
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter metadata (required)
│   │   ├── name: (required)
│   │   └── description: (required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation intended to be loaded into context as needed
    └── templates/        - Files used in output (templates, icons, fonts, etc.)
\`\`\`

#### SKILL.md (required)

Every SKILL.md consists of:

- **Frontmatter** (YAML): Contains \`name\` and \`description\` fields. These are the only fields that Manus reads to determine when the skill gets used, thus it is very important to be clear and comprehensive in describing what the skill is, and when it should be used.
- **Body** (Markdown): Instructions and guidance for using the skill. Only loaded AFTER the skill triggers (if at all).

#### Bundled Resources (optional)

- **\`scripts/\`** - Executable code for repetitive or deterministic tasks (e.g., \`rotate_pdf.py\`). Token efficient, can run without loading into context.
- **\`references/\`** - Documentation loaded as needed (schemas, API docs, policies). Keeps SKILL.md lean. For large files (>10k words), include grep patterns in SKILL.md.
- **\`templates/\`** - Output assets not loaded into context (logos, fonts, boilerplate code).

**Avoid duplication**: Information lives in SKILL.md OR references, not both.

**Do NOT include**: README.md, CHANGELOG.md, or other auxiliary documentation. Skills are for AI agents, not users.

### Progressive Disclosure

Three-level loading system:
1. **Metadata** - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<500 lines)
3. **Bundled resources** - As needed

Keep SKILL.md under 500 lines. When splitting content to references, clearly describe when to read them.

**Key principle:** Keep core workflow in SKILL.md; move variant-specific details to reference files.

Example structure for multi-domain skills:

\`\`\`
bigquery-skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
\`\`\`

Manus only loads the relevant reference file when needed.

## Skill Creation Process

Skill creation involves these steps:

1. Understand the skill with concrete examples
2. Plan reusable skill contents (scripts, references, templates)
3. Initialize the skill (run init_skill.py)
4. Edit the skill (implement resources and write SKILL.md)
5. Deliver the skill (send SKILL.md path via notify_user)
6. Iterate based on real usage

Follow these steps in order, skipping only if there is a clear reason why they are not applicable.

### Step 1: Understanding the Skill with Concrete Examples

Skip this step only when the skill's usage patterns are already clearly understood.

Gather concrete examples of how the skill will be used. Ask questions like:
- "What functionality should this skill support?"
- "Can you give examples of how it would be used?"

Avoid asking too many questions at once. Conclude when you have a clear sense of the functionality.

### Step 2: Planning the Reusable Skill Contents

For each example, identify reusable resources:

| Resource Type | When to Use                     | Example                               |
| ------------- | ------------------------------- | ------------------------------------- |
| \`scripts/\`    | Code rewritten repeatedly       | \`rotate_pdf.py\` for PDF rotation      |
| \`templates/\`  | Same boilerplate each time      | HTML/React starter for webapp builder |
| \`references/\` | Documentation needed repeatedly | Database schemas for BigQuery skill   |

### Step 3: Initializing the Skill

At this point, it is time to actually create the skill.

Skip this step only if the skill being developed already exists, and iteration or packaging is needed. In this case, continue to the next step.

When creating a new skill from scratch, always run the \`init_skill.py\` script. The script conveniently generates a new template skill directory that automatically includes everything a skill requires, making the skill creation process much more efficient and reliable.

Usage:

\`\`\`bash
python /home/ubuntu/skills/skill-creator-from-manus/scripts/init_skill.py <skill-name>
\`\`\`

The script:

- Creates the skill directory at \`/home/ubuntu/skills/<skill-name>/\`
- Generates a SKILL.md template with proper frontmatter and TODO placeholders
- Creates example resource directories: \`scripts/\`, \`references/\`, and \`templates/\`
- Adds example files in each directory that can be customized or deleted

After initialization, customize or remove the generated SKILL.md and example files as needed.

### Step 4: Edit the Skill

When editing the (newly-generated or existing) skill, remember that the skill is being created for another instance of Manus to use. Include information that would be beneficial and non-obvious to Manus. Consider what procedural knowledge, domain-specific details, or reusable assets would help another Manus instance execute these tasks more effectively.

#### Learn Proven Design Patterns

Consult these helpful guides based on your skill's needs:

- **Multi-step processes**: See \`/home/ubuntu/skills/skill-creator-from-manus/references/workflows.md\` for sequential workflows and conditional logic
- **Output formats or quality standards**: See \`/home/ubuntu/skills/skill-creator-from-manus/references/output-patterns.md\` for template and example patterns
- **Progressive Disclosure Patterns**: See \`/home/ubuntu/skills/skill-creator-from-manus/references/progressive-disclosure-patterns.md\` for splitting content across files.

These files contain established best practices for effective skill design.

#### Start with Reusable Skill Contents

Begin with the \`scripts/\`, \`references/\`, and \`templates/\` files identified in Step 2. This may require user input (e.g., brand assets for \`templates/\`, documentation for \`references/\`).

Test added scripts by running them to ensure they work correctly. For many similar scripts, test a representative sample.

Delete any unused example files from initialization.

#### Update SKILL.md

**Writing Guidelines:** Always use imperative/infinitive form.

##### Frontmatter

Write the YAML frontmatter with \`name\` and \`description\`:

- \`name\`: The skill name
- \`description\`: Primary trigger mechanism. Must include what the skill does AND when to use it (body only loads after triggering).
  - Example: "Document creation and editing with tracked changes. Use for: creating .docx files, modifying content, working with tracked changes."

##### Body

Write instructions for using the skill and its bundled resources.

### Step 5: Delivering the Skill

Once development of the skill is complete, validate and deliver it to the user.

#### Validate the Skill

Run the validation script to ensure the skill meets all requirements:

\`\`\`bash
python /home/ubuntu/skills/skill-creator-from-manus/scripts/quick_validate.py <skill-name>
\`\`\`

If validation fails, fix the errors and run validation again.

#### Deliver to User

Use \`message\` tool to send the SKILL.md file as attachment:

\`\`\`
/home/ubuntu/skills/{skill-name}/SKILL.md
\`\`\`

The system will automatically:

1. Detect the path pattern \`/home/ubuntu/skills/*/SKILL.md\`
2. Package the skill directory into a \`.skill\` file
3. Send to frontend as a special card with options:
   - Add to My Skills
   - Download
   - Preview

### Step 5.5: Generate the SOP

Immediately after delivering a **new** skill (not an iteration), run the sop-generator skill automatically. Do not wait for Kevin to ask.

Read \`/mnt/skills/user/sop-generator/SKILL.md\` and follow it in full for the newly created skill. This produces the HTML and JSON files for upload to the \`sops/\` GitHub folder.

Skip this step only when updating an existing skill where no significant workflow changes have been made.

### Step 6: Iterate

After testing the skill, users may request improvements. Often this happens right after using the skill, with fresh context of how the skill performed.

**Iteration workflow:**

1. Use the skill on real tasks
2. Notice struggles or inefficiencies
3. Identify how SKILL.md or bundled resources should be updated
4. Implement changes and test again
`,
    },
    {
        id: 'setup-cowork',
        name: 'Setup Cowork',
        command: 'anthropic-skills:setup-cowork',
        description: 'Guided Cowork setup — installs role-matched plugins, connects your tools, and walks you through trying a first skill.',
        category: 'Development',
        source: 'preset',
        tags: ['setup', 'cowork', 'onboarding', 'plugins'],
        instructions: `---
name: setup-cowork
description: "Guided Cowork setup — install role-matched plugins, connect your tools, try a skill."
---

# Setup Cowork

Help the user get Cowork configured for their work. Five steps — role, plugins, connectors, try a skill, wrap.

## Step 0 — Checklist

Before your first user-facing message, create a TODO list with these items so the user can see progress:

1. Figure out role
2. Suggest plugins
3. Suggest connectors
4. Try a skill
5. Wrap up

Mark each one complete as you finish it. Keep it to these five — don't add sub-items.

## Step 1 — Role

Your initial message should frame what Cowork is: it autonomously handles tasks like reading your email, searching your docs, drafting reports, etc. Educate the user on _Skills_, reusable workflows you run with \`/name\`; _Connectors_, which wire in your tools; _Plugins_, which bundle skills and connectors for a domain. Two or three sentences. Hit the beats: multi-step and autonomous, uses your real tools, skills/plugins/connectors defined.

**Check memory first.** If your memory already records the user's role or job function, don't ask — state it back: "Looks like you do [role] work — I'll set things up for that." Then skip straight to Step 2.

If memory has nothing, ask: "Let's get you set up — takes a few minutes. What kind of work do you do?" Then call the tool to show the onboarding role picker, which displays roles for the user to click. Do not list the roles yourself.

## Step 2 — Suggest plugins

The role picker tool result will contain their selection. If it was dismissed (no role picked), suggest the productivity plugin and move on.

**Always** check for already-installed plugins before doing anything else — this is not optional. Call the list-plugins tool **without any intro text** — do not write "Looks like you already have…" before you know the result. The tool renders the installed plugins as a widget on its own; let it speak for itself. After it returns, react to what actually came back: if plugins appeared, acknowledge them below the widget ("Those are already on your account — here's what else fits your role."); if it's empty, just say "No plugins yet — let's fix that." Never write text that presumes a non-empty result before the tool runs. Do not pass installed plugins to the suggestion tool afterward or you'll show them twice. Admin-provisioned plugins will appear in this list automatically; never skip the call. Then, regardless of what's installed, still recommend new role-matched plugins below in a separate widget.

Search the plugin marketplace for their role. **Exclude anything already installed** — the installed-plugins widget above already covers those, so the recommendations widget must only contain plugins the user does not yet have. Never show the same plugin in both widgets. **Organization plugins always come first.** If the user's org has published its own plugins, those are the recommendation — they're built for this company's actual tools, data, and workflows, and someone internal decided they matter. An org-built plugin that's even loosely relevant to the role outranks any generic marketplace plugin, full stop. Lead with org plugins, and only reach for generic ones to fill empty slots when the org catalog has nothing close. Never bury an org plugin under a generic one. Hold on to the result: you'll need each plugin's \`skills\` and \`mcpServerNames\` later.

Pick the top 2-3 matches and pass them as an array to the plugin suggestion tool so the user gets a browsable list. If only one is a strong fit, passing one is fine. If the search comes up empty, fall back to the productivity plugin. If every good match is already installed, skip the recommendations widget entirely and just say "You've already got the best plugin for [role] — let's move on to connectors."

Above the widget, introduce it in one line: "Here are plugins built for [role] work — each one adds a set of skills you can run with \`/\`." The card shows Add or Manage depending on whether each plugin is already installed — don't describe the button. Below the widget, reinforce what they're for and tie it to the next step: "Installing one drops its skills straight into your \`/\` menu so you can run them anytime. Once you've picked one, want me to pull up the connectors it uses so those skills have your real data behind them?" — phrased so it works whether they're installing fresh or already have it. End your turn.

## Step 3 — Connectors

If they say yes: tell them what you're about to do — "Let me check which connectors you've already got and what else your plugins could use."

Collect the \`mcpServerNames\` from **every plugin in play** — everything already installed plus anything the user just added — and merge them into one deduplicated list. Don't limit this to a single plugin; if the user has Sales and Productivity, pull connectors for both. Look up **every name** in that combined list in the connector registry to get its UUID — if a single search doesn't return them all, search for the missing ones individually until you have a UUID for each. Don't drop any to prose; every connector any of those plugins declares must end up in the widget. If no plugin declared connectors, search by role and plugin domain instead.

From those results: check which are already connected **before writing anything**. Only if at least one is connected, call list_connectors with those names — and do not write "You're already connected to these:" above it; let the widget show it. If none are connected, skip list_connectors entirely. Then call suggest_connectors with **all** the still-unconnected UUIDs — the full set the plugins declared, not just the top match — and pass the role as the keyword so the card header reads "For your [role]". Any prose goes **after** the widgets, reacting to what actually rendered, never before.

Below the suggestions, explain what they're looking at before moving on: "Click any of these to connect it — once wired up, skills can pull your real data from it. Want me to list some skills you can try?" End your turn.

## Step 4 — Try a skill

If they say yes, call list_skills with the plugin's skill names and a context_label like "[Plugin] skills" so they get clickable Try-it cards. Introduce the card in one line so it doesn't land cold: "Here's what [Plugin] adds — click any of these to run it now." End your turn.

When they click one (you'll see a \`/name\` message), help them with it. Keep it brief; you're still inside setup. When it finishes, bring it back: "Nice — that's how skills work."

If they wave it off at either point, that's fine — go to Step 5.

## Step 5 — Wrap

Close short: "You're set. Start a new task from the sidebar anytime, or type \`/\` to see your skills."

## Ground rules

- One step at a time.
- Skips are fine. If they pass on a step, mark its TODO done and move on.
- Keep each message short. Two or three sentences plus the widget, not a wall.
- Never write text that presumes a tool result before the tool runs. Don't say "you already have…" or "you're connected to…" above a widget — call the tool first, then react to what came back below it. The widget shows the data; your sentence reacts to it.
- The user trying a skill mid-flow is expected. Help with it, then return to where you left off. Don't let a skill invocation end the setup.
`,
    },
    {
        id: 'create-cowork-plugin',
        name: 'Create Cowork Plugin',
        command: 'cowork-plugin-management:create-cowork-plugin',
        description: 'Guide for creating a new plugin from scratch in a cowork session — scaffolds the plugin structure, defines skills, and produces a .plugin file.',
        category: 'Development',
        source: 'preset',
        tags: ['plugin', 'creation', 'cowork', 'scaffold']
    },
    {
        id: 'cowork-plugin-customizer',
        name: 'Plugin Customiser',
        command: 'cowork-plugin-management:cowork-plugin-customizer',
        description: 'Customise a Claude Code plugin for your organisation — adjust skill parameters, configure connectors, and tailor workflows to your tools.',
        category: 'Development',
        source: 'preset',
        tags: ['plugin', 'customisation', 'configuration', 'cowork']
    },
    {
        id: 'claude-api',
        name: 'Claude API',
        command: 'claude-api',
        description: 'Build, debug, and optimise Claude API / Anthropic SDK applications — includes prompt caching setup, model migration, and tool use patterns.',
        category: 'Development',
        source: 'system',
        tags: ['API', 'SDK', 'development', 'Claude']
    },
    {
        id: 'simplify',
        name: 'Simplify Code',
        command: 'simplify',
        description: 'Review changed code for reuse, quality, and efficiency, then fix any issues found — reduces complexity and improves maintainability.',
        category: 'Development',
        source: 'system',
        tags: ['code review', 'simplification', 'quality']
    },
    {
        id: 'review',
        name: 'PR Review',
        command: 'review',
        description: 'Review a pull request — checks code quality, correctness, security, and adherence to project conventions.',
        category: 'Development',
        source: 'system',
        tags: ['pull request', 'review', 'code quality']
    },
    {
        id: 'security-review',
        name: 'Security Review',
        command: 'security-review',
        description: 'Complete a security review of code changes — checks for OWASP top 10 vulnerabilities, injection risks, authentication issues, and data exposure.',
        category: 'Development',
        source: 'system',
        tags: ['security', 'review', 'OWASP', 'vulnerabilities']
    },
    {
        id: 'init',
        name: 'Init CLAUDE.md',
        command: 'init',
        description: 'Initialise a new CLAUDE.md file for a project — scans the codebase and generates project instructions for Claude Code sessions.',
        category: 'Development',
        source: 'system',
        tags: ['init', 'CLAUDE.md', 'project', 'setup']
    },
    {
        id: 'update-config',
        name: 'Update Config',
        command: 'update-config',
        description: 'Configure the Claude Code harness via settings.json — permissions, environment variables, hooks, and automated behaviours. Use for adding allowed commands, setting env vars, or configuring pre/post hooks.',
        category: 'Development',
        source: 'system',
        tags: ['config', 'settings', 'permissions', 'hooks', 'environment']
    },
    {
        id: 'keybindings-help',
        name: 'Keybindings Help',
        command: 'keybindings-help',
        description: 'Customise keyboard shortcuts for Claude Code — rebind keys, add chord bindings, and modify ~/.claude/keybindings.json.',
        category: 'Development',
        source: 'system',
        tags: ['keybindings', 'shortcuts', 'keyboard', 'configuration']
    },
    {
        id: 'fewer-permission-prompts',
        name: 'Fewer Permission Prompts',
        command: 'fewer-permission-prompts',
        description: 'Scan session transcripts for common read-only Bash and MCP tool calls, then add a prioritised allowlist to project settings to reduce permission prompts.',
        category: 'Development',
        source: 'system',
        tags: ['permissions', 'allowlist', 'settings', 'productivity']
    },
    {
        id: 'loop',
        name: 'Loop',
        command: 'loop',
        description: 'Run a prompt or slash command on a recurring interval — useful for polling deploy status, checking build progress, or repeating any task on a schedule within a session.',
        category: 'Development',
        source: 'system',
        tags: ['loop', 'recurring', 'polling', 'interval']
    },
    {
        id: 'update-master-prompt',
        name: 'Update Master Prompt',
        command: 'update-master-prompt',
        description: 'Quarterly review of Kevin\'s global master prompt (~/.claude/CLAUDE.md) against the AI Brain, memory, and live systems. Detects what has gone stale, inaccurate, or missing, proposes a change-by-change diff with sources, and writes only approved changes. Runs automatically at the start of each quarter in propose-only mode.',
        category: 'Automation',
        source: 'custom',
        tags: ['master-prompt', 'context', 'ai-brain', 'quarterly', 'maintenance', 'accuracy']
    },
    {
        id: 'prospect-daily',
        name: 'Prospect Daily (Cold Outbound Agent)',
        command: 'prospect-daily',
        description: 'Daily autonomous prospecting agent: finds founder-led UK micro/small business owners posting pain and buying signals on Facebook and LinkedIn (assisted browsing, human pace, stop-on-friction), researches website + published email + Companies House entity (PECR gate), drafts a personal opener per prospect, and queues 5/day in the Prospecting tab. On Kevin\'s approval: sends the email through GoHighLevel, submits contact forms, or sends LinkedIn connects (max 3/day). Manages the conversation: checks GHL for replies, drafts responses, applies the 7-silent-days fallback (Ltd to the nurture sequence; manual-track never sequenced). Runs every day at 09:00; paired with the Cold Outbound Prospecting workflow in Systemisation.',
        category: 'Marketing',
        source: 'custom',
        tags: ['prospecting', 'cold-outreach', 'linkedin', 'facebook', 'gohighlevel', 'pecr', 'agent', 'daily']
    },
];

const SKILLS_CATEGORIES = [
    'Property Management',
    'Finance',
    'Operations',
    'Marketing',
    'Legal',
    'Data & Analytics',
    'Customer Support',
    'Productivity',
    'Documents & Media',
    'Automation',
    'Development',
];

const SKILLS_SOURCE_LABELS = {
    custom:    'Custom Skill',
    preset:    'Preset',
    project:   'Project Skill',
    scheduled: 'Scheduled Task',
    system:    'Built-in',
    sop:       'SOP Generated',
};
