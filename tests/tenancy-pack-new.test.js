import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 23 Sep 2026: `make-tenancy-pack.js --new` (the one-command pack for a newly let room)
// had drifted from the main path in the same file. Its proof of residency never filled
// the four address lines the template gained, so make-document.js refused the unfilled
// placeholders and --new died after writing the agreement. It also still set a title and
// reference on the proof, and it drew an authority to act at 5 Dalham Place, which Kevin
// dropped. These tests call the function --new runs, against the real templates, and
// check every spec with make-document.js's own validate(), the check the live run meets.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const TPL = join(homedir(), 'knowledge-os', 'templates');

function extractFn(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
}
const validate = new Function('die', `${extractFn(readFileSync(join(root, 'scripts/make-document.js'), 'utf8'), 'validate')}\nreturn validate;`)(
    (m) => { throw new Error(m); });

// Four comma parts, the shape of the live 5 Dalham Place record (recL3hULkxb0hirye).
const ADDRESS = 'Room 2, 5 Dalham Place, Testtown, XX1 1XX';
const EX = { noAuthorityTenant: ['Edna Example'], confirmedOver35: [], earlierTermHolder: {} };
const base = {
    address: ADDRESS, council: 'West Suffolk Council', team: 'Anglia Revenues Partnership',
    oneBed: 897.52, start: '2026-10-01', EX,
};

let P;
beforeAll(() => {
    // The templates live in the brain vault, not the repo. Without them there is nothing
    // to prove, so say so loudly rather than pass.
    for (const f of ['ast_single_template.md', 'proof_of_residency_template.md', 'authority_to_act_template.md']) {
        if (!existsSync(join(TPL, f))) throw new Error(`missing ${join(TPL, f)}: this test checks the real templates`);
    }
    P = require(join(root, 'scripts/make-tenancy-pack.js'));
});

const pack = (propertyName, tenantName) => P.newTenantPack({ ...base, propertyName, tenantName });
const byKind = (specs, prefix) => specs.filter((s) => s.name.startsWith(prefix));

describe('make-document validate() is a real check', () => {
    it('refuses an unfilled placeholder', () => {
        expect(() => validate({ markdown: 'To [Property line 1]' })).toThrow('unfilled placeholders');
    });
});

describe('--new draws the same proof of residency as the main path', () => {
    it('fills every placeholder, so make-document.js accepts it', () => {
        const [proof] = byKind(pack('5 Dalham Place', 'Jane Testwood'), 'Proof_of_Residency_');
        expect(proof).toBeDefined();
        expect(() => validate(proof)).not.toThrow();
        expect(proof.markdown).toContain('Room 2\n5 Dalham Place\nTesttown\nXX1 1XX\n');
        expect(proof.markdown).toContain('the tenancy started on 1 October 2026');
    });
    it('has no title or reference line', () => {
        const [proof] = byKind(pack('5 Dalham Place', 'Jane Testwood'), 'Proof_of_Residency_');
        expect(proof.title).toBeUndefined();
        expect(proof.reference).toBeUndefined();
    });
    it('is the shared spec the main path renders', () => {
        const [proof] = byKind(pack('5 Dalham Place', 'Jane Testwood'), 'Proof_of_Residency_');
        expect(proof).toEqual(P.proofOfResidencySpec('Jane Testwood', ADDRESS, '2026-10-01'));
    });
    it('passes validate() for every document that refuses placeholders', () => {
        for (const spec of pack('1 Example Road', 'Jane Testwood')) {
            if (!spec.allowPlaceholders) expect(() => validate(spec), spec.name).not.toThrow();
        }
    });
});

describe('--new skips the authority where the main path would', () => {
    it('draws no authority at 5 Dalham Place', () => {
        const specs = pack('5 Dalham Place', 'Jane Testwood');
        expect(byKind(specs, 'Authority_')).toHaveLength(0);
        expect(specs.map((s) => s.name)).toEqual(['AST_Jane_Testwood_5_Dalham_Place', 'Proof_of_Residency_Jane_Testwood']);
    });
    it('draws no authority for a tenant on the no-authority list', () => {
        expect(byKind(pack('1 Example Road', 'Edna Example'), 'Authority_')).toHaveLength(0);
    });
    it('still draws one everywhere else (control)', () => {
        const auth = byKind(pack('1 Example Road', 'Jane Testwood'), 'Authority_');
        expect(auth).toHaveLength(1);
        expect(auth[0].markdown).toContain('Jane Testwood');
    });
});
