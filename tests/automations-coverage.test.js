import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The Automations list on the AI Agents page (27 Aug 2026) exists so nothing
// running on Kevin's behalf is invisible. A hand-maintained list decays the
// moment someone adds a job and forgets the list, and a stale "what it does"
// list is worse than none — it reads as complete while hiding the newest job.
//
// scripts/job-schedule.json is already the source of truth for scheduled jobs
// (the morning digest fails when a job is missing from it), so this test binds
// the display list to it in both directions: every live job must be described,
// and every described job must be real.

function loadAutomations() {
    const src = read('js/automations-data.js');
    const sandbox = {};
    new Function('globalThis', src + '\n;globalThis.__A = AUTOMATIONS;').call(sandbox, sandbox);
    return sandbox.__A;
}

const schedule = JSON.parse(read('scripts/job-schedule.json'));
const scheduleKeys = Object.keys(schedule).filter((k) => !k.startsWith('_'));
const enabledKeys = scheduleKeys.filter((k) => schedule[k].enabled !== false);

describe('automations list covers every scheduled job', () => {
    const A = loadAutomations();
    const listed = new Set(A.macJobs.map((j) => j.key));

    it('describes every ENABLED job in job-schedule.json', () => {
        const missing = enabledKeys.filter((k) => !listed.has(k));
        expect(missing, `add these to AUTOMATIONS.macJobs in js/automations-data.js: ${missing.join(', ')}`)
            .toEqual([]);
    });

    it('lists no job that does not exist in job-schedule.json', () => {
        const stale = [...listed].filter((k) => !scheduleKeys.includes(k));
        expect(stale, `these are listed but not scheduled anywhere: ${stale.join(', ')}`).toEqual([]);
    });

    // CONTROL. Both checks above pass trivially if the schedule parses to
    // nothing — a renamed file or a JSON shape change would read as "all
    // covered" for ever. The estate has ~20 live jobs; anything near zero is
    // a broken read, not an idle Mac.
    it('reads a real schedule (control)', () => {
        expect(enabledKeys.length).toBeGreaterThan(10);
        expect(listed.size).toBeGreaterThan(10);
    });

    it('gives every entry a plain-English description', () => {
        const groups = [...A.macJobs, ...A.otherMacJobs, ...A.workers, ...A.airtable];
        const thin = groups.filter((e) => !e.what || e.what.trim().length < 40).map((e) => e.name);
        expect(thin, `these need a real description: ${thin.join(', ')}`).toEqual([]);
    });

    it('marks each entry on or off', () => {
        const groups = [...A.macJobs, ...A.otherMacJobs, ...A.workers, ...A.airtable];
        const bad = groups.filter((e) => e.status !== 'on' && e.status !== 'off').map((e) => e.name);
        expect(bad).toEqual([]);
    });

    // A job's on/off state is recorded in two places once, and they must agree
    // or the page tells Kevin something is running when it is not.
    it('agrees with job-schedule.json about what is switched off', () => {
        const disagree = A.macJobs
            .filter((j) => scheduleKeys.includes(j.key))
            .filter((j) => (schedule[j.key].enabled !== false) !== (j.status === 'on'))
            .map((j) => j.key);
        expect(disagree, `status disagrees with job-schedule.json for: ${disagree.join(', ')}`).toEqual([]);
    });
});
