#!/usr/bin/env node
// ═════════════════════════════════════════════════════════════════════
// SYNC PROJECT STATUS — writes each project's derived health back to Airtable,
// then each open project's dated update line (js/project-update.js).
//
// THE UPDATE LINE (Kevin, 10 Oct 2026). Every open project gets one line a day:
// what moved since the last update (KPI, tasks completed, status), or "nothing
// moved since <date>". Written by rule, never by an AI model. The snapshot it
// compares against is stored on the project (Latest Update State).
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
const { buildProjectUpdate, parseState, baseline, selectCompleted } = require(join(ROOT, 'js/project-update.js'));

const BASE_ID = 'appnqjDpqDniH3IRl';
const PROJECTS = 'tblHrpTMd5LNYn8v1';
const TASKS = 'tblqB8b22hKBL4PF1';
// The update line's fields on Projects (created 13 Oct 2026), written by id.
const U = { line: 'fldRvVPngn2v4Mg49', at: 'fldZC3BcWrlpdOsXV', state: 'fldifD8aCIkmWn5dY' };
// Tasks: name, Completion Date, and the link to Projects.
const T = { name: 'fldgFjGBw6bTKJFCD', completedAt: 'fldFOi1SwEKuJRmdN', projects: 'fldBg0rQy0FrOAkRN' };
// A first update lists tasks completed since the project's start, but never further back than this.
const LOOKBACK_DAYS = 31;

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
    kpiUnit:        'KPI Unit',
    completedTick:  'Project Completed?',
    updateState:    'Latest Update State',
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
        kpiUnit: rec.fields[BY_NAME.kpiUnit] || '',
        completedTick: !!rec.fields[BY_NAME.completedTick],
        updateState: rec.fields[BY_NAME.updateState] || '',
    };
}

// Tasks completed in the last LOOKBACK_DAYS, by project id. Zero over a month means the query or
// the field broke, not that nobody finished anything (the base completes hundreds a month): fail.
async function fetchRecentCompletions(pat) {
    const byProject = {};
    let offset, count = 0;
    const formula = `IS_AFTER({Completion Date}, DATEADD(NOW(), -${LOOKBACK_DAYS}, 'days'))`;
    do {
        const qs = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true', filterByFormula: formula });
        Object.values(T).forEach(f => qs.append('fields[]', f));
        if (offset) qs.set('offset', offset);
        const page = await airtable(pat, `${BASE_ID}/${TASKS}?${qs}`);
        page.records.forEach(r => {
            count++;
            const f = r.fields || {};
            (f[T.projects] || []).forEach(pid => (byProject[pid] = byProject[pid] || []).push({ name: f[T.name] || '', completedAt: f[T.completedAt] || '' }));
        });
        offset = page.offset;
    } while (offset);
    if (!count) throw new Error(`no task was completed in the last ${LOOKBACK_DAYS} days by this query: treating as a broken query, not a quiet month`);
    return byProject;
}

const londonDay = d => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

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
    const statusNow = {};   // the status each project carries once this run's writes land
    let skippedClosed = 0, unknown = 0;

    for (const rec of records) {
        const p = toProject(rec);
        // A closed quarter is frozen history. Its status is a record of how it
        // ended and must never be recomputed.
        if (p.closedOn) { skippedClosed++; continue; }

        const health = computeProjectHealth(p);
        if (!isWritableStatus(health)) { unknown++; continue; }
        statusNow[p.id] = health;
        if (health === p.status) continue;
        changes.push({ id: p.id, name: String(p.name).slice(0, 60), from: p.status || '(blank)', to: health });
    }

    console.log(`Projects read: ${records.length} · closed (skipped): ${skippedClosed} · not measurable: ${unknown}`);
    if (!changes.length) console.log('All open projects already carry their derived status. Nothing to write.');
    changes.forEach(c => console.log(`  ${c.from} → ${c.to}   ${c.name}`));

    if (DRY_RUN) {
        if (changes.length) console.log(`\nDRY RUN — ${changes.length} status change(s) would be written.`);
    } else {
        await writeStatuses(pat, changes);
    }
    await writeUpdates(pat, records, statusNow);
}

// The dated update line on every open project (closed and Completed projects are history).
async function writeUpdates(pat, records, statusNow) {
    const now = new Date();
    const today = londonDay(now);
    const floor = londonDay(new Date(now.getTime() - LOOKBACK_DAYS * 86400000));
    const completions = await fetchRecentCompletions(pat);
    const writes = [];
    for (const rec of records) {
        const p = toProject(rec);
        if (p.closedOn || p.completedTick || p.status === 'Completed' || statusNow[p.id] === 'Completed') continue;
        const prev = baseline(parseState(p.updateState), today);
        const { since, completed } = selectCompleted({ tasks: completions[p.id], prev, start: p.start, today, floor, nowIso: now.toISOString() });
        const u = buildProjectUpdate({
            prev, completed, today, nowIso: now.toISOString(), start: prev ? null : since,
            now: { kpi: p.kpiCurrent, kpiTarget: p.kpiTarget, kpiUnit: p.kpiUnit, done: p.completedTasks, total: p.totalTasks, status: statusNow[p.id] || p.status },
        });
        writes.push({ id: p.id, name: String(p.name).slice(0, 60), fields: { [U.line]: u.line, [U.at]: now.toISOString(), [U.state]: JSON.stringify(u.state) } });
    }
    console.log(`\nUpdate lines: ${writes.length} open project(s).`);
    writes.forEach(w => console.log(`  ${w.name}: ${w.fields[U.line]}`));
    if (!writes.length) throw new Error('no open project to update: treating as a broken read, not a quiet board');
    if (DRY_RUN) { console.log('DRY RUN — no update line written.'); return; }
    for (let i = 0; i < writes.length; i += 10) {
        await airtable(pat, `${BASE_ID}/${PROJECTS}`, {
            method: 'PATCH',
            body: JSON.stringify({ records: writes.slice(i, i + 10).map(w => ({ id: w.id, fields: w.fields })), typecast: false }),
        });
    }
    console.log(`Wrote ${writes.length} update line(s).`);
}

async function writeStatuses(pat, changes) {
    if (!changes.length) return;

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
