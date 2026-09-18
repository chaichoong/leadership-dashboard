---
name: airtable-tenancy-ender
description: Ends a tenancy in the Operations Director Airtable base: sets the tenancy end date, clears the payment status, marks the tenant Former and clears their current unit, and handles any UC verification tasks. Carries a six-question SAFETY GATE (18 Sep 2026) that refuses to void a rental unit when another live tenancy sits on it or when no unit is linked. Use when Kevin asks to end a tenancy for a specific tenant or tenancy record.
license: Complete terms in LICENSE.txt
---

# Airtable Tenancy Ender Skill

This skill automates the multi-table updates required to formally end a tenancy within the 'Operations Director' Airtable base. It ensures data consistency across linked records.

## SAFETY GATE: run before ANY write (added 18 Sep 2026)

This skill sets a rental unit to `Void`. On 18 Sep 2026 it was run for Kevin Radford,
whose old unit had already been re-let: voiding it would have wiped an occupied unit
earning £1,096.80 a month and corrupted the occupancy rollups and the cash flow
forecast. Nothing in the skill checked. These six questions now gate every run.

1. **Is there more than one tenant record with this name?** Search Tenants on
   `{Tenant Name}` AND search Rental Units on the primary `{Rental Unit}` formula for the
   property. Names repeat across generations of records. Confirm the record ID with Kevin
   before writing if more than one plausible match exists.
2. **Does the tenancy actually link a rental unit?** Read `Rental Unit`
   (`fld7cjLLEHKAx49OK`) on the tenancy. If it is EMPTY, **skip the unit step entirely**.
   Never infer the unit from a document name, a tenancy reference string, or the unit's
   `Tenants Field`. Say in the report that no unit was linked.
3. **Does that unit have another LIVE tenancy on it?** Read the unit and list every record
   in its `Tenancies` (`fldxOnUDg49C2PNVW`) and `Tenancies copy` (`fldmpIYp1cN0eQgWt`)
   links. If ANY of them, other than the one being ended, has a blank `Tenancy End Date`,
   **do not void the unit.** Report the clash to Kevin and stop at that step. The tenancy
   being ended may be a legacy billing record sitting alongside the current let.
4. **Is the unit's `Tenants Field` being used as evidence?** It must not be. It is plain
   text (`fldUs1pONuxxL6Mcm`), it is not maintained, and on 18 Sep 2026 it still read
   "Kevin Radford" seventeen months after Cheffins took the unit. Ownership lives in the
   `Tenants` / `Tenancies` LINK fields only.

5. **Is the record even in the table you think?** `GET /v0/{base}/{table}/{recordId}`
   resolves the ID across the WHOLE BASE and IGNORES the table in the URL, returning 200 with
   full data. On 18 Sep 2026 three records read cleanly through the Tenancies URL while
   actually living in `tblCGmeUTyx1N7LNe` "Tenancies (Accounts Statement) Legacy", a dead
   48-row table nothing reads. The DELETE is what exposed it, with `NOT_FOUND`. To prove
   which table a record is in, LIST that table with pagination and look for the ID. Never
   infer it from a successful read.

6. **Whose money is it?** The only reliable test of which tenancy a payment belongs to is the
   TRANSACTION's own `Tenancy` link, not the tenancy record that displays it. Legacy copies
   display transactions that point back at a different, often still-live, tenancy.

Only void the unit when the tenancy being ended is the one and only live tenancy on it.
Everything else in this skill (end date, payment status, tenant status) is safe to apply
either way.

### The script does not run

`scripts/end_tenancy.py` shells out to `manus-mcp-cli` against an `airtable` MCP server.
Neither exists on Kevin's Mac, and the `airtable` MCP connector is broken (auth error).
Do the steps by hand with curl and the PAT at `~/.config/od/airtable_pat`, base
`appnqjDpqDniH3IRl`, and read every record back after writing. Treat the script as a
field-ID reference, not as something to execute.

## Usage

To use this skill, you will need the **Record ID of the Tenancy** to be ended and the **End Date**.

### Workflow

1.  **Identify Tenancy**: Provide the Record ID of the tenancy you wish to end.
2.  **Specify End Date**: Provide the date on which the tenancy officially ends in `YYYY-MM-DD` format.
3.  **Clear linked UC verification tasks**: After the tenancy, tenant, and rental unit updates are applied, find and delete any UC Payment Verification tasks linked to the tenant.

### Script Execution

Execute the `end_tenancy.py` script with the required arguments:

```bash
python /home/ubuntu/skills/airtable-tenancy-ender/scripts/end_tenancy.py <tenancy_record_id> <end_date_YYYY-MM-DD>
```

### Affected Tables and Fields

This skill updates the following tables and fields in the 'Operations Director' Airtable base:

| Table          | Field Name                  | Action                                      |
| :------------- | :-------------------------- | :------------------------------------------ |
| **Tenancies**  | `Tenancy End Date`          | Set to the provided end date.               |
| **Tenancies**  | `Payment Status (Unified)`  | Cleared (set to blank).                     |
| **Tenants**    | `Current Unit`              | Cleared (unlinked from the rental unit).    |
| **Tenants**    | `Tenant Status`             | Set to 'Former'.                            |
| **Rental Units** | `Unit Status`             | Set to 'Void'. ONLY if the safety gate above passes. |
| **Tasks**      | UC verification records linked to the tenant | Deleted (all matching, future and completed). |

### Step 3 detail: Clear linked UC verification tasks

After the tenancy, tenant, and rental unit updates are applied:

1.  Search the **Tasks** table for the tenant's UC verification tasks.
2.  List the matches and confirm with Kevin before deleting.
3.  Delete all confirmed records.

**Tasks table reference:**

-   Table: `Tasks` (`tblqB8b22hKBL4PF1`)
-   Task title field: `fldgFjGBw6bTKJFCD` (mirrored in `fldgxkzAY0BqeArNC`). UC verification tasks start with `UC verification:`.
-   Tenant link field: `fld6ZcfEogJmeQj2c` (links to the Tenant record).
-   Tenancy link field: `fldmne4RYJU22ICub` (links to the Tenancy record).

**Match logic:** select Tasks where the Tenant link equals the ended tenant's record ID and the title starts with `UC verification:`. Delete all matches, including any already marked Completed, unless Kevin says to keep historical records.

## References

-   For detailed Airtable schema information (Base ID, Table IDs, Field IDs, and choice IDs), refer to: `/home/ubuntu/skills/airtable-tenancy-ender/references/airtable_schema.md`
