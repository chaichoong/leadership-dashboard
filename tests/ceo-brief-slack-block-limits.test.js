import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 27 Oct 2026: the 09:00 CEO brief composed fine and Slack refused the post with
// `invalid_blocks`, so Kevin got the money-only DM, no brief and no NEEDS YOU list — and since
// 23 Sep 2026 the brief is the ONLY route that list reaches him (finding 20261028-phase-5-1105).
// capSection guarded the must-see sections; the header, THE ONE THING, the why, the handed-off
// list and the flags were all uncapped model text, and Slack caps a header at 150 characters, a
// section at 3000 and a message at 50 blocks, and refuses an empty section outright.
//
// These drive the SHIPPED functions out of the worker source, the same way the other ceo-brief
// tests do, so the limits are checked against the code that actually posts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(resolve(ROOT, 'scripts/slack-automation/money-daily-worker.js'), 'utf8');

function pick(n) {
    const m = WORKER.match(new RegExp(`\\n(?:async )?function ${n}\\([\\s\\S]*?\\n\\}`))
        || WORKER.match(new RegExp(`\\nconst ${n} = [^\\n]*;`));
    if (!m) throw new Error(`${n} not found in money-daily-worker.js`);
    return m[0];
}
const HELPERS = ['SECTION_MAX', 'capSection', 'HEADER_MAX', 'BLOCKS_MAX', 'hardenBlocks',
    'fmt', 'LIGHT_EMOJI', 'LIGHT_LABEL', 'londonDateLabel', 'buildBriefBlocks'];
// eslint-disable-next-line no-new-func
const W = new Function(`${HELPERS.map(pick).join('\n')}\nreturn { ${HELPERS.join(', ')} };`)();
const { hardenBlocks, buildBriefBlocks, HEADER_MAX, BLOCKS_MAX } = W;

const MONEY = { light: 'green', safeToActToday: 1234 };
const brief = (over = {}) => ({
    headline: 'Your day, decided.',
    one_thing: 'Pay the ground rent.',
    first_step: 'Open the letter.',
    why: 'It is due today.',
    ignore: [],
    handed_off: [],
    flags: [],
    ...over,
});

// Slack's own documented limits. A block set that breaks any one of them loses the WHOLE message.
function breaches(blocks) {
    const bad = [];
    if (blocks.length > 50) bad.push(`${blocks.length} blocks`);
    for (const b of blocks) {
        if (b.type === 'header' && String(b.text.text).length > 150) bad.push(`header ${String(b.text.text).length} chars`);
        if (b.type === 'section' && b.text) {
            const len = String(b.text.text).length;
            if (len > 3000) bad.push(`section ${len} chars`);
            if (!String(b.text.text).trim()) bad.push('empty section');
        }
    }
    return bad;
}

describe('the 09:00 brief can never be refused for a block Slack will not take', () => {
    it('a brief inside the limits is passed through unchanged in shape', () => {
        const blocks = hardenBlocks(buildBriefBlocks(MONEY, brief(), []));
        expect(breaches(blocks)).toEqual([]);
        expect(blocks[0].type).toBe('header');
        expect(blocks.some(b => b.type === 'section' && String(b.text.text).includes('THE ONE THING'))).toBe(true);
    });

    it('a 400-character headline is cut to Slack\'s header limit instead of losing the message', () => {
        const blocks = hardenBlocks(buildBriefBlocks(MONEY, brief({ headline: 'H'.repeat(400) }), []));
        expect(breaches(blocks)).toEqual([]);
        expect(String(blocks[0].text.text).length).toBeLessThanOrEqual(HEADER_MAX);
    });

    it('a 4,000-character opener and a 6,000-character ONE THING still post', () => {
        const opener = { type: 'section', text: { type: 'mrkdwn', text: 'D'.repeat(4000) } };
        const blocks = hardenBlocks(buildBriefBlocks(MONEY, brief({ one_thing: 'O'.repeat(6000) }), [opener]));
        expect(breaches(blocks)).toEqual([]);
        // capSection's own cut-short line lands a few characters past SECTION_MAX, which is why
        // that constant is 2900 and not 3000: the margin is the suffix.
        expect(blocks.every(b => b.type !== 'section' || String(b.text.text).length <= 3000)).toBe(true);
        expect(blocks.some(b => b.type === 'section' && String(b.text.text).includes('cut short'))).toBe(true);
    });

    it('80 board flags are cut to 50 blocks with a line saying how many were cut', () => {
        const flags = Array.from({ length: 80 }, (_, i) => `flag ${i}`);
        const blocks = hardenBlocks(buildBriefBlocks(MONEY, brief({ flags }), []));
        expect(breaches(blocks)).toEqual([]);
        expect(blocks.length).toBe(BLOCKS_MAX);
        expect(String(blocks[blocks.length - 1].text.text)).toContain('more sections cut short');
    });

    it('an empty section is dropped rather than refused', () => {
        const blocks = hardenBlocks([
            { type: 'section', text: { type: 'mrkdwn', text: '   ' } },
            { type: 'section', text: { type: 'mrkdwn', text: 'real' } },
        ]);
        expect(breaches(blocks)).toEqual([]);
        expect(blocks).toHaveLength(1);
    });

    // CONTROL. If this fails, the breach detector above has stopped detecting anything and every
    // assertion in this file is reporting a pass it never earned.
    it('control: the detector sees a real breach when nothing hardens the blocks', () => {
        const raw = buildBriefBlocks(MONEY, brief({ headline: 'H'.repeat(400), one_thing: 'O'.repeat(6000) }), []);
        expect(breaches(raw).length).toBeGreaterThan(0);
    });
});
