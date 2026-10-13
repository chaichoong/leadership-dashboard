import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The dated update line each open project carries (Kevin, 10 Oct 2026). The fixtures follow the
// three worked examples approved at the gate (a lettings project with one task done since its
// start, a rent project with two done this week, a compliance project with nothing done), read
// live on 10 Oct 2026. Task names and figures are invented: this repo is public.
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildProjectUpdate, parseState, baseline, selectCompleted } = require(resolve(root, 'js/project-update.js'));

const lettings = { kpi: 2, kpiTarget: 5, kpiUnit: 'units', done: 2, total: 9, status: 'On-Target' };

describe('the first update', () => {
    it('worked example 1: names the task completed since the start', () => {
        const u = buildProjectUpdate({ prev: null, now: lettings, today: '2026-10-13', start: '2026-10-01',
            completed: [{ name: 'Sample: find an extra tenant', completedAt: '2026-10-02T13:27:59Z' }] });
        expect(u.line).toBe('13 Oct: first update. Completed since 1 Oct: Sample: find an extra tenant. Now 2 of 5 units, 2 of 9 tasks done, On-Target.');
        expect(u.state).toMatchObject({ kpi: 2, done: 2, total: 9, status: 'On-Target', at: '2026-10-13', movedAt: '2026-10-13' });
    });
    it('worked example 3: says nothing was completed, never a blank', () => {
        const u = buildProjectUpdate({ prev: null, today: '2026-10-13', start: '2026-10-01', completed: [],
            now: { kpi: 0, kpiTarget: 13, kpiUnit: 'properties', done: 0, total: 9, status: 'Off-Track' } });
        expect(u.line).toBe('13 Oct: first update. Nothing completed since 1 Oct. Now 0 of 13 properties, 0 of 9 tasks done, Off-Track.');
    });
});

describe('a later update', () => {
    const prev = { kpi: 2, done: 2, total: 9, status: 'On-Target', at: '2026-10-13', movedAt: '2026-10-13' };

    it('nothing moved: says so, with the date it last moved', () => {
        const u = buildProjectUpdate({ prev, now: lettings, today: '2026-10-15', completed: [] });
        expect(u.line).toBe('15 Oct: nothing moved since 13 Oct. Still 2 of 5 units, 2 of 9 tasks done, On-Target.');
        expect([u.moved, u.state.movedAt, u.state.at]).toEqual([false, '2026-10-13', '2026-10-15']);
    });

    it('worked example 2: two tasks completed and the money moved', () => {
        const rentPrev = { kpi: 0, done: 0, total: 6, status: 'Off-Track', at: '2026-10-06', movedAt: '2026-10-06' };
        const u = buildProjectUpdate({ prev: rentPrev, today: '2026-10-10', completed: [
            { name: 'Sample tenant A: confirm the first payment', completedAt: '2026-10-07T14:13:44Z' },
            { name: 'Sample tenant B: confirm housing costs', completedAt: '2026-10-09T06:30:43Z' }],
            now: { kpi: 897.52, kpiTarget: 2693, kpiUnit: '£ a month', done: 2, total: 6, status: 'Off-Track' } });
        expect(u.line).toBe('10 Oct: KPI £0 a month → £897.52 a month. Completed: Sample tenant A: confirm the first payment; Sample tenant B: confirm housing costs. Now £897.52 a month of £2,693 a month, 2 of 6 tasks done, Off-Track.');
        expect(u.state.movedAt).toBe('2026-10-10');
    });

    it('a status change alone counts as movement', () => {
        const u = buildProjectUpdate({ prev, now: { ...lettings, status: 'Off-Track' }, today: '2026-10-20', completed: [] });
        expect(u.line).toBe('20 Oct: Status On-Target → Off-Track. Now 2 of 5 units, 2 of 9 tasks done, Off-Track.');
    });

    it('a task done with no completion date still shows as a move, and more than three names are cut', () => {
        const u = buildProjectUpdate({ prev, now: { ...lettings, done: 3 }, today: '2026-10-14', completed: [] });
        expect(u.line).toContain('Tasks done 2 → 3');
        const many = buildProjectUpdate({ prev, now: { ...lettings, done: 7 }, today: '2026-10-14',
            completed: ['A', 'B', 'C', 'D', 'E'].map(n => ({ name: 'Task ' + n })) });
        expect(many.line).toContain('Completed: Task A; Task B; Task C (+2 more)');
    });

    it('a count KPI reads as a bare number', () => {
        const u = buildProjectUpdate({ prev: { kpi: 0, done: 0, total: 7, status: 'On-Target', at: '2026-10-13' },
            now: { kpi: 1, kpiTarget: 1, kpiUnit: 'count', done: 0, total: 7, status: 'On-Target' }, today: '2026-11-20', completed: [] });
        expect(u.line).toBe('20 Nov: KPI 0 → 1. Now 1 of 1, 0 of 7 tasks done, On-Target.');
    });
});

describe('the stored snapshot', () => {
    it('reads back, and a broken or empty snapshot starts afresh', () => {
        expect(parseState('{"kpi":1,"done":0,"total":3,"status":"On-Track","at":"2026-10-13"}').at).toBe('2026-10-13');
        expect(parseState('')).toBeNull();
        expect(parseState('{not json')).toBeNull();
        expect(parseState('{"kpi":1}')).toBeNull();
    });
});

describe('a second run on the same day', () => {
    it('compares with the snapshot from before today, so the morning\'s moves are not wiped', () => {
        const yesterday = { kpi: 1, done: 1, total: 9, status: 'On-Target', at: '2026-10-12', atIso: '2026-10-12T05:45:00Z', movedAt: '2026-10-12' };
        const first = buildProjectUpdate({ prev: baseline(yesterday, '2026-10-13'), now: lettings, today: '2026-10-13', nowIso: '2026-10-13T05:45:00Z',
            completed: [{ name: 'Sample: sign a tenant' }] });
        expect(first.line).toContain('KPI 1 units → 2 units');
        const rerun = buildProjectUpdate({ prev: baseline(first.state, '2026-10-13'), now: lettings, today: '2026-10-13', nowIso: '2026-10-13T09:00:00Z',
            completed: [{ name: 'Sample: sign a tenant' }] });
        expect(rerun.line).toBe(first.line);
        expect(rerun.state.base.at).toBe('2026-10-12');
    });
    it('a rerun of a first update stays a first update', () => {
        const first = buildProjectUpdate({ prev: null, now: lettings, today: '2026-10-13', start: '2026-10-01', completed: [] });
        expect(baseline(first.state, '2026-10-13')).toBeNull();
    });
});

// Found in review, 13 Oct 2026: which completed tasks go into an update.
describe('picking the completed tasks', () => {
    const tasks = [
        { name: 'Before the start', completedAt: '2026-09-28T10:00:00.000Z' },
        { name: 'Since the start', completedAt: '2026-10-02T13:27:59.000Z' },
        { name: 'Before the last run', completedAt: '2026-10-13T05:00:00.000Z' },
        { name: 'After the last run', completedAt: '2026-10-13T09:00:00.000Z' },
        { name: 'After this run began', completedAt: '2026-10-14T05:45:30.000Z' },
        { name: 'Re-opened', completedAt: '' },
    ];
    const base = { today: '2026-10-14', floor: '2026-09-13', nowIso: '2026-10-14T05:45:00.000Z' };

    it('after an update: only tasks completed after its timestamp and before this run began', () => {
        const prev = { at: '2026-10-13', atIso: '2026-10-13T05:45:00.000Z' };
        expect(selectCompleted({ ...base, tasks, prev }).completed.map(t => t.name)).toEqual(['After the last run']);
    });
    it('a first update: since the start, never before the look-back limit, never a future start', () => {
        expect(selectCompleted({ ...base, tasks, prev: null, start: '2026-10-01' }).completed.map(t => t.name))
            .toEqual(['Since the start', 'Before the last run', 'After the last run']);
        expect(selectCompleted({ ...base, tasks, prev: null, start: '2026-01-01' }).since).toBe('2026-09-13');
        expect(selectCompleted({ ...base, tasks, prev: null, start: '2027-01-01' }).since).toBe('2026-10-14');
        expect(selectCompleted({ ...base, tasks, prev: null, start: '' }).since).toBe('2026-09-13');
    });
    it('a re-opened task (no completion date) is never named', () => {
        expect(selectCompleted({ ...base, tasks, prev: null, start: '2026-09-01' }).completed.some(t => t.name === 'Re-opened')).toBe(false);
    });
    it('the done count is shown when it moved more than the names explain', () => {
        const prev = { kpi: 0, done: 2, total: 9, status: 'On-Track', at: '2026-10-13', movedAt: '2026-10-13' };
        const u = buildProjectUpdate({ prev, now: { ...lettings, done: 5, status: 'On-Track' }, today: '2026-10-14', completed: [{ name: 'Named one' }] });
        expect(u.line).toContain('Completed: Named one');
        expect(u.line).toContain('Tasks done 2 → 5');
        const one = buildProjectUpdate({ prev, now: { ...lettings, done: 3, status: 'On-Track' }, today: '2026-10-14', completed: [{ name: 'Named one' }] });
        expect(one.line).not.toContain('Tasks done');
    });
    it('a re-open alongside a new completion says the count did not move', () => {
        const prev = { kpi: 0, done: 3, total: 9, status: 'On-Track', at: '2026-10-13', movedAt: '2026-10-13' };
        const u = buildProjectUpdate({ prev, now: { ...lettings, done: 3, status: 'On-Track' }, today: '2026-10-14', completed: [{ name: 'Named one' }] });
        expect(u.line).toContain('Completed: Named one. Tasks done still 3.');
    });
});
