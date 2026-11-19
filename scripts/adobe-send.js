#!/usr/bin/env node
/**
 * adobe-send.js — press Send on ONE named Adobe draft, on Kevin's yes.
 *
 * WHY THIS EXISTS (Kevin, 10 Nov 2026)
 * ------------------------------------
 * adobe-assign.js builds a tenancy agreement in Adobe and stops before Send, on purpose:
 * Kevin checks the boxes first. The tenant-doc-generator skill then said "turn signing
 * order on, then Send", but nothing in the repo did it, so every pack session wrote its
 * own one-off browser script (George O'Reilly, 10 Nov 2026). Kevin asked for the gap
 * closed the same day.
 *
 * WHAT IT REFUSES, IN CODE
 * ------------------------
 * - Any run that is not a chat Kevin is in AND carries no approved task: a robot slot
 *   (AGENT_SLOT_SCRATCH), the task manager (TASK_MANAGER_SCRATCH), or any session not marked
 *   attended (CLAUDE_CODE_SESSION_ATTENDED=1). Sending a legal document is Kevin's yes.
 *
 * THE APPROVED-TASK ROUTE (findings 20261117-agent-dispatch-1338, 20261114-agent-dispatch-1307)
 * ---------------------------------------------------------------------------------------------
 * Kevin approved Brett Peters' pack on 17 Nov 2026 and nothing sent it: the only send door
 * refused every unattended run, and no robot slot could press Send on work he had already
 * said yes to. So `--task recXXXX` opens the door instead of his presence in the chat, and
 * ONLY on all four of:
 * - the task carries the marks of a real approval (scripts/approval_evidence.py: it went
 *   through the gate, an approval was recorded, and it was recorded AFTER the task existed).
 *   An Approval Outcome STRING is never an approval; a child of an approved parent is not
 *   approved (finding 20260922-agent-dispatch-572);
 * - its Approval Outcome is one of the approved verdicts;
 * - the approved card NAMES this draft, so a task approved for something else cannot unlock
 *   an unrelated document;
 * - every check below still passes, first signer and signing order included.
 * With no --task, or evidence that does not hold, the refusal above stands word for word.
 * This does not remove Kevin's approval. It removes the requirement that he sit in the chat
 * while an already-approved send runs.
 * - A name that matches no draft, or more than one. A sent agreement leaves Drafts, so a
 *   later run for the same document normally finds nothing and refuses. The list can lag a
 *   send, though, so exit 3 (pressed, not confirmed) is never a reason to run it again
 *   (28 Sep 2026: a retry made a second proof of residency after Kevin had signed the first).
 * - A draft whose first recipient is not info@agilelets.co.uk (Agile Lets signs first).
 * - A draft with two or more recipients whose "Recipients must complete in order" switch
 *   does not read ON after the script turns it on (Kevin, 28 Sep 2026).
 *
 * PROOF
 * -----
 * Adobe's own line "<name> was successfully sent for signature". Without it the run exits 3
 * and says not to run it again: read Waiting for you first.
 *
 * USAGE
 *   node scripts/adobe-send.js --title "AST_Jane_Testwood_5_Dalham_Place" --shot out.png [--open-only]
 *   node scripts/adobe-send.js --title "AST_Jane_Testwood_5_Dalham_Place" --task recTJKgCkUjK5O7o9
 *   node scripts/adobe-send.js --selftest
 *   --open-only opens the draft, reads its recipients and the switch, screenshots, presses nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE = path.join(os.homedir(), '.config', 'od', 'agent-browser', 'default');
const DRAFTS_URL = 'https://acrobat.adobe.com/link/documents/agreements/#agreement_type=agreement&agreement_state=draft';
const FIRST_SIGNER = 'info@agilelets.co.uk';
const SEL = {
  draftsFilter: '[data-testid="draft"]',
  send: '[data-testid="review-send-button"]',
  recipientRow: '[data-testid^="recipient-list-item-"]',
};
// Measured 10 Nov 2026: the drafts list paints about 20 s after its nav, the filter in 9 s.
const WAIT = { list: 20000, filter: 9000, editor: 60000, settle: 3000, confirm: 90000 };

// The approved-task route. Field ids, never names: a name-keyed read of an id-keyed record
// returns blank, and a blank approval mark reads as "no approval", which looks like the gate
// working while it is in fact blind (CLAUDE.md, Airtable queries).
const BASE_ID = 'appnqjDpqDniH3IRl';
const TASKS = 'tblqB8b22hKBL4PF1';
const TF = {
  name: 'fldgFjGBw6bTKJFCD',
  notes: 'fldR7apBzSp3oxFxz',
  approvalOutcome: 'fldrHBSr6qoUfaKuZ',
  agentOutput: 'fldzswp8fx6PqpLQ5',
};
const APPROVED = ['Approved as-is', 'Approved with minor edits'];   // scripts/agent-dispatch.py APPROVED
const EVIDENCE_PY = path.join(__dirname, 'approval_evidence.py');
const SENT_LEDGER = path.join(os.homedir(), 'knowledge-os', 'logs', 'agent-dispatch', 'sent-adobe.jsonl');

let THROW_ON_REFUSE = require.main !== module;
function die(msg, code = 1) {
  if (THROW_ON_REFUSE) throw new Error('SEND REFUSED: ' + msg);
  console.error('SEND REFUSED: ' + msg);
  process.exit(code);
}

/** Why this process may not send, or '' when it may. */
function headlessRefusal(env) {
  if (env.AGENT_SLOT_SCRATCH) return 'this is a robot slot run. Robots build drafts with adobe-assign.js and never send.';
  if (env.TASK_MANAGER_SCRATCH) return 'this is a task manager run. Only a chat Kevin is in may send.';
  if (String(env.CLAUDE_CODE_SESSION_ATTENDED || '') !== '1') {
    return 'this session is not one Kevin is in (CLAUDE_CODE_SESSION_ATTENDED is not 1). Sending needs his yes in the chat.';
  }
  return '';
}

/** A select cell as its name, however Airtable returned it. */
function sel(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? String(v.name || '') : String(v || '');
}

/** Loose enough to read "AST_Brett_Peters" out of prose, strict enough to stay the same document. */
function flat(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Does the approved card name THIS draft? A task approved for something else must not unlock it. */
function cardNamesDraft(fields, title) {
  const hay = flat([fields[TF.name], fields[TF.agentOutput], fields[TF.notes]].join(' \n '));
  const needle = flat(title);
  return !!needle && hay.includes(needle);
}

/**
 * Why this task id does NOT stand in for Kevin sitting in the chat, or '' when it does.
 * `task` is the Tasks record keyed by FIELD ID, with the verdict of
 * scripts/approval_evidence.py on it as `evidenceProblem`.
 */
function approvalProblem(taskId, task, title) {
  const id = String(taskId || '').trim();
  if (!id) return 'no --task was given';
  if (!task) return `task ${id} could not be read from Tasks`;
  const fields = task.fields || {};
  const evidence = String(task.evidenceProblem == null ? 'its approval evidence was never checked' : task.evidenceProblem);
  if (evidence) return `task ${id} carries no real approval: ${evidence}`;
  const outcome = sel(fields[TF.approvalOutcome]);
  if (!APPROVED.includes(outcome)) {
    return `task ${id} is not approved (Approval Outcome reads ${JSON.stringify(outcome || '(empty)')})`;
  }
  if (!cardNamesDraft(fields, title)) {
    return `the approved card on task ${id} does not name "${title}", so its approval is for another send`;
  }
  return '';
}

/**
 * The one gate. '' when this process may send.
 *
 * `approval` is null when no --task was given, else { taskId, problem } from approvalProblem().
 * An attended chat sends as it always has. Otherwise a task whose approval is real and names
 * this draft opens the door; anything else gets headlessRefusal()'s words unchanged.
 */
function sendRefusal(env, approval) {
  const why = headlessRefusal(env);
  if (!why) return '';
  if (approval && approval.problem === '') return '';
  return why;
}

/** The draft name: long enough that it cannot match the wrong agreement. */
function checkTitle(raw) {
  const t = String(raw || '').trim();
  if (!t) die('--title is required: the draft\'s name as Adobe lists it.');
  if (t.length < 12) die(`"${t}" is too short to pick one draft safely. Give at least 12 characters.`);
  return t;
}

/** Recipient rows as Adobe prints them ("info@agilelets.co.uk (myself)"), checked. */
function checkRecipients(rows) {
  const list = (rows || []).map((r) => String(r).replace(/\s+/g, ' ').replace(/\(myself\)/i, '').trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) die('the draft lists no recipients.');
  if (list[0] !== FIRST_SIGNER) die(`the first recipient is ${list[0]}, not ${FIRST_SIGNER}. Agile Lets signs first.`);
  return { recipients: list, needsOrder: list.length > 1 };
}

/** Adobe's confirmation for exactly this draft. */
function confirmed(bodyText, title) {
  const t = String(bodyText || '').replace(/\s+/g, ' ');
  return t.includes(`${title} was successfully sent for signature`);
}

// ─── the approved-task route: reading the task, and the trail it leaves ──────────────────

let PAT = null;
const pat = () => PAT || (PAT = fs.readFileSync(path.join(os.homedir(), '.config', 'od', 'airtable_pat'), 'utf8').trim());

/** One Airtable call. Field ids in, field ids out: the read-modify-write below uses one key style. */
function airtable(method, pathAndQuery, body) {
  const https = require('https');
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((res, rej) => {
    const req = https.request({
      hostname: 'api.airtable.com', method, path: `/v0/${BASE_ID}${pathAndQuery}`,
      headers: Object.assign({ Authorization: 'Bearer ' + pat() },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) rej(new Error(JSON.stringify(j.error)));
          else res(j);
        } catch (e) { rej(e); }
      });
    });
    req.on('error', rej);
    if (payload) req.write(payload);
    req.end();
  });
}

/** approval_evidence.py's verdict on this record. The same module every other send door uses. */
function evidenceProblem(record) {
  const { execFileSync } = require('child_process');
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ae", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.argv[2])
sys.stdout.write(m.approval_evidence_problem(a["fields"], a["createdTime"]))
`;
  return execFileSync('python3', ['-I', '-c', py, EVIDENCE_PY, JSON.stringify({
    fields: record.fields || {}, createdTime: record.createdTime || '',
  })], { encoding: 'utf8' });
}

/** { taskId, problem } for this task and draft. A read that fails is a problem, never a pass. */
async function loadApproval(taskId, title) {
  let task = null;
  try {
    // returnFieldsByFieldId is NOT optional: TF is keyed by field id (send-letter.py get_task).
    const rec = await airtable('GET', `/${TASKS}/${encodeURIComponent(taskId)}?returnFieldsByFieldId=true`);
    task = { fields: rec.fields || {}, createdTime: rec.createdTime || '', evidenceProblem: evidenceProblem(rec) };
  } catch (e) {
    return { taskId, problem: `task ${taskId} could not be read from Tasks (${String(e.message).split('\n')[0]})` };
  }
  return { taskId, problem: approvalProblem(taskId, task, title) };
}

function ledgerAppend(row) {
  try {
    fs.mkdirSync(path.dirname(SENT_LEDGER), { recursive: true });
    fs.appendFileSync(SENT_LEDGER, JSON.stringify(row) + '\n');
  } catch (e) {
    console.error('WARNING: the adobe ledger row could not be written: ' + e.message);
  }
}

/** The stamped Notes line, the shape send-email.py writes (Kevin, 8 Sep 2026: one dated trail). */
function noteLine(title, recipients, orderOn, when) {
  const d = when || new Date();
  const stamp = `${String(d.getDate()).padStart(2, '0')} `
    + `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} `
    + `${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `[${stamp} — adobe-send] SENT: "${title}" for signature to ${(recipients || []).join(', ')}`
    + ` (signing order ${orderOn ? 'ON' : 'not needed'})`;
}

/** One stamped line on the task. A send only in a local ledger is invisible on the next card. */
async function stampNotes(taskId, line) {
  try {
    const rec = await airtable('GET', `/${TASKS}/${encodeURIComponent(taskId)}?returnFieldsByFieldId=true`);
    const notes = String((rec.fields || {})[TF.notes] || '').replace(/\s+$/, '');
    await airtable('PATCH', `/${TASKS}/${encodeURIComponent(taskId)}`,
      { fields: { [TF.notes]: (notes + '\n\n' + line).trim().slice(-90000) }, typecast: false });
    return true;
  } catch (e) {
    console.error(`WARNING: sent, but the SENT stamp could not be written: ${String(e.message).split('\n')[0]}`);
    return false;
  }
}

async function run({ title, shot, openOnly, taskId }) {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1280, height: 2400 },
    channel: fs.existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined,
    ignoreDefaultArgs: fs.existsSync('/Applications/Google Chrome.app') ? ['--enable-automation'] : undefined,
  });
  const log = (m) => console.error(new Date().toISOString().slice(11, 19) + ' ' + m);
  const snap = async () => { if (shot) await page.screenshot({ path: shot }).catch(() => {}); };
  let page;
  try {
    page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(DRAFTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(WAIT.list);
    // The address alone shows ALL agreements; the side panel's Drafts item filters (adobe-drafts.js, 11 Sep 2026).
    if (!(await page.locator(SEL.draftsFilter).first().click({ timeout: 15000 }).then(() => true).catch(() => false))) {
      await snap();
      die('the Drafts filter did not draw (signed out?). Nothing was sent.');
    }
    await page.waitForTimeout(WAIT.filter);
    const rows = page.locator('[role="row"]', { hasText: title });
    const n = await rows.count();
    log(`drafts matching "${title}": ${n}`);
    if (n !== 1) {
      await snap();
      die(n ? `${n} drafts match "${title}". Delete the duplicate (adobe-drafts.js) first. Nothing was sent.`
            : `no draft matches "${title}". If it was sent already, it is in Waiting for you. Nothing was sent.`);
    }
    const row = rows.first();
    const cell = row.locator(`[title*=${JSON.stringify(title)}]`).first();
    await ((await cell.count()) ? cell : row).click({ timeout: 15000 });
    const open = await page.locator(SEL.send).waitFor({ state: 'visible', timeout: WAIT.editor }).then(() => true).catch(() => false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(WAIT.settle);
    if (!open) { await snap(); die('the draft did not open in the editor. Nothing was sent.'); }

    const { recipients, needsOrder } = checkRecipients(await page.locator(SEL.recipientRow).allInnerTexts());
    log('recipients in order: ' + recipients.join(', '));
    const named = page.getByRole('switch', { name: /complete in order/i });
    const hasSwitch = (await named.count()) === 1;
    let orderOn = hasSwitch ? await named.isChecked().catch(() => null) : null;
    if (needsOrder) {
      if (!hasSwitch) { await snap(); die('no "Recipients must complete in order" switch on a draft with two recipients. Nothing was sent.'); }
      if (!orderOn) {
        await named.click({ force: true });
        await page.waitForTimeout(WAIT.settle);
        orderOn = await named.isChecked().catch(() => null);
      }
      log('signing order: ' + (orderOn ? 'ON' : 'OFF'));
      if (!orderOn) { await snap(); die('the signing order switch would not turn on. Nothing was sent.'); }
    }
    if (openOnly) {
      await snap();
      return { title, recipients, orderOn, sent: false, note: 'Opened only. Nothing was pressed except the order switch.' };
    }
    // Intent first, as the email door does: if this process dies between the press and the
    // confirmation, the trail says a send may have gone, so nobody retries it blind.
    if (taskId) ledgerAppend({ task: taskId, ts: new Date().toISOString(), event: 'intent', kind: 'adobe-send', title, recipients });
    await page.locator(SEL.send).click();
    log('pressed Send');
    const seen = await page.getByText(new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was successfully sent for signature`))
      .first().waitFor({ state: 'visible', timeout: WAIT.confirm }).then(() => true).catch(() => false);
    await snap();
    const body = await page.locator('body').innerText().catch(() => '');
    if (!seen || !confirmed(body, title)) {
      if (taskId) ledgerAppend({ task: taskId, ts: new Date().toISOString(), event: 'uncertain', kind: 'adobe-send', title, recipients });
      die('Send was pressed but Adobe\'s "successfully sent" line did not show. Do NOT run this again: '
        + 'read Waiting for you and Completed for the name first.', 3);
    }
    const proof = `${title} was successfully sent for signature`;
    let stamped = null;
    if (taskId) {
      ledgerAppend({ task: taskId, ts: new Date().toISOString(), event: 'sent', kind: 'adobe-send', title, recipients, orderOn, proof });
      stamped = await stampNotes(taskId, noteLine(title, recipients, orderOn));
    }
    return { title, task: taskId || null, recipients, orderOn, sent: true, proof, noteStamped: stamped, screenshot: shot || null };
  } finally {
    await ctx.close();
  }
}

function arg(list, name) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : null;
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  const taskId = (arg(rest, 'task') || '').trim();
  const unattended = headlessRefusal(process.env);
  if (unattended && !taskId) die(unattended);   // the old order, word for word, when no task is given
  const title = checkTitle(arg(rest, 'title'));
  let approval = null;
  if (unattended) {
    // Only read the task when it has work to do: an attended chat sends as it always has.
    approval = await loadApproval(taskId, title);
    if (approval.problem) console.error('adobe-send: the --task route did not open this run: ' + approval.problem + '.');
    else console.error(`adobe-send: unattended run allowed by the approval on task ${taskId}.`);
  }
  const why = sendRefusal(process.env, approval);
  if (why) die(why);
  const res = await run({ title, taskId: taskId || null, shot: arg(rest, 'shot'), openOnly: rest.includes('--open-only') });
  console.log(JSON.stringify(res, null, 2));
}

function selftest() {
  THROW_ON_REFUSE = true;
  const cases = [];
  const check = (n, f) => { try { cases.push([n, !!f()]); } catch { cases.push([n, false]); } };
  const refuses = (f) => { try { f(); return false; } catch { return true; } };
  check('a robot slot may not send', () => /robot/.test(headlessRefusal({ AGENT_SLOT_SCRATCH: '/x', CLAUDE_CODE_SESSION_ATTENDED: '1' })));
  check('the task manager may not send', () => !!headlessRefusal({ TASK_MANAGER_SCRATCH: '/x', CLAUDE_CODE_SESSION_ATTENDED: '1' }));
  check('an unattended session may not send', () => !!headlessRefusal({}));
  check('an attended chat may send', () => headlessRefusal({ CLAUDE_CODE_SESSION_ATTENDED: '1' }) === '');
  const okTask = {
    fields: { [TF.name]: 'TENANCY PACK: send AST_Jane_Testwood_5_Dalham_Place', [TF.approvalOutcome]: { name: 'Approved as-is' } },
    createdTime: '2026-11-17T09:00:00.000Z', evidenceProblem: '',
  };
  check('a real approval naming the draft opens an unattended run',
    () => approvalProblem('recT', okTask, 'AST_Jane_Testwood_5_Dalham_Place') === ''
      && sendRefusal({ AGENT_SLOT_SCRATCH: '/x' }, { taskId: 'recT', problem: '' }) === '');
  check('no task id leaves the refusal unchanged',
    () => sendRefusal({}, null) === headlessRefusal({}));
  check('evidence that does not hold leaves the refusal unchanged',
    () => sendRefusal({}, { taskId: 'recT', problem: 'task recT carries no real approval: x' }) === headlessRefusal({}));
  check('a task approved for something else does not unlock this draft',
    () => /does not name/.test(approvalProblem('recT', okTask, 'Proof_of_Residency_Jane_Testwood')));
  check('an unchecked task is a problem, never a pass',
    () => !!approvalProblem('recT', { fields: okTask.fields, createdTime: okTask.createdTime }, 'AST_Jane_Testwood_5_Dalham_Place'));
  check('a short title is refused', () => refuses(() => checkTitle('AST_Jane')));
  check('info@ first passes and two recipients need the order', () => {
    const r = checkRecipients(['info@agilelets.co.uk (myself)', 'jane@example.com']);
    return r.needsOrder && r.recipients[1] === 'jane@example.com';
  });
  check('one recipient needs no order', () => checkRecipients(['info@agilelets.co.uk (myself)']).needsOrder === false);
  check('the tenant first is refused', () => refuses(() => checkRecipients(['jane@example.com', 'info@agilelets.co.uk'])));
  check('the confirmation must name this draft', () => confirmed('X  AST_Jane_Testwood was successfully sent for signature A PDF', 'AST_Jane_Testwood')
    && !confirmed('AST_Other was successfully sent for signature', 'AST_Jane_Testwood'));
  const failed = cases.filter(([, ok]) => !ok);
  cases.forEach(([n, ok]) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}`));
  if (failed.length) { console.log(`selftest FAILED: ${failed.length}`); process.exit(1); }
  console.log(`selftest OK: ${cases.length} cases`);
}

module.exports = {
  headlessRefusal, checkTitle, checkRecipients, confirmed,
  approvalProblem, sendRefusal, cardNamesDraft, noteLine, evidenceProblem,
  TF, APPROVED, EVIDENCE_PY,
};

if (require.main === module) main().catch((e) => die(e.message.split('\n')[0]));
