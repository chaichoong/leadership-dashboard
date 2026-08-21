/******************************************************
 AIRTABLE AUTOMATION SCRIPT -- paste target:
   Automation: "Cashflow Monthly Report, BMS and TMS Generator Automation"
               (wflXkkHLSxzXF1Oik)
   Node:       "BMS Record Generator"

 This file is the source of truth for that script. The Airtable REST API
 refuses to edit customScript nodes, so changes here are pasted in by hand and
 published with the Update button.

 Business Monthly Summary -- ensure records exist, then link transactions.

 WHAT CHANGED (18 Aug 2026) AND WHY
 1. DRY_RUN was `true`. The script had been creating nothing at all, which is
    why no monthly summary existed after February 2026 and the whole monthly
    layer had been quietly dead for six months.
 2. `Year` was written as a NUMBER (`now.year`). It is a singleSelect, so the
    write would have been rejected the moment DRY_RUN was turned off. Both
    Month and Year must be `{ name: "..." }`.
 3. The `day !== 1` guard meant a single missed run lost that month for good,
    with no way to catch up. The work is idempotent -- it checks existing keys
    before creating -- so it now runs every day and self-heals.
 4. It now also creates summaries for any PAST month that still has unlinked
    transactions, instead of only the current month, so a gap closes itself.
 5. It now owns LINKING as well. The per-transaction automation used to do
    find-or-create, and because it fires once per record a bulk import ran
    hundreds of concurrent copies, each failing to find the month and creating
    its own. That made 11 duplicate Real Estate months, each holding a slice of
    its month, so every Real Estate figure from April 2025 was understated
    (October 2025: 36,682.65 reported against a true 37,180.65). Doing creation
    HERE -- once a day, single-threaded -- removes the race entirely. The
    per-transaction script is now link-only.

 Guarded by the `one-monthly-summary-per-business-month` invariant in
 scripts/check-data-invariants.py, which fails the daily sweep if a duplicate
 month reappears.
******************************************************/

// ===== CONFIG =====
const DRY_RUN = false;
const MAX_CREATES = 40;   // a normal day needs 3; anything near this is a backfill
const MAX_LINKS = 500;    // caps runtime; a backlog drains over successive days

const TABLE_BMS = "Business Monthly Summary";
const TABLE_BUS = "Business";
const TABLE_TX  = "Transactions";

const F_BUS_ACTIVE_A = "Active?";
const F_BUS_ACTIVE_B = "Active";

const F_BMS_KEY      = "BMS Key";    // FORMULA -- never written, only read
const F_BMS_MONTH    = "Month";      // singleSelect
const F_BMS_YEAR     = "Year";       // singleSelect ("2025".."2030"), NOT a number
const F_BMS_BUSINESS = "Business";   // linked record

const F_TX_KEY     = "Transaction Key"; // formula: "<Business> - <Month YYYY>" (EN DASH)
const F_TX_BMSLINK = "BMS Link";

// Only these businesses get a monthly summary. Inactive entities (Two Chefs,
// Cafe @ Highgate) are deliberately excluded -- the per-transaction automation
// gates on Active? too, so including them here would create summaries nothing
// ever links to.
const ALLOWED_BUSINESS_NAMES = new Set([
    "Operations Director",
    "Real Estate",
    "Personal",
]);

// The separator is an EN DASH. It must match both the BMS Key and the
// Transaction Key formulas exactly or nothing ever matches.
const KEY_SEP = " \u2013 ";  // EN DASH (U+2013), written as an escape on purpose

// ===== HELPERS =====
function londonParts(date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London", year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(date);
    const get = (t) => Number(parts.find(p => p.type === t)?.value);
    return { year: get("year"), month: get("month"), day: get("day") };
}

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

function keyFor(businessName, monthName, year) {
    return `${businessName}${KEY_SEP}${monthName} ${year}`;
}

// ===== MAIN =====
const bmsTable = base.getTable(TABLE_BMS);
const busTable = base.getTable(TABLE_BUS);
const txTable  = base.getTable(TABLE_TX);

const now = londonParts(new Date());
console.log(`London date: ${now.year}-${String(now.month).padStart(2,"0")}-${String(now.day).padStart(2,"0")}`);

// --- Businesses in scope, and the Year choices actually available ---
const busQuery = await busTable.selectRecordsAsync();
const busIdByName = new Map();
for (const r of busQuery.records) {
    const name = (r.name || "").trim();
    if (!ALLOWED_BUSINESS_NAMES.has(name)) continue;
    if (!(r.getCellValue(F_BUS_ACTIVE_A) || r.getCellValue(F_BUS_ACTIVE_B))) continue;
    busIdByName.set(name, r.id);
}
console.log(`Businesses in scope: ${[...busIdByName.keys()].join(", ") || "(none)"}`);

const yearChoices = new Set(
    (bmsTable.getField(F_BMS_YEAR).options?.choices || []).map(c => c.name)
);

// --- Existing summaries, indexed by key ---
const bmsQuery = await bmsTable.selectRecordsAsync({ fields: [F_BMS_KEY] });
const byKey = new Map();
for (const r of bmsQuery.records) {
    const k = (r.getCellValueAsString(F_BMS_KEY) || "").trim();
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r.id);
}
// Lowest id wins, so every run agrees on the same target even if duplicates exist.
const canonical = new Map([...byKey].map(([k, ids]) => [k, ids.sort()[0]]));
const dupes = [...byKey].filter(([, ids]) => ids.length > 1);
if (dupes.length) {
    console.log(`WARNING: ${dupes.length} month(s) have duplicate summaries and are splitting their totals: ${dupes.map(([k]) => k).join("; ")}`);
}
console.log(`Existing summaries: ${bmsQuery.records.length} across ${byKey.size} keys`);

// --- Transactions still waiting for a link ---
const txQuery = await txTable.selectRecordsAsync({ fields: [F_TX_KEY, F_TX_BMSLINK] });
const unlinked = txQuery.records.filter(r => {
    const link = r.getCellValue(F_TX_BMSLINK);
    return !(link && link.length);
});

const wanted = new Map();  // key -> {business, month, year}
const workable = [];       // [{id, key}]
const skipped = new Map();
function note(reason) { skipped.set(reason, (skipped.get(reason) || 0) + 1); }

for (const r of unlinked) {
    const key = (r.getCellValueAsString(F_TX_KEY) || "").trim();
    if (!key || !key.includes(KEY_SEP)) { note("unusable Transaction Key"); continue; }
    const sep = key.lastIndexOf(KEY_SEP);
    const business = key.slice(0, sep).trim();
    const monthYear = key.slice(sep + KEY_SEP.length).trim().split(" ");
    if (!busIdByName.has(business)) { note(`business not in scope: ${business}`); continue; }
    if (monthYear.length !== 2 || !MONTHS.includes(monthYear[0])) { note("unparseable month"); continue; }
    const [monthName, year] = monthYear;
    if (!yearChoices.has(year)) { note(`year ${year} is not a Year choice`); continue; }
    if (!canonical.has(key)) wanted.set(key, { business, monthName, year });
    workable.push({ id: r.id, key });
}

console.log(`Unlinked transactions: ${unlinked.length} | in scope: ${workable.length}`);
for (const [reason, n] of skipped) console.log(`   skipped ${n}: ${reason}`);

// --- Always keep the CURRENT month present, even before any transaction lands ---
const thisMonthName = MONTHS[now.month - 1];
for (const [business] of busIdByName) {
    const k = keyFor(business, thisMonthName, String(now.year));
    if (!canonical.has(k) && !wanted.has(k) && yearChoices.has(String(now.year))) {
        wanted.set(k, { business, monthName: thisMonthName, year: String(now.year) });
    }
}

// --- Create the missing summaries (single-threaded here: no race) ---
const creates = [...wanted].slice(0, MAX_CREATES).map(([key, w]) => ({
    key,
    fields: {
        [F_BMS_MONTH]: { name: w.monthName },
        [F_BMS_YEAR]: { name: w.year },
        [F_BMS_BUSINESS]: [{ id: busIdByName.get(w.business) }],
    },
}));
if (wanted.size > MAX_CREATES) {
    console.log(`NOTE: ${wanted.size} summaries missing, creating ${MAX_CREATES} this run (cap). The rest follow tomorrow.`);
}
console.log(`Summaries to create: ${creates.length}`);
for (const c of creates) console.log(`   + ${c.key}`);

if (!DRY_RUN && creates.length) {
    let queue = creates.slice();
    while (queue.length) {
        const batch = queue.splice(0, 50);
        const ids = await bmsTable.createRecordsAsync(batch.map(c => ({ fields: c.fields })));
        batch.forEach((c, i) => canonical.set(c.key, ids[i]));
    }
    console.log(`Created ${creates.length} summaries.`);
}

// --- Link whatever can now be linked ---
const updates = [];
let noTarget = 0;
for (const w of workable) {
    const target = canonical.get(w.key);
    if (!target) { noTarget++; continue; }
    updates.push({ id: w.id, fields: { [F_TX_BMSLINK]: [{ id: target }] } });
    if (updates.length >= MAX_LINKS) break;
}
if (noTarget) console.log(`${noTarget} transaction(s) still have no summary to link to; they resolve on a later run.`);
if (workable.length > updates.length + noTarget) {
    console.log(`NOTE: link cap ${MAX_LINKS} reached -- ${workable.length - updates.length - noTarget} left for tomorrow.`);
}
console.log(`Transactions to link: ${updates.length}`);

if (!DRY_RUN && updates.length) {
    let queue = updates.slice();
    while (queue.length) {
        await txTable.updateRecordsAsync(queue.splice(0, 50));
    }
    console.log(`Linked ${updates.length} transactions.`);
} else if (DRY_RUN) {
    console.log("DRY RUN -- nothing written.");
}
