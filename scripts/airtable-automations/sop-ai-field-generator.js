// SOP AI Field Generator -- Airtable automation wflYVMxVLSWnuzK9H
//
// REVIEWABLE COPY. The live script lives in the Airtable UI on the "Auto
// Generate SOP AI Fields" automation (SOPs table tblF3tSfEajPQJHoI). Keep the
// two in step: edit here, then paste in and press Update to publish.
//
// Trigger: Video Link Changed = Yes AND Allow Video Regeneration = Yes.
// What it does: reads the new Loom's summary (or the stored Transcript when
// Loom returns its generic blurb), asks Claude for a summary, a numbered
// operations manual and a checklist, and saves them as a Draft for review.
// It refuses to touch a SOP already marked Live.
//
// PURE ASCII ONLY. Airtable's script editor mangles pasted UTF-8 (an em dash
// became a mojibake sequence once already), so no emoji and no smart quotes.
// The original live copy used emoji log markers; they are spelled out here.
//
// THE MODEL ID (fixed 27 Aug 2026). This script used to hardcode
// "claude-sonnet-4-20250514", which was already two versions stale and would
// have become an outage the day Anthropic retired it, with no error raised --
// askClaude() swallows failures and returns "", so the SOP would simply have
// generated blank fields for ever. js/ai-models.js is the single source of
// truth, but an Airtable script cannot import it, so the ID is FETCHED from
// the deployed copy at run time. MODEL_FALLBACK is only for a network failure
// and is drift-locked to js/ai-models.js by
// tests/sop-generator-model-drift.test.js, so it cannot silently rot either.

// STEP 1: Load inputs & secrets
let { recordId } = input.config();
let claudeKey = input.secret("CLAUDE_AI_KEY");

let table = base.getTable("SOPs");
let record = await table.selectRecordAsync(recordId);

// STEP 2: Pull field values
let videoLink = record.getCellValue("SOP Video Link") || "";
let prevLink = record.getCellValue("Previous Video Link") || "";
let status = record.getCellValue("SOP Status")?.name || "";

console.log("Video link:", videoLink);
console.log("Claude key exists:", !!claudeKey);

// STEP 3-4: Safety checks
if (status === "Live") { console.log("LOCKED: SOP is Live -- skipping."); return; }

// STEP 5: Reset fields
await table.updateRecordAsync(recordId, {
    "SOP Created": false,
    "SOP Status": { name: "Draft" }
});

// STEP 6: Fetch Loom page
let html = "";
try {
    html = await (await fetch(videoLink)).text();
    console.log("HTML fetched, length:", html.length);
} catch (err) {
    console.error("ERROR: Loom fetch failed:", err);
    return;
}

let match = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
let rawSummary = match ? match[1] : "";
console.log("Raw summary:", rawSummary);

// STEP 7: Fallback to transcript
const GENERIC_PHRASE = "Loom is a tool designed for recording";
if (!rawSummary || rawSummary.includes(GENERIC_PHRASE)) {
    let fallback = record.getCellValue("Transcript");
    console.log("Transcript field value:", fallback);
    if (fallback) {
        rawSummary = fallback;
    } else {
        console.warn("WARNING: no usable content -- aborting.");
        return;
    }
}

// STEP 7.5: Resolve the model ID from the single source of truth.
// A stale hardcoded ID is an app-wide AI outage; this reads the live value and
// only falls back when the network is down, saying loudly which it used.
const MODEL_FALLBACK = "claude-sonnet-4-6";
const MODELS_URL = "https://chaichoong.github.io/leadership-dashboard/js/ai-models.js";

async function resolveModel() {
    try {
        let res = await fetch(MODELS_URL);
        if (!res.ok) throw new Error("HTTP " + res.status);
        let src = await res.text();
        // Matches: default: 'claude-sonnet-4-6'
        let m = src.match(/default\s*:\s*['"]([A-Za-z0-9._-]+)['"]/);
        if (m && m[1]) {
            console.log("Model resolved from ai-models.js:", m[1]);
            return m[1];
        }
        throw new Error("no default model found in ai-models.js");
    } catch (err) {
        // Loud on purpose. If this line starts appearing every run, the fetch
        // is broken and the fallback is quietly carrying the whole feature.
        console.warn("WARNING: could not resolve the model from ai-models.js (" +
            (err && err.message || err) + "). Using fallback:", MODEL_FALLBACK);
        return MODEL_FALLBACK;
    }
}
const MODEL = await resolveModel();

// STEP 8: Claude helper
async function askClaude(prompt, label, maxTokens = 600) {
    try {
        let res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": claudeKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: maxTokens,
                system: "You are an expert process-doc writer.",
                messages: [{ role: "user", content: prompt }]
            }),
        });
        let data = await res.json();
        console.log(label + " response:", JSON.stringify(data).slice(0, 200));
        return data.content?.[0]?.text?.trim() || "";
    } catch (err) {
        console.error("ERROR: Claude call failed for " + label + ":", err);
        return "";
    }
}

// STEP 9: Generate
let refinedSummary = await askClaude(`Rewrite this as a 2-3 sentence SOP summary:\n\n${rawSummary}`, "SOP Summary", 200);
let operationsManual = await askClaude(`Write a numbered step-by-step operations manual from this:\n\n${rawSummary}`, "Operations Manual", 2048);
let checklist = await askClaude(`Create a checklist of key steps, one bullet per line:\n\n${rawSummary}`, "Checklist", 200);

console.log("Summary result:", refinedSummary);
console.log("Manual result:", operationsManual.slice(0, 100));
console.log("Checklist result:", checklist);

// STEP 9.5: Do not overwrite good content with nothing.
// askClaude returns "" on any failure, so before this guard a retired model ID
// or a transient API error would have BLANKED the SOP fields and still marked
// the record Created. Failing loudly and leaving the old text is the safer end.
if (!refinedSummary && !operationsManual && !checklist) {
    console.error("ERROR: every Claude call came back empty -- leaving the existing " +
        "SOP fields untouched. Check the model ID and the CLAUDE_AI_KEY secret.");
    return;
}

// STEP 10: Clean checklist
checklist = checklist
    // Bullet (U+2022) and en dash (U+2013) written as ESCAPES, never literally:
    // Airtable's script editor mangles pasted UTF-8, and a mangled character here
    // would silently stop matching, leaving raw bullets in every checklist.
    .replace(/\u2022/g, "-").replace(/\u2013/g, "-")
    .replace(/\r?\n/g, "\n").replace(/[^\x20-\x7E\n]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();

// STEP 11: Update Airtable
await table.updateRecordAsync(recordId, {
    "SOP Summary": refinedSummary,
    "Operations Manual": operationsManual,
    "Checklist": checklist,
    "SOP Created": true,
    "SOP Status": { name: "Draft" }
});

console.log("DONE.");
