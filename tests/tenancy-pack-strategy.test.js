import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Growth Strategy was renamed on 16 Sep 2026 (HMO -> UC HMO, Joint tenancy -> UC joint
// tenancy). scripts/make-tenancy-pack.js decides which agreement to draw from that field.
// It compared raw strings, so a rename without it would have silently stopped recognising
// every joint tenancy and drawn the wrong pack. The script runs main() on load, so this
// reads its SOURCE rather than importing it, the same way tests/recon-vendor-key.test.js does.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const M = require(resolve(root, 'js/growth-plan-model.js'));
const src = readFileSync(resolve(root, 'scripts/make-tenancy-pack.js'), 'utf8');

function extract(name) {
    const start = src.indexOf(`const ${name} = `);
    if (start < 0) throw new Error(`${name} not found in make-tenancy-pack.js`);
    const end = src.indexOf(';\n', start);
    return new Function(`${src.slice(start, end + 1)}\nreturn ${name};`)();
}
function extractFn(name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    const aliases = extract('STRATEGY_ALIASES');
    return new Function('STRATEGY_ALIASES', `${src.slice(start, i + 1)}\nreturn ${name};`)(aliases);
}

describe('the tenancy pack reads the renamed strategies', () => {
    it('uses the same alias map as the growth plan', () => {
        expect(extract('STRATEGY_ALIASES')).toEqual(M.STRATEGY_ALIASES);
    });
    it('reads an old stored value as the new name', () => {
        const strategyOf = extractFn('strategyOf');
        expect(strategyOf({ fields: { 'Growth Strategy': 'Joint tenancy' } })).toBe('UC joint tenancy');
        expect(strategyOf({ fields: { 'Growth Strategy': 'HMO' } })).toBe('UC HMO');
        expect(strategyOf({ fields: { 'Growth Strategy': 'UC joint tenancy' } })).toBe('UC joint tenancy');
        expect(strategyOf({ fields: {} })).toBe('');
    });
    it('never compares a strategy against a raw old name', () => {
        const body = src.slice(src.indexOf('function strategyOf('));
        expect(body).not.toMatch(/===\s*'Joint tenancy'/);
        expect(body).not.toMatch(/!==\s*'Joint tenancy'/);
        expect(body).not.toMatch(/===\s*'HMO'/);
    });
});
