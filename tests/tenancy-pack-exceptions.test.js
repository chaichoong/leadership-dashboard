import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 21 Sep 2026: make-tenancy-pack.js used to carry three real tenant names in code
// (this repository is public). They now live in ~/.config/od/tenancy-pack-exceptions.json.
// The danger is silence: a pack drawn without that file would quietly drop Kevin's
// exceptions. These tests run the script under a throwaway HOME and prove it stops
// instead, before any Airtable call (the PAT here is fake, so a call would fail differently).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/make-tenancy-pack.js');

let home;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tenancy-pack-'));
    mkdirSync(join(home, '.config', 'od'), { recursive: true });
    writeFileSync(join(home, '.config', 'od', 'airtable_pat'), 'patFAKE.not-a-real-token');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const run = () => spawnSync('node', [script, '--all', '--dry'], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
});
const writeExceptions = (text) => writeFileSync(join(home, '.config', 'od', 'tenancy-pack-exceptions.json'), text);

describe('the tenancy pack refuses to run without its private exceptions', () => {
    it('stops when the file is missing', () => {
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('missing');
        expect(r.stderr).toContain('tenancy-pack-exceptions.json');
    });
    it('stops when the file is not JSON', () => {
        writeExceptions('{not json');
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('not valid JSON');
    });
    it('stops when a list holds a single word instead of a full name', () => {
        writeExceptions(JSON.stringify({ noAuthorityTenant: ['Jane'], confirmedOver35: [], earlierTermHolder: {} }));
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('noAuthorityTenant must be a list of full names');
    });
    it('stops when a key is missing', () => {
        writeExceptions(JSON.stringify({ noAuthorityTenant: [], confirmedOver35: [] }));
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('earlierTermHolder must map a property to a full name');
    });
});

describe('parseExceptions', () => {
    const src = readFileSync(script, 'utf8');
    const start = src.indexOf('function parseExceptions(');
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    const parseExceptions = new Function(`${src.slice(start, i + 1)}\nreturn parseExceptions;`)();

    it('returns the three lists from a valid file', () => {
        const ex = parseExceptions(JSON.stringify({
            _note: 'ignored',
            noAuthorityTenant: ['Jane Testwood'],
            confirmedOver35: ['Edna Example'],
            earlierTermHolder: { '1 Example Road': 'Adam Older' },
        }));
        expect(ex).toEqual({
            noAuthorityTenant: ['Jane Testwood'],
            confirmedOver35: ['Edna Example'],
            earlierTermHolder: { '1 Example Road': 'Adam Older' },
        });
    });
    it('accepts empty lists, so an exception can be retired without deleting the file', () => {
        expect(parseExceptions('{"noAuthorityTenant":[],"confirmedOver35":[],"earlierTermHolder":{}}'))
            .toEqual({ noAuthorityTenant: [], confirmedOver35: [], earlierTermHolder: {} });
    });
    it('refuses a holder map given as a list', () => {
        expect(() => parseExceptions('{"noAuthorityTenant":[],"confirmedOver35":[],"earlierTermHolder":["Jane Testwood"]}'))
            .toThrow('earlierTermHolder');
    });
});
