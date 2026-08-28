import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildApprovalBlocks, approverFor } from '../scripts/slack-automation/approvals.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(ROOT, 'scripts/slack-automation/approvals.js'), 'utf8');

// Finding 20260814-daily-ops-146. "Posted is not received."
//
// Approvals went to the private #agent-approvals channel and named nobody.
// Every send succeeded. Slack raised no badge and no push, because a channel
// message with no mention notifies no one, and Kevin reads his DMs rather than
// opening that channel. 30 approvals accumulated unseen — 22 of them six days
// old — while the loop reported itself healthy end to end.
//
// The mention has to be in TWO places to work: inside a rendered block, and in
// the `text` fallback, which is what Slack puts in the push notification.

const KEVIN = 'U08HW8F1MA8';
const MICA = 'U08HW0TAWAE';

const task = (over = {}) => ({
  id: 'recAAAAAAAAAAAAAA',
  name: 'Email SSE about the arrears',
  description: 'Draft a reply',
  notes: '',
  agentOutput: 'TO: someone@example.com\nSUBJECT: Arrears\n---\nBody text.',
  ...over,
});

function firstText(blocks) {
  return String(blocks[0]?.text?.text ?? '');
}

describe('approval posts notify the person who has to act', () => {
  it('the FIRST block @mentions the routed approver', () => {
    const t = task();
    const blocks = buildApprovalBlocks(t, 'Creditor Management', false, approverFor(t, false));
    expect(firstText(blocks)).toContain(`<@${KEVIN}>`);
  });

  it("Mica's card mentions Mica, not Kevin", () => {
    const t = task({ approverEmail: 'micaa.work@gmail.com' });
    const approver = approverFor(t, false);
    const blocks = buildApprovalBlocks(t, 'Inbound Comms Response', false, approver);
    expect(firstText(blocks)).toContain(`<@${MICA}>`);
    expect(firstText(blocks)).not.toContain(`<@${KEVIN}>`);
  });

  it('a tier-1 task always mentions Kevin, whoever the Approver field names', () => {
    const t = task({ approverEmail: 'micaa.work@gmail.com' });
    const approver = approverFor(t, true); // tier 1 diverts
    const blocks = buildApprovalBlocks(t, 'Creditor Management', true, approver);
    expect(firstText(blocks)).toContain(`<@${KEVIN}>`);
  });

  it('falls back to Kevin rather than posting an un-mentioned card', () => {
    // Defence in depth: a future caller that forgets the argument must not
    // silently reproduce the exact bug this test exists for.
    const blocks = buildApprovalBlocks(task(), 'Agent', false, undefined);
    expect(firstText(blocks)).toContain(`<@${KEVIN}>`);
  });

  it('the ask still leads the card — the mention did not bury it', () => {
    const blocks = buildApprovalBlocks(task(), 'Agent', false, approverFor(task(), false));
    const joined = JSON.stringify(blocks);
    expect(joined).toContain('What the agent wants to do');
    // The mention line is one short block, not a wall above the fold.
    expect(firstText(blocks).length).toBeLessThan(80);
  });

  it('BACK-TEST: both `text` fallbacks carry the mention, which is what pushes', () => {
    // Slack builds the mobile push from `text`. Before the fix both call sites
    // read `text: \`Approval needed: ${t.name}\`` with no mention at all.
    const fallbacks = SRC.match(/text: `[^`]*Approval needed: \$\{t\.name\}`/g) || [];
    expect(fallbacks.length, 'expected the post and the repost path').toBe(2);
    for (const f of fallbacks) expect(f).toContain('<@${approver.slackId}>');
  });

  it('the mention is in the blocks, not only the fallback', () => {
    // A `text` mention alone is not enough once `blocks` is present: Slack
    // renders the blocks and the fallback is only the notification preview.
    expect(SRC).toMatch(/blocks\.push\(\{[\s\S]{0,200}<@\$\{who\}> — approval needed/);
  });
});
