// Guards for today's-sport matching (Kevin, 3 Nov 2026): scripts/sport-calendar.py reads his diary and
// marks Padel or Football training on the What to wear card. Runs the script's own offline selftest, which
// pins every title rule (padel; Wolves, Willingham, football; plain "Training"; an age group with a league
// or cup) and the false matches it must refuse (a property unit "U2", "Cup of coffee", "Training: fire
// safety", "Winter Net Training"), plus the rule that an unread sport account is Failed, never "no sport".
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('sport-calendar.py', () => {
    it('passes its selftest: every title rule, every refused false match, and the Failed rule', () => {
        const out = execFileSync('python3', [resolve(ROOT, 'scripts/sport-calendar.py'), 'selftest'], { encoding: 'utf8' });
        expect(out).toContain('selftest: ok');
    });
});
