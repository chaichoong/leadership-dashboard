import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── KNOCK IT BACK A WEEK (28 Aug 2026) ──────────────────────────────
//
// Kevin: "we've got a couple of confirmation statements to submit, and we need
// authentication codes. It takes a week for those to arrive. Rather than having
// something sitting clogging the approval gate up, I need to knock it back a
// week."
//
// The whole mechanism is one date on the task and FOUR independent surfaces
// agreeing to read it: the AI Agents queue, the sidebar badge, the Slack loop
// and the CEO brief. There is no job that brings the task back — every surface
// simply stops matching it while the date is in the future and starts again
// when it is not.
//
// That design has exactly one way to fail, and it is the way the platform has
// already been burned twice: ONE surface disagreeing. A badge that keeps
// counting a parked task, or a Slack worker that re-posts it every morning, is
// the nag Kevin asked us to remove — and it would look like the feature was
// never built rather than like a bug. So this suite is mostly about the four
// surfaces holding the same rule, not about any one of them being clever.
//
// The blank case is the one that ends careers here (see the Report Amount
// incident: 8,667 transactions blanked because a formula was tested against a
// populated record and never an empty one). Almost every task in the base has
// no Deferred Until at all. If the clause is wrong for blanks, the approval
// queue does not lose one item, it loses ALL of them.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(resolve(root, f), 'utf8');

const agentsPage = read('os/agents/index.html');
const shared = read('js/shared.js');
const worker = read('scripts/slack-automation/approvals.js');
const brief = read('scripts/slack-automation/money-daily-worker.js');
const tasksPage = read('os/tasks/index.html');
const config = read('js/config.js');
// The two COUNTING surfaces, found 28 Aug 2026 — see the block at the bottom.
const huddle = read('scripts/agent-accuracy-report.py');
const dashboard = read('js/dashboard.js');

// The field the whole feature turns on. Created on the live base 28 Aug 2026.
const DEFERRED_FIELD_ID = 'fldJ9IHS1yxwYzYSN';
const DEFERRED_FIELD_NAME = 'Deferred Until';

// Pull a real function out of a source file and evaluate it, rather than
// pasting a copy that drifts. Same approach as tests/recon-vendor-key.test.js.
function extract(src, name, where) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${where}`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name} in ${where}`);
  return src.slice(start, end);
}

const apvWaitingSince = new Function(
  `${extract(agentsPage, 'apvWaitingSince', 'os/agents/index.html')}; return apvWaitingSince;`)();
const apvDeferReasonFrom = new Function(
  `${extract(agentsPage, 'apvDeferReasonFrom', 'os/agents/index.html')}
   ; return apvDeferReasonFrom;`)();
// isKnockedBack calls todayStr(), so it needs that in scope. Both come out of
// the same file, so a change to either is caught here.
const isKnockedBack = new Function(
  `${extract(tasksPage, 'todayStr', 'os/tasks/index.html')}
   ${extract(tasksPage, 'isKnockedBack', 'os/tasks/index.html')}
   ; return isKnockedBack;`)();
const apvDatePlus = new Function(
  `${extract(agentsPage, 'apvDatePlus', 'os/agents/index.html')}; return apvDatePlus;`)();

const todayLocal = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

describe('the field the feature turns on', () => {
  it('every file that reads it names the SAME field', () => {
    // A second Deferred-Until-shaped field, or a typo'd id, would return
    // 200 OK with an empty list on one surface and the truth on another —
    // the exact "broken query is indistinguishable from an empty result"
    // failure the Airtable conventions warn about.
    expect(config).toContain(DEFERRED_FIELD_ID);
    expect(agentsPage).toContain(DEFERRED_FIELD_ID);
    expect(worker).toContain(DEFERRED_FIELD_ID);
    expect(tasksPage).toContain(DEFERRED_FIELD_ID);
    // The brief queries by NAME, not id — it is the one caller that does.
    expect(brief).toContain(`'${DEFERRED_FIELD_NAME}'`);
  });

  it('js/config.js records it, so no feature file has to invent the id', () => {
    expect(config).toMatch(/deferredUntil:\s*'fldJ9IHS1yxwYzYSN'/);
  });
});

describe('the queue formula', () => {
  // The exact string used by the page. Read out of the source so a change to
  // the clause has to come through this test.
  const m = agentsPage.match(/const APV_QUEUE_FORMULA = "([^"]+)"/);
  const badge = shared.match(/const AGENTS_BADGE_FORMULA = "([^"]+)"/);

  it('exists in both the page and the shell badge', () => {
    expect(m).not.toBeNull();
    expect(badge).not.toBeNull();
  });

  it('is byte-identical across the two, so the badge cannot count a hidden task', () => {
    // Already guarded by tests/agent-register-surfaces.test.js; asserted again
    // here because THIS is the change that made the two strings long enough to
    // be worth composing from parts, which is how they would drift.
    expect(badge[1]).toBe(m[1]);
  });

  it('excludes anything knocked back to a future date', () => {
    expect(m[1]).toContain(`NOT(IS_AFTER({${DEFERRED_FIELD_NAME}}, TODAY()))`);
  });

  it('still requires Status Approval and a raising agent', () => {
    // 22 legacy property-admin records sit at Status Approval for ever with no
    // raiser. Losing this clause while adding the date one would put all of
    // them in Kevin's queue.
    expect(m[1]).toContain("{Status}='Approval'");
    expect(m[1]).toContain("LEN({Sent For Approval By}&'')>0");
  });

  it('uses IS_AFTER, never a bare > or a blank-equality test', () => {
    // `{Deferred Until} > TODAY()` and `{Deferred Until} != BLANK()` both go
    // wrong on an empty date field, which is nearly every task in the base.
    // IS_AFTER(blank, TODAY()) is false, so NOT(...) is true and blanks show —
    // proven against the live base, see the note below.
    expect(m[1]).not.toMatch(/\{Deferred Until\}\s*[<>]/);
  });

  // Back-tested against the LIVE base on 28 Aug 2026, because a fixture cannot
  // see how Airtable treats a blank date:
  //     control (no date clause)     66
  //     with the clause             66   ← blanks still show
  //     one record set to +7 days   65   (1 deferred)
  //     that record set to TODAY    66   ← returns on the day, not after it
  //     that record set to -1 day   66
  // The record was cleared afterwards. The "set to TODAY" line is the one that
  // matters: "back in a week" has to mean back ON that day.
  it('the deferred-lane formula is the exact complement of the queue one', () => {
    const def = agentsPage.match(/const APV_DEFERRED_FORMULA = "([^"]+)"/);
    expect(def).not.toBeNull();
    // Same population, opposite date test — so no task can fall between the
    // two lists and be visible in neither.
    expect(def[1]).toBe(m[1].replace(`NOT(IS_AFTER({${DEFERRED_FIELD_NAME}}, TODAY()))`,
                                     `IS_AFTER({${DEFERRED_FIELD_NAME}}, TODAY())`));
  });
});

describe('the Slack loop honours the same date', () => {
  it('does not post a knocked-back approval', () => {
    const post = worker.slice(worker.indexOf('async function postPending'),
                              worker.indexOf('async function postPending') + 400);
    expect(post).toContain('NOT_DEFERRED');
    expect(worker).toMatch(/const NOT_DEFERRED = `NOT\(IS_AFTER\(\{Deferred Until\}, TODAY\(\)\)\)`/);
  });

  it('closes a live thread when something is knocked back after it was posted', () => {
    // Without this the message sits in the DM for a week saying "waiting", and
    // the timestamp is never cleared — so the day the deferral expires,
    // postPending skips it (it still has a timestamp) and the task never
    // comes back. This clause is what makes the return automatic.
    expect(worker).toContain("OR({Status}!='Approval', IS_AFTER({Deferred Until}, TODAY()))");
  });

  it('tells the thread the return DATE, not just that it went away', () => {
    expect(worker).toMatch(/Knocked back until \*\$\{t\.deferredUntil\}\*/);
  });

  it('reads the date onto the task view, or every check above is undefined', () => {
    expect(worker).toMatch(/deferredUntil:\s*String\(f\[AF\.deferredUntil\]/);
  });
});

describe("the CEO brief stops counting what Kevin parked", () => {
  it('fetches the field', () => {
    expect(brief).toMatch(/'fields\[\]':.*'Deferred Until'/);
  });

  it('excludes knocked-back tasks from the waiting count', () => {
    expect(brief).toMatch(/const parked = x =>.*x\.deferred > today/s);
    expect(brief).toMatch(/const waiting = t\.filter\(x => x\.status === 'Approval' && !parked\(x\)\)/);
  });

  it('still counts everything else at Approval as waiting', () => {
    // The split that keeps approvals out of the overdue count must survive.
    expect(brief).toContain("const live = t.filter(x => x.status !== 'Approval')");
  });
});

describe('isKnockedBack — the Tasks drawer predicate', () => {
  const t = (status, deferredUntil) => ({ status, deferredUntil });

  it('hides a task knocked back to the future', () => {
    expect(isKnockedBack(t('Approval', apvDatePlus(7)))).toBe(true);
  });

  it('shows a task with no date at all — the case nearly every task is in', () => {
    expect(isKnockedBack(t('Approval', ''))).toBe(false);
    expect(isKnockedBack(t('Approval', undefined))).toBe(false);
  });

  it('shows it again ON the day, not the day after', () => {
    // "Bring it back in a week" has to land on the day Kevin picked. Off by
    // one here and the confirmation statement he can finally file sits hidden
    // for another day.
    expect(isKnockedBack(t('Approval', todayLocal()))).toBe(false);
  });

  it('shows it when the date has passed', () => {
    expect(isKnockedBack(t('Approval', apvDatePlus(-1)))).toBe(false);
  });

  it('never applies to a task that is not at Approval', () => {
    // A stale date left on a task that has since been approved must not hide
    // it from the board.
    expect(isKnockedBack(t('Today', apvDatePlus(7)))).toBe(false);
    expect(isKnockedBack(t('Completed', apvDatePlus(7)))).toBe(false);
  });
});

describe('apvWaitingSince — a returning task has not been waiting all week', () => {
  const WEEK_AGO = '2026-08-21T09:00:00.000Z';

  it('leaves an ordinary task alone', () => {
    expect(apvWaitingSince(WEEK_AGO, '')).toBe(WEEK_AGO);
    expect(apvWaitingSince(WEEK_AGO, null)).toBe(WEEK_AGO);
  });

  it('restarts the clock at the date it came back', () => {
    // Otherwise it returns already stamped "waiting 8 days", trips the
    // over-24-hours check on its first morning back, and rings an alarm about
    // the one thing Kevin handled correctly.
    expect(apvWaitingSince(WEEK_AGO, '2026-08-28')).toBe('2026-08-28T00:00:00.000Z');
  });

  it('never moves the clock backwards over a fresh Slack baseline', () => {
    // The worker re-posts the card on the return day and stamps a new
    // baseline. An older Deferred Until must not overwrite it.
    const fresh = '2026-08-28T07:05:00.000Z';
    expect(apvWaitingSince(fresh, '2026-08-28')).toBe(fresh);
  });

  it('survives a task with no timestamp of any kind', () => {
    expect(apvWaitingSince('', '2026-08-28')).toBe('2026-08-28T00:00:00.000Z');
  });
});

describe('apvDeferReasonFrom — the note to his future self', () => {
  it('reads the reason back out of Feedback History', () => {
    const h = '[2026-08-28 13:40] Knocked back to 2026-09-04: waiting on the Companies House authentication code';
    expect(apvDeferReasonFrom(h)).toBe('waiting on the Companies House authentication code');
  });

  it('takes the MOST RECENT knock-back when there have been several', () => {
    const h = [
      '[2026-08-01 09:00] Knocked back to 2026-08-08: waiting on the accountant',
      '',
      '[2026-08-28 13:40] Knocked back to 2026-09-04: waiting on the auth code',
    ].join('\n');
    expect(apvDeferReasonFrom(h)).toBe('waiting on the auth code');
  });

  it('returns empty rather than guessing when he gave no reason', () => {
    expect(apvDeferReasonFrom('[2026-08-28 13:40] Knocked back to 2026-09-04')).toBe('');
  });

  it('never mistakes ordinary approval feedback for a knock-back reason', () => {
    // Feedback History is shared with the rejection archive. A rejection that
    // happens to mention a date must not surface as "waiting on…".
    const h = '[2026-08-27 10:00] Roy is dealing with this directly.';
    expect(apvDeferReasonFrom(h)).toBe('');
    expect(apvDeferReasonFrom('')).toBe('');
  });
});

describe('the card offers both missing verdicts', () => {
  it('has an explicit Reject button, not only the reason chips', () => {
    // Before this change the ONLY route to a rejection was one of seven chips.
    // If none of them fitted, there was no way to reject at all — which is
    // what Kevin was asking for when he said "can I also have an option to
    // reject".
    expect(agentsPage).toMatch(/data-apv-btn onclick="agDecide\('\$\{t\.id\}','Rejected'\)"/);
  });

  it('still forces a typed reason on that button', () => {
    // agDecide treats Rejected as needsNote. A one-click reject with no reason
    // would put unclassified rejections back into the accuracy score, which is
    // the thing the chips were built to stop.
    expect(agentsPage).toMatch(/const needsNote = \(outcome==='Changes requested' \|\| outcome==='Rejected'\)/);
  });

  it('offers a week as one of the knock-back options', () => {
    expect(agentsPage).toMatch(/\{ days: 7,\s*label: 'A week'\s*\}/);
  });

  it('renders the knock-back row on every approval card', () => {
    expect(agentsPage).toContain('${apvDeferRow(t.id)}');
  });
});

describe('nothing is hidden without being reported', () => {
  it('loads the deferred list alongside the queue', () => {
    expect(agentsPage).toContain('loadDeferred(),');
  });

  it('renders the deferred lane even when the queue is empty', () => {
    // The failure to fear: every waiting item knocked back, the page says
    // "Nothing is waiting for your approval", and there is no sign anywhere
    // that eleven things are parked.
    const render = agentsPage.slice(agentsPage.indexOf('function renderApprovals()'),
                                    agentsPage.indexOf('function setApvAgentFilter'));
    expect(render).toContain('const laterHtml = apvDeferredLaneHtml()');
    expect(render).toMatch(/body\.innerHTML = laterHtml \+ `<div class="empty-state">/);
    expect(render).toContain('let html = laterHtml +');
  });

  it('a failed load of that list says so instead of showing nothing', () => {
    const lane = agentsPage.slice(agentsPage.indexOf('function apvDeferredLaneHtml()'),
                                  agentsPage.indexOf('function renderApprovals()'));
    expect(lane).toContain('Could not load what you have knocked back');
    expect(lane).toContain('Some approvals may be hidden');
  });

  it('offers a way back out of a knock-back', () => {
    expect(agentsPage).toContain('function agUndefer(');
    expect(agentsPage).toContain('Bring back now');
  });
});

describe('the queue asserts the filter held, client-side', () => {
  // A renamed field throws (Airtable 422 on an unknown field in a formula) and
  // the existing "Approvals queue read" check catches that. The quieter case
  // is a formula that stops EXCLUDING: it returns 200 OK with more rows, which
  // looks like a busy morning rather than a bug. This is the same discipline
  // as the "Legacy Approval records excluded" check that already sits beside
  // it, applied to the new clause.
  it('carries the date onto each queued item so it can be checked', () => {
    expect(agentsPage).toMatch(/deferredUntil: String\(gf\(r,TF\.deferredUntil\)\|\|''\)\.slice\(0,10\)/);
  });

  it('fails the sync bar if a knocked-back task reappears early', () => {
    const check = agentsPage.slice(agentsPage.indexOf("name: 'Knocked-back items stay out'"),
                                   agentsPage.indexOf("name: 'Agents register read'"));
    expect(check).toContain('t.deferredUntil > today');
    expect(check).toContain("status:'fail'");
    // And it must not read as a clean pass when the deferred list itself
    // failed to load — that is the state where things are hidden and nothing
    // on screen says so.
    expect(check).toContain('_deferredState');
  });
});

describe('the write itself', () => {
  const fn = agentsPage.slice(agentsPage.indexOf('async function applyApprovalDefer'),
                              agentsPage.indexOf('async function agUndefer'));

  it('never writes an approval outcome — this is the absence of a verdict', () => {
    // A knock-back that recorded an outcome would score the agent for work
    // Kevin has not judged, and would hand the task back to it to carry out.
    expect(fn).not.toContain('approvalOutcome');
    expect(fn).not.toContain('approvedAt');
    expect(fn).not.toContain('verdictReason');
  });

  it('never changes Status, so the agent\'s work stays exactly where it is', () => {
    expect(fn).not.toMatch(/payload\[TF\.status\]/);
  });

  it('leaves the Slack fields to the worker — one writer', () => {
    expect(fn).not.toMatch(/payload\[TF\.slackTs\]/);
    expect(fn).not.toMatch(/payload\[TF\.slackBaseline\]/);
  });

  it('re-reads the task first, so it cannot park something already decided', () => {
    expect(fn).toContain('atFetchOne(TASKS_TBL, taskId)');
    expect(fn).toContain("!== 'Approval'");
  });

  it('appends to Feedback History rather than overwriting it', () => {
    // That field is the durable archive of every reason Kevin has ever given.
    expect(fn).toContain('const prior = String(gf(live,TF.feedbackHistory)');
    expect(fn).toMatch(/payload\[TF\.feedbackHistory\] = \(prior/);
  });

  it('refuses a date that is not in the future', () => {
    const picker = agentsPage.slice(agentsPage.indexOf('function agDeferOnDate'),
                                    agentsPage.indexOf('function apvConfirmDefer'));
    expect(picker).toContain('until <= todayStr()');
  });
});

// ─── THE TWO SURFACES NOBODY COUNTED (found 28 Aug 2026) ─────────────
//
// The knock-back shipped with five surfaces honouring the date. Two more were
// missed, and both were missed for the same reason: they REPORT a number
// rather than RENDER a queue, so they did not look like "approval filters".
//
// Measured live that afternoon: Kevin's real queue held 56 items, four of them
// knocked back to September at his own request. The CEO huddle read "60
// waiting" and the Leadership Dashboard card read 60 too. He parks something
// and two of the places he looks keep nagging him about it — which is exactly
// the failure mode the original five were built to avoid, and it reads as "the
// feature was never built" rather than as a bug.
//
// A counting surface is an approval filter. That is the rule these guard.
describe('the surfaces that COUNT the queue honour the date too', () => {
  it('the CEO huddle does not count what Kevin parked', () => {
    const m = huddle.match(/waiting = query\(\s*token,\s*TASKS,([\s\S]{0,300}?)\[/);
    expect(m, 'could not find the waiting query in agent-accuracy-report.py').toBeTruthy();
    expect(m[1]).toContain('Deferred Until');
    expect(m[1]).toContain('NOT(IS_AFTER(');
    // Still only Approval — widening the status while adding the date would
    // swap one wrong number for another.
    expect(m[1]).toContain("{Status} = 'Approval'");
  });

  it('the Leadership Dashboard card does not count what Kevin parked', () => {
    // The front page disagreeing with the page it links to, about the one
    // number the card exists to report.
    const m = dashboard.match(/filterByFormula=\$\{encodeURIComponent\(`([^`]*Status[^`]*Approval[^`]*)`\)/);
    expect(m, 'could not find the waiting-count fetch in js/dashboard.js').toBeTruthy();
    expect(m[1]).toContain('Deferred Until');
    expect(m[1]).toContain('NOT(IS_AFTER(');
  });

  it('both use the SAME boundary as the queue itself', () => {
    // The date is IN. `> TODAY()` and `!= BLANK()` both go wrong on an empty
    // field, which is nearly every task in the base — that mistake empties the
    // count rather than losing one item, so it would look like good news.
    for (const [name, src] of [['huddle', huddle], ['dashboard', dashboard]]) {
      const idx = src.indexOf('Deferred Until');
      expect(idx, `${name} never names the field`).toBeGreaterThan(-1);
      const near = src.slice(Math.max(0, idx - 200), idx + 200);
      expect(near, `${name} uses the wrong boundary`).toContain('NOT(IS_AFTER(');
    }
  });

  it('every surface that reads the field agrees it is called the same thing', () => {
    // CONTROL: if the field were renamed, each check above would still pass on
    // its own literal while the live query returned nothing.
    for (const [name, src] of [['huddle', huddle], ['dashboard', dashboard]]) {
      expect(src, `${name}`).toContain(DEFERRED_FIELD_NAME);
    }
  });
});
