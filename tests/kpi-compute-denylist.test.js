import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(ROOT, 'js/dashboard.js'), 'utf8');

// The safety check in front of founder-authored KPI compute code.
//
// THE INCIDENT (9 Aug 2026). The 6 May security hardening banned the backtick
// character outright. That silently killed every KPI whose compute code used
// an ordinary template literal — five scripts, including one whose only
// backtick sat inside a COMMENT ("`total` is returned so..."). Two live KPIs
// never produced a number for three months. Nothing surfaced, because a
// blocked script returned null and the caller skipped it without a word.
//
// Worse, the ban never closed the hole it appeared aimed at: an identifier
// assembled from ordinary quotes — obj["cons"+"tructor"] — passed straight
// through. So it cost real functionality and bought nothing.
//
// This pins both halves: dangerous patterns stay blocked (including the concat
// escape that used to leak), and ordinary JavaScript is left alone. Parsed out
// of the source so the test tracks the real regex rather than a copy of it.

function loadDenylist() {
    const m = SRC.match(/const _KPI_BLOCKED = (\/.*\/);/);
    if (!m) throw new Error('_KPI_BLOCKED not found in js/dashboard.js');
    // eslint-disable-next-line no-eval
    return eval(m[1]);
}

const BLOCKED = loadDenylist();

describe('KPI compute denylist — what must stay blocked', () => {
    it.each([
        ['obj["cons" + "tructor"]',   'a key built by concatenating quoted strings'],
        ["obj['win' + 'dow']",        'the same trick with single quotes'],
        ['x[`${k}`]',                 'a key built from a template substitution'],
        ['window.location.href',      'a blocked global by name'],
        ['eval("1+1")',               'eval'],
        ['(() => {}).constructor',    'the Function constructor'],
        ['a.fetch("/x")',             'network access'],
        ['localStorage.getItem("k")', 'storage access'],
        ['document.cookie',           'cookies'],
    ])('blocks %s — %s', (code) => {
        expect(BLOCKED.test(code)).toBe(true);
    });

    it('blocks the concat escape that the old backtick ban let through', () => {
        // This is the one that matters: the previous rule banned backticks but
        // allowed this, so it was never actually closed.
        expect(BLOCKED.test('const f = ({})["cons"+"tructor"];')).toBe(true);
    });
});

describe('KPI compute denylist — what must be allowed', () => {
    it.each([
        ['const key = `${y}-${m}`;',            'an ordinary template literal'],
        ['// `total` is returned so the...',    'a backtick inside a comment'],
        ['label: `${done} of ${all} complete`', 'a template literal building a label'],
        ['arr[i + 1]',                          'arithmetic inside an index'],
        ['tx["date"]',                          'a static quoted key'],
        ['rows[idx]',                           'a variable index'],
        ['t.name.slice(0, 60)',                 'a plain method call'],
        ['const n = items.filter(x => x.done).length; return n;', 'typical compute body'],
    ])('allows %s — %s', (code) => {
        expect(BLOCKED.test(code)).toBe(false);
    });
});

describe('KPI compute failures must be reported, not swallowed', () => {
    // The blocking was only half the fault. The other half is that nothing
    // said so — the KPI stayed blank behind a green "Auto" badge, which reads
    // as "maintaining itself" rather than "broken".
    it('records a reason on EVERY failure path, not just one of them', () => {
        // There are three ways to fail: blocked by the denylist, ran but
        // returned a non-number, or threw. All three must say why. Asserting
        // the string merely exists somewhere is not enough — an earlier draft
        // of this test passed while the blocked branch had been stripped,
        // because the catch branch still carried the line.
        const fn = SRC.slice(SRC.indexOf('function runKpiComputeCode'),
                             SRC.indexOf('function runKpiComputeCode') + 2400);
        const assignments = fn.match(/ctx\._kpiError\s*=\s*msg/g) || [];
        expect(assignments.length).toBe(3);
    });

    it('sets the reason on the blocked path specifically', () => {
        const blockedBranch = SRC.slice(SRC.indexOf('if(_KPI_BLOCKED.test(code))'),
                                        SRC.indexOf('if(_KPI_BLOCKED.test(code))') + 400);
        expect(blockedBranch).toMatch(/ctx\._kpiError\s*=\s*msg/);
    });

    it('reports compute problems at error level, not as a warning', () => {
        const fn = SRC.slice(SRC.indexOf('function runKpiComputeCode'),
                             SRC.indexOf('function runKpiComputeCode') + 2200);
        expect(fn).toContain("console.error('[runKpiComputeCode]");
        expect(fn).not.toContain("console.warn('[runKpiComputeCode] blocked");
    });

    it('carries the reason onto the project row so the UI can show it', () => {
        expect(SRC).toMatch(/local\.kpiComputeError\s*=/);
    });

    it('shows a fault badge instead of the "Auto" badge when compute failed', () => {
        // Order matters: the error branch must be tested BEFORE kpiAutomated,
        // or a dead KPI keeps its reassuring green badge.
        const errIdx = SRC.indexOf('if(p.kpiComputeError)');
        const autoIdx = SRC.indexOf('}else if(p.kpiAutomated)');
        expect(errIdx).toBeGreaterThan(-1);
        expect(autoIdx).toBeGreaterThan(errIdx);
        expect(SRC).toContain('Compute failed');
    });
});
