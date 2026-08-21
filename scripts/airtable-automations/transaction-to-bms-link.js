/******************************************************
 AIRTABLE AUTOMATION SCRIPT -- paste target:
   Automation: "Transaction to BMS Table Linking"  (wflqFFfCwl5skdoDt)
   Node:       "Link Transaction Record to BMS Table script"

 This file is the source of truth for that script. The Airtable REST API
 refuses to edit customScript nodes ("read-only node ... edit in the Airtable
 UI instead"), so changes here have to be pasted in by hand and published with
 the Update button.

 Transactions -> BMS Link  (LINK ONLY -- never creates)

 WHY THIS NEVER CREATES
 This automation fires once per transaction. The previous version was a
 find-or-create: if it could not find the month's summary it made one. On a
 bulk import hundreds of copies run at the same moment, none of them finds a
 record for the month because none exists yet, and each creates its own. That
 produced 11 duplicate Real Estate months on 21 May 2025 -- nine of them in the
 SAME SECOND.

 The cost was not tidiness. Each duplicate held only part of its month's
 transactions, so every Real Estate monthly figure from April 2025 onward was
 computed on a fraction of the month. October 2025 reported revenue of
 36,682.65 against a true 37,180.65, with gross profit understated by 1,423.23.
 Nothing errored and every number looked plausible, which is why it ran for
 fifteen months. Merged and deduplicated 18 Aug 2026.

 Creation now belongs to the daily "BMS Record Generator", which runs once,
 single-threaded, and therefore cannot race with itself. If the month's record
 does not exist yet this script exits quietly and the daily sweep links the
 transaction within 24 hours. A transaction linked slightly late is harmless.
 A duplicate summary silently halving a month's numbers is not.

 DETERMINISTIC PICK
 Should duplicates ever exist again, every concurrent run must choose the SAME
 record or the split reappears. Sorting matches by record id and taking the
 first is stable across runs; "first returned by the query" was not.

 Guarded by the `one-monthly-summary-per-business-month` invariant in
 scripts/check-data-invariants.py, which fails the daily sweep if a duplicate
 month ever reappears.
******************************************************/

const DRY_RUN = false;

const TABLE_TX  = "Transactions";
const TABLE_BMS = "Business Monthly Summary";

const F_TX_KEY     = "Transaction Key";  // formula: "<Business> - <Month YYYY>" (EN DASH)
const F_TX_BMSLINK = "BMS Link";
const F_BMS_KEY    = "BMS Key";          // same shape, same en dash

const { recordId } = input.config();
if (!recordId) throw new Error("Missing input variable: recordId");

const txTable  = base.getTable(TABLE_TX);
const bmsTable = base.getTable(TABLE_BMS);

const tx = await txTable.selectRecordAsync(recordId, { fields: [F_TX_KEY, F_TX_BMSLINK] });
if (!tx) throw new Error("Transaction record not found (bad recordId?)");

const existing = tx.getCellValue(F_TX_BMSLINK);
if (existing && existing.length) {
    console.log("Already linked. Nothing to do.");
    return;
}

const txKey = (tx.getCellValueAsString(F_TX_KEY) || "").trim();
if (!txKey) {
    console.log("Transaction Key is blank. Exiting.");
    return;
}

const bmsQuery = await bmsTable.selectRecordsAsync({ fields: [F_BMS_KEY] });
const matches = bmsQuery.records
    .filter(r => (r.getCellValueAsString(F_BMS_KEY) || "").trim() === txKey)
    .map(r => r.id)
    .sort();

if (!matches.length) {
    // Deliberately does NOT create. The daily generator owns that.
    console.log(`No Business Monthly Summary yet for "${txKey}". Leaving unlinked -- the daily BMS generator creates it and its sweep links this record.`);
    return;
}

if (matches.length > 1) {
    console.log(`WARNING: ${matches.length} summaries share the key "${txKey}". Linking to ${matches[0]} (lowest id, stable across concurrent runs). These need merging -- duplicates split a month's totals.`);
}

if (DRY_RUN) {
    console.log(`DRY RUN: would link ${recordId} -> ${matches[0]}`);
    return;
}

await txTable.updateRecordAsync(recordId, { [F_TX_BMSLINK]: [{ id: matches[0] }] });
console.log(`Linked transaction to BMS ${matches[0]} (${txKey}).`);
