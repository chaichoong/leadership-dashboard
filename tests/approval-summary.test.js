// The approval-box summary line exists in TWO places — the task drawer
// (os/tasks/index.html) and the Slack approval message
// (scripts/slack-automation/approvals.js) — and Kevin reads them as the same
// feature. These tests run BOTH real implementations over the same fixtures
// (recon-vendor-key style: extract the function from source, never copy it)
// so the two cannot quietly drift apart.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { apvSummary as slackSummary } from '../scripts/slack-automation/approvals.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'os/tasks/index.html'), 'utf8');
const start = html.indexOf('function apvSummary(');
const end = html.indexOf('function renderApprovalBlock', start);
if (start === -1 || end === -1) throw new Error('apvSummary not found in os/tasks/index.html');
const webSummary = new Function(`${html.slice(start, end)}; return apvSummary;`)();

const LONG = 'x'.repeat(300);
const FIXTURES = {
    closingMarker:
        '# Big report\n\nWHAT WAS CHECKED\n' + LONG +
        '\n\n**Carrying this out will involve:** closing Airtable task recXYZ as already done.',
    emailDraft:
        'TO: hello@leofood.co.uk\nSUBJECT: the call you booked about Leo Food\n---\nHi Jack,\n\n' + LONG,
    reportFirstLine:
        ':rotating_light: TIER 1. This touches your private matter.\n\n# Heading noise\n\n' +
        'The invoice is already paid. The task is a false overdue.\n' + LONG,
    shortOutput: 'Send the tenant a reminder.',
    empty: '',
};

describe('apvSummary derives the ask', () => {
    it('prefers the closing "carrying this out will involve" line', () => {
        expect(webSummary(FIXTURES.closingMarker)).toBe('closing Airtable task recXYZ as already done.');
    });
    it('turns an email draft into a send-this action', () => {
        expect(webSummary(FIXTURES.emailDraft)).toBe(
            'Send an email to hello@leofood.co.uk. Subject: the call you booked about Leo Food');
    });
    it('falls back to the first meaningful line, skipping banners and headings', () => {
        expect(webSummary(FIXTURES.reportFirstLine)).toBe(
            'The invoice is already paid. The task is a false overdue.');
    });
    it('gives no summary for short output — repeating it twice helps nobody', () => {
        expect(webSummary(FIXTURES.shortOutput)).toBe('');
        expect(webSummary(FIXTURES.empty)).toBe('');
    });
});

describe('web and Slack implementations agree', () => {
    for (const [name, input] of Object.entries(FIXTURES)) {
        it(`fixture: ${name}`, () => {
            expect(webSummary(input)).toBe(slackSummary(input));
        });
    }
    it('agrees on a long marker line being capped the same way', () => {
        const input = 'preamble\n' + LONG + '\n\nCarrying this out will involve: ' + 'y'.repeat(500);
        expect(webSummary(input)).toBe(slackSummary(input));
        expect(webSummary(input).length).toBeLessThanOrEqual(400);
    });
});
