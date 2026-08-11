import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(resolve(ROOT, 'scripts/slack-automation/money-daily-worker.js'), 'utf8');

// Finding 20260811-ceo-huddle-068.
//
// A task in Status 'Approval' is FINISHED agent work with the words already
// written, waiting on one tick in Slack. For a Correspondence task, approving it
// sends the email. gatherTasks() passed the model only Task Name, Assignee, Due
// Date, Status and Priority, with nothing saying what 'Approval' meant and no
// count of the queue at all.
//
// On 11 Aug 2026 the 09:00 brief (recbv7w4clndYdztn) made the one thing
// 'Re-engage Jack Duddy', the first step 'Spend 10 minutes writing one honest,
// short re-opener in your own voice', and handed off 'worker-writer — draft a
// warm re-opener message for Jack Duddy'. All 20 'Warm lane: re-engage <name>'
// tasks were already in Approval with complete addressed emails in Agent Output
// (Jack Duddy: TO hello@leofood.co.uk). The brief invented ten minutes of writing
// and a duplicate agent dispatch for work that needed one tap, and never
// mentioned that 60 tasks were blocked behind Kevin.
//
// Functions are parsed out of the worker rather than imported: it is a Cloudflare
// module with one `export default` and these are internal. Same approach as
// tests/ceo-brief-schedule.test.js.
function load(names) {
  const src = names.map((n) => {
    const m = WORKER.match(new RegExp(`(?:const ${n} = new Set\\(\\[[\\s\\S]*?\\]\\);|function ${n}\\([\\s\\S]*?\\n\\})`));
    if (!m) throw new Error(`${n} not found in money-daily-worker.js`);
    return m[0];
  }).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return { ${names.join(', ')} };`)();
}

const { dropAlreadyWaiting } = load(['HANDOFF_STOPWORDS', 'distinctiveWords', 'dropAlreadyWaiting']);

describe('CEO brief and the approval queue', () => {
  it('does not dispatch an agent to redo work already waiting on a tick', () => {
    const tasks = { approvalNames: ['warm lane: re-engage jack duddy'] };
    const out = dropAlreadyWaiting(
      ['worker-writer — draft a warm re-opener message for Jack Duddy'], tasks);
    expect(out, 'the same email would be written and approved twice').toEqual([]);
  });

  it('leaves genuine hand-offs alone', () => {
    const tasks = { approvalNames: ['warm lane: re-engage jack duddy'] };
    const out = dropAlreadyWaiting([
      'worker-analyst — pull the Q3 conversion rate',
      'worker-builder — fix the CFV sidebar badge',
    ], tasks);
    expect(out).toHaveLength(2);
  });

  it('one shared generic word is not a match', () => {
    // 'draft' and 'email' are stopwords precisely so a single overlap cannot
    // strip half the list.
    const tasks = { approvalNames: ['draft the email to the council'] };
    const out = dropAlreadyWaiting(['worker-writer — draft the email to Intus'], tasks);
    expect(out).toHaveLength(1);
  });

  it('an empty approval queue changes nothing', () => {
    const items = ['worker-writer — draft something'];
    expect(dropAlreadyWaiting(items, { approvalNames: [] })).toEqual(items);
    expect(dropAlreadyWaiting(items, undefined)).toEqual(items);
  });
});

describe('what the CEO is told about the approval queue', () => {
  it('gatherTasks reads Task Type, so an email that SENDS on approval is labelled', () => {
    expect(WORKER).toMatch(/'fields\[\]':[^\]]*'Task Type'/);
  });

  it('Approval tasks are their own bucket, not counted as overdue work', () => {
    expect(WORKER, 'Approval is still mixed into the live task pile')
      .toMatch(/const waiting = t\.filter\(x => x\.status === 'Approval'\)/);
    expect(WORKER).toMatch(/const live = t\.filter\(x => x\.status !== 'Approval'\)/);
    // The overdue / due-today / Kevin lists must come from `live`, or finished
    // work reads as work Kevin has failed to do.
    expect(WORKER).toMatch(/const overdue = live\.filter/);
    expect(WORKER).toMatch(/const dueToday = live\.filter/);
    expect(WORKER).toMatch(/const kevins = live\.filter/);
  });

  it('the queue size and the send warning reach the prompt', () => {
    expect(WORKER).toMatch(/awaitingApproval/);
    expect(WORKER).toMatch(/awaitingSend/);
    expect(WORKER).toContain('WAITING ON KEVIN’S TICK'.replace('’', "'"));
    expect(WORKER, 'nothing tells the model these are already done')
      .toContain('This is DONE work, not work to do.');
  });

  it('the prompt forbids a "write" first step for something already drafted', () => {
    expect(WORKER).toMatch(/never make the first step "write", "draft"/i);
  });
});
