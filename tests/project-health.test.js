import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { computeProjectHealth, isWritableStatus, PROJECT_STATUSES } =
    require(resolve(ROOT, 'js/project-health.js'));

// The rule behind every "is this project on track" answer on the platform —
// Leadership Dashboard, Tasks & Projects, and the daily job that writes the
// answer back to Airtable. All three import this file, so a change here
// changes all three, which is the point.
//
// The incident: five Q3 2026 projects sat at "Not Started" from 1 July to 3
// August. Airtable's Project Status defaults to "Not Started" when the
// Strategy push creates a project, nothing ever cleared it, and both display
// copies returned early on that value — so 0 of 48 tasks done, 33 days into a
// 91-day quarter, rendered as though the quarter had not begun.
//
// A frozen "today" is passed everywhere, or these assertions would change
// meaning as real time passes.

const Q3 = { start: '2026-07-01', end: '2026-09-30' };   // 91 days
const DAY33 = '2026-08-03T12:00:00';                      // 36% through
const DAY2  = '2026-07-02T12:00:00';                      // ~1% through

describe('computeProjectHealth — the stale stored status', () => {
    it('ignores a stored "Not Started" once the quarter is genuinely under way', () => {
        // The exact incident record: "First cash through the door", £0 of £1,850.
        expect(computeProjectHealth({
            status: 'Not Started', ...Q3, kpiTarget: 1850, kpiCurrent: 0,
        }, DAY33)).toBe('Off-Track');
    });

    it('still reports a project doing well, even when stored as Not Started', () => {
        expect(computeProjectHealth({
            status: 'Not Started', ...Q3, kpiTarget: 200, kpiCurrent: 100,
        }, DAY33)).toBe('On-Target');
    });

    it('trusts a stored "Completed" — that is a statement, not a default', () => {
        expect(computeProjectHealth({
            status: 'Completed', ...Q3, kpiTarget: 200, kpiCurrent: 0,
        }, DAY33)).toBe('Completed');
    });

    it('trusts the completed flag too', () => {
        expect(computeProjectHealth({ completed: true, ...Q3 }, DAY33)).toBe('Completed');
    });
});

describe('computeProjectHealth — pace against the quarter', () => {
    // Day 33 of 91 = 36.26% through. Pace is 72.53 of a 200 target, so the
    // On-Target boundary sits between 72 and 73 — worth pinning exactly,
    // because an off-by-one in the ratio would still pass a looser test.
    it.each([
        ['ahead of pace',        200, 200, 'On-Target'],
        ['a shade over pace',    200,  73, 'On-Target'],
        ['a shade under pace',   200,  72, 'On-Track'],
        ['slightly behind',      200,  62, 'On-Track'],    // ratio ~86%
        ['clearly behind',       200,  20, 'Off-Track'],
        ['nothing done',         200,   0, 'Off-Track'],
    ])('%s → %s', (_label, target, current, expected) => {
        expect(computeProjectHealth({ ...Q3, kpiTarget: target, kpiCurrent: current }, DAY33))
            .toBe(expected);
    });

    it('does not punish a project in the first 5% of its quarter', () => {
        // This is what makes the rule fair, and what the old Airtable formula
        // got wrong — it compared raw completion against a flat 85%, so every
        // project read Off-Track on day one.
        expect(computeProjectHealth({ ...Q3, kpiTarget: 200, kpiCurrent: 0 }, DAY2))
            .toBe('Not Started');
    });

    it('treats a project whose end date has passed as Off-Track', () => {
        expect(computeProjectHealth({ ...Q3, kpiTarget: 200, kpiCurrent: 10 }, '2026-10-15T12:00:00'))
            .toBe('Off-Track');
    });

    it('reads a future quarter as Not Started, not Off-Track', () => {
        // Pushing next quarter's plan early must not create five Off-Track
        // projects on the dashboard.
        expect(computeProjectHealth({ start: '2026-10-01', end: '2026-12-31', kpiTarget: 5, kpiCurrent: 0 },
            DAY33)).toBe('Not Started');
    });
});

describe('computeProjectHealth — which progress signal it uses', () => {
    it('prefers the KPI over tasks, because that is what the project is for', () => {
        // Tasks all done, KPI untouched → the KPI wins and it is behind.
        expect(computeProjectHealth({
            ...Q3, kpiTarget: 200, kpiCurrent: 0, totalTasks: 10, completedTasks: 10,
        }, DAY33)).toBe('Off-Track');
    });

    it('falls back to tasks when there is no numeric KPI target', () => {
        expect(computeProjectHealth({
            ...Q3, kpiTarget: 0, totalTasks: 10, completedTasks: 10,
        }, DAY33)).toBe('On-Target');
    });

    it('says Unknown rather than guessing when nothing is measurable', () => {
        expect(computeProjectHealth({ ...Q3, kpiTarget: 0, totalTasks: 0 }, DAY33)).toBe('Unknown');
    });

    it('says Unknown when the dates are missing or inverted', () => {
        expect(computeProjectHealth({ kpiTarget: 5, kpiCurrent: 1 }, DAY33)).toBe('Unknown');
        expect(computeProjectHealth({ start: '2026-09-30', end: '2026-07-01' }, DAY33)).toBe('Unknown');
    });
});

describe('isWritableStatus — protects the Airtable single-select', () => {
    it('accepts exactly the five real options', () => {
        expect(PROJECT_STATUSES).toEqual(
            ['Not Started', 'Off-Track', 'On-Track', 'On-Target', 'Completed']);
        PROJECT_STATUSES.forEach(s => expect(isWritableStatus(s)).toBe(true));
    });

    it('rejects Unknown, so the daily job can never invent a new choice', () => {
        // Airtable with typecast:true silently CREATES an unrecognised option.
        // A job writing "Unknown" would quietly add a sixth status to the field.
        expect(isWritableStatus('Unknown')).toBe(false);
    });

    it('rejects the legacy formula spellings that use spaces not hyphens', () => {
        // The retired Airtable formula emitted "On Track" / "On Target".
        // Writing those verbatim would have created duplicate options.
        expect(isWritableStatus('On Track')).toBe(false);
        expect(isWritableStatus('On Target')).toBe(false);
    });
});
