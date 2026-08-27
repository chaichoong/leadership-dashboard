import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The SOP AI Field Generator is an AIRTABLE automation, so it cannot import
// js/ai-models.js. Until 27 Aug 2026 it hardcoded "claude-sonnet-4-20250514",
// two versions behind the canonical id, and nothing anywhere would have said
// so: askClaude() swallows every failure and returns "", so a retired model
// would have generated BLANK SOP fields for ever with no error raised.
//
// It now fetches the id from the deployed js/ai-models.js at run time, and the
// literal in the script is only a network-failure fallback. These tests exist
// because a fallback that rots is the original bug wearing a disguise.

const SCRIPT = 'scripts/airtable-automations/sop-ai-field-generator.js';
const canonical = () => {
    const m = read('js/ai-models.js').match(/default\s*:\s*['"]([A-Za-z0-9._-]+)['"]/);
    if (!m) throw new Error('could not read the default model id from js/ai-models.js');
    return m[1];
};

describe('SOP AI Field Generator model id', () => {
    it('keeps its fallback in step with js/ai-models.js', () => {
        const src = read(SCRIPT);
        const m = src.match(/const MODEL_FALLBACK = "([^"]+)"/);
        expect(m, 'MODEL_FALLBACK not found in ' + SCRIPT).toBeTruthy();
        expect(
            m[1],
            `MODEL_FALLBACK is "${m[1]}" but js/ai-models.js says "${canonical()}". ` +
            'Update the fallback AND paste the script into the Airtable automation, ' +
            'then press Update to publish it.'
        ).toBe(canonical());
    });

    // CONTROL. Both the assertion above and the regex below pass trivially if
    // js/ai-models.js stops parsing, so prove a real id was actually read.
    it('reads a real model id from the source of truth (control)', () => {
        expect(canonical()).toMatch(/^claude-[a-z0-9.-]+$/);
        expect(canonical().length).toBeGreaterThan(8);
    });

    it('resolves the id at run time rather than trusting the literal', () => {
        const src = read(SCRIPT);
        // It must actually fetch ai-models.js, not just name it in a comment.
        expect(src).toMatch(/fetch\(MODELS_URL\)/);
        expect(src).toMatch(/js\/ai-models\.js/);
        // The API call must use the resolved value, never a literal.
        expect(src).toMatch(/model:\s*MODEL\b/);
        expect(src).not.toMatch(/model:\s*["']claude-/);
    });

    it('never blanks the SOP when every Claude call fails', () => {
        const src = read(SCRIPT);
        // askClaude returns "" on failure. Without this guard a bad model id
        // wipes SOP Summary, Operations Manual and Checklist and still marks
        // the record Created — losing content instead of reporting a fault.
        expect(src).toMatch(/if \(!refinedSummary && !operationsManual && !checklist\)/);
        const guardAt = src.indexOf('!refinedSummary && !operationsManual');
        const writeAt = src.indexOf('"SOP Created": true');
        expect(guardAt).toBeGreaterThan(-1);
        expect(writeAt).toBeGreaterThan(guardAt); // guard runs BEFORE the write
    });

    it('stays pure ASCII so Airtable cannot mangle it on paste', () => {
        const src = read(SCRIPT);
        const bad = [...src].filter((c) => c.charCodeAt(0) > 127);
        expect(bad, `non-ASCII characters found: ${JSON.stringify(bad)}`).toEqual([]);
    });
});
