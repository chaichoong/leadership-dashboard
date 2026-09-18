```markdown
# Airtable Schema for Tenancy Ender Skill

This document outlines the Airtable Base, Table, and Field IDs used by the `airtable-tenancy-ender` skill.

**Base ID:** `appnqjDpqDniH3IRl` (Operations Director)

## Table Details

| Table Name     | Table ID          | Purpose                                        |
| :------------- | :---------------- | :--------------------------------------------- |
| Tenancies      | `tblN51a88qTDB6iMH` | Main table for tenancy records.                |
| Tenants        | `tblX4elTuu01gwBYh` | Stores tenant information.                     |
| Rental Units   | `tblM3mZCR5kiEdWMj` | Stores rental property unit details.           |

## Field Details

### Tenancies Table (`tblN51a88qTDB6iMH`)

| Field Name                 | Field ID            | Type          | Description                                              |
| :------------------------- | :------------------ | :------------ | :------------------------------------------------------- |
| `Tenancy End Date`         | `fldwHhhKAq4f1nY9e` | Date          | Date when the tenancy officially ends.                   |
| `Payment Status (Unified)` | `fldxU3dPUnbK0SCDq` | Single Select | Cleared on tenancy end (set to null/blank).              |
| `Customers`                | `fld1i5bDoHL3B6rUf` | Link          | Links to the tenant record(s). RENAMED from `Tenants` in Airtable; a separate, now-empty `Tenants` field also exists, so match on the ID. |
| `Rental Unit`              | `fld7cjLLEHKAx49OK` | Link          | Links to the rental unit. OFTEN EMPTY on legacy billing records. Never infer the unit when it is blank. |

### Tenants Table (`tblX4elTuu01gwBYh`)

| Field Name                 | Field ID            | Type          | Description                                     |
| :------------------------- | :------------------ | :------------ | :---------------------------------------------- |
| `Tenant Status`            | `fldAXzP9SGIHiAhrv` | Single Select | Status of the tenant (e.g., Active, Former).    |
| `Current Unit`             | `fldeLsZYqbKS77S2V` | Link          | Links to the tenant's current rental unit.      |

**`Tenant Status` Options:**
- `Former`: `sely5PbQQqgfAdJGL`

### Rental Units Table (`tblM3mZCR5kiEdWMj`)

| Field Name                 | Field ID            | Type          | Description                                     |
| :------------------------- | :------------------ | :------------ | :---------------------------------------------- |
| `Unit Status`              | `fldBvqysXBm9rIm0E` | Single Select | Status of the rental unit (e.g., Occupied, Void). Only set to Void once the safety gate in SKILL.md passes. |
| `Tenants Field`            | `fldUs1pONuxxL6Mcm` | Text          | STALE FREE TEXT. Not maintained. Never treat it as evidence of who occupies the unit. |
| `Tenancies`                | `fldxOnUDg49C2PNVW` | Link          | Every tenancy on the unit. Check all of these for a blank end date before voiding. |
| `Tenancies copy`           | `fldmpIYp1cN0eQgWt` | Link          | Legacy generation of the same link. Check it too. |

**`Unit Status` Options:**
- `Void`: `selozSwvOmOLRQNNM`

## Tasks Table (`tblqB8b22hKBL4PF1`)

Used in Step 3 to remove outstanding UC verification tasks when a tenancy ends.

| Field Name        | Field ID            | Type   | Description                                                        |
| :---------------- | :------------------ | :----- | :----------------------------------------------------------------- |
| `Task Title`      | `fldgFjGBw6bTKJFCD` | Text   | UC verification tasks start with "UC verification:". Mirrored in `fldgxkzAY0BqeArNC`. |
| `Tenant`          | `fld6ZcfEogJmeQj2c` | Link   | Links to the Tenant record.                                        |
| `Tenancy`         | `fldmne4RYJU22ICub` | Link   | Links to the Tenancy record.                                       |

```
