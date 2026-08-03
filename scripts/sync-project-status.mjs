#!/usr/bin/env node
// ═════════════════════════════════════════════════════════════════════
// SYNC PROJECT STATUS — writes each project's derived health back to Airtable.
//
// WHY THIS EXISTS. The Strategy push creates projects and Airtable stamps
// "Not Started" by default. Nothing ever cleared it. On 3 Aug 2026 five Q3
// projects had read "Not Started" since 1 July while sitting at 0 of 48 tasks
// and £0 of an £1,850 cash target — a quarter genuinely off-track, displayed
// as one that had not begun.
//
// The dashboard now DERIVES health, so the screen is right whether or not this
// job runs. This job exists so that Airtable itself agrees — the grid, the
// interfaces, and anyone who opens the base directly.
//
// It imports js/project-health.js rather than re-implementing the rule. The
// platform has been bitten by a ported calculation drifting from its original
// (see tests/constant-drift.test.js); one implementation cannot drift.
//
// USAGE
//   node scripts/sync-project-status.mjs           # write changes
//   node scripts/sync-project-status.mjs --dry-run # report only, write nothing
//
// Reads the PAT from ~/.config/od/airtable_pat. Never pass it as an argument —
// command-line arguments are visible in `ps` to every process on the machine.
// ═════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { computeProjectHealth, isWritableStatus } = require(join(ROOT, 'js/project-health.js'));

const BASE_ID = 'appnqjDpqDniH3IRl';
const PROJECTS = 'tblHrpTMd5LNYn8v1';

// Field IDs from PROJ_F in os/strategy/strategy.js, plus the read-side rollups.
const F = {
    name:           'fldiMZICg1KOORpte',
    startDate:      'fldGIlsn0cSEpnj18',
    endDate:        'fldU0cJparnkvOUsV',
    status:         'fldZ0SpReVaDS1VXb',
    kpiTarget:      'fldaI0voHia91SYZz',
};
// Rollups/computed read by name — they are formula fields, so name is stable
// and there is no write path that could mismatch.
const BY_NAME = {
    kpiCurrent:     'KPI Current',
    totalTasks:     'Total Tasks (Countable)',
    completedTasks: 'Completed Tasks (Countable)',
    closedOn:       'Closed On',
};

const DRY_RUN = process.argv.includes('--dry-run');

function loadPat() {
    const p = join(homedir(), '.config', 'od', 'airtable_pat');
    try {
        const pat = readFileSync(p, 'utf8').trim();
        if (!pat) throw new Error('empty');
        return pat;
    } catch (e) {
        console.error(`FAIL: could not read the Airtable PAT from ${p} (${e.message})`);
        process.exit(1);
    }
}

async function airtable(pat, path, init = {}) {
    const res = await fetch(`https://api.airtable.com/v0/${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${pat}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
    if (!res.ok) {
        const body = await res.text();
        // Never echo the PAT — only the status and Airtable's own message.
        throw new Error(`Airtable ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
}

async function fetchAllProjects(pat) {
    const out = [];
    let offset;
    do {
        const qs = new URLSearchParams({ pageSize: '100' });
        if (offset) qs.set('offset', offset);
        const page = await airtable(pat, `${BASE_ID}/${PROJECTS}?${qs}`);
        out.push(...page.records);
        offset = page.offset;
    } while (offset);
    return out;
}

function toProject(rec) {
    const f = rec.fields || {};
    return {
        id: rec.id,
        name: f[F.name] || rec.fields['Project Name'] || '(unnamed)',
        status: f[F.status] || rec.fields['Project Status'] || '',
        start: f[F.startDate] || rec.fields['Start Date'] || '',
        end: f[F.endDate] || rec.fields['End Date'] || '',
        kpiTarget: Number(f[F.kpiTarget] ?? rec.fields['KPI Target']) || 0,
        kpiCurrent: Number(rec.fields[BY_NAME.kpiCurrent]) || 0,
        totalTasks: Number(rec.fields[BY_NAME.totalTasks]) || 0,
        completedTasks: Number(rec.fields[BY_NAME.completedTasks]) || 0,
        closedOn: rec.fields[BY_NAME.closedOn] || null,
    };
}

async function main() {
    const pat = loadPat();
    const records = await fetchAllProjects(pat);

    // A control, in the spirit of scripts/check-data-invariants.py: if the
    // fetch returns nothing, that is a broken job reporting a clean run.
    // "0 projects, all fine" and "the query is wrong" look identical otherwise.
    if (records.length === 0) {
        console.error('FAIL: the Projects table returned zero records — treating as a broken query, not a clean run.');
        process.exit(1);
    }

    const changes = [];
    let skippedClosed = 0, unknown = 0;

    for (const rec of records) {
        const p = toProject(rec);
        // A closed quarter is frozen history. Its status is a record of how it
        // ended and must never be recomputed.
        if (p.closedOn) { skippedClosed++; continue; }

        const health = computeProjectHealth(p);
        if (!isWritableStatus(health)) { unknown++; continue; }
        if (health === p.status) continue;
        changes.push({ id: p.id, name: String(p.name).slice(0, 60), from: p.status || '(blank)', to: health });
    }

    console.log(`Projects read: ${records.length} · closed (skipped): ${skippedClosed} · not measurable: ${unknown}`);
    if (!changes.length) {
        console.log('All open projects already carry their derived status. Nothing to write.');
        return;
    }

    changes.forEach(c => console.log(`  ${c.from} → ${c.to}   ${c.name}`));

    if (DRY_RUN) {
        console.log(`\nDRY RUN — ${changes.length} record(s) would be updated. Nothing written.`);
        return;
    }

    // Airtable accepts 10 records per PATCH.
    for (let i = 0; i < changes.length; i += 10) {
        const batch = changes.slice(i, i + 10);
        await airtable(pat, `${BASE_ID}/${PROJECTS}`, {
            method: 'PATCH',
            body: JSON.stringify({
                records: batch.map(c => ({ id: c.id, fields: { [F.status]: c.to } })),
                // No typecast: the status must match an existing option exactly.
                // With typecast a bad value would silently create a sixth choice.
                typecast: false,
            }),
        });
    }
    console.log(`\nUpdated ${changes.length} project(s).`);
}

main().catch(e => {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
});
