// NOTHING TRIAGE DECIDES STAYS IN THE INBOX (Kevin, 14 Oct 2026).
//
// "Anything I need to see should come as an approval card. But ensuring that
// feedback I give for anything I don't need to see is taken into consideration
// for the next time."
//
// Measured that day: 155 emails in the inbox, 110 of them already decided by
// the triage robot as "leave" (a person wrote it, Kevin should read it) or
// "answered" (we spoke last), the oldest from 17 Sep. `note` logged those
// decisions and changed nothing in Gmail, so every one of them stayed for ever,
// and the triage score read "0 waiting; at zero 7 of last 7 days" because left
// mail was excluded from "waiting" by design.
//
// The independent review of PR #783 (same day) tightened it: the read-only
// card holds only mail that asks nothing of anyone; there is ONE open card and
// new emails are added to it; a killed card step loses nothing; "answered"
// needs a send TO the sender; Kevin's labels are his; Kevin's notes reach the
// triage agent from where the dispatcher stores them; the score is this slot's.
//
// These tests drive the REAL scripts/inbound-triage.py, the REAL
// scripts/agent-dispatch.py lesson writer, the REAL runner and the REAL
// create-agent-task.py (against a fake Airtable over HTTP), with HOME pointed
// at a temp folder so nothing here can touch Kevin's agent files, logs or
// queue lock. Fixtures are invented: this repo is public.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const TRIAGE = resolve(SCRIPTS, 'inbound-triage.py');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const RUNNER = resolve(SCRIPTS, 'inbound-triage-run.sh');

const RESPONSE = 'recJ8J8idWE8d97tH';   // Inbox Response, Team Members row
const READ_LABEL = '19: for Kevin to read';
// The real label's id is "Label_12": nothing may read that as lane 12.
const LABELS = [
  { id: 'Label_801', name: '8: task created' }, { id: 'Label_899', name: '12: kevin to respond' },
  { id: 'Label_813', name: '13: maintenance' }, { id: 'Label_12', name: READ_LABEL },
  { id: 'Label_7', name: '2: to follow-up' },
];

/** A fresh HOME (agent files, queue lock) and state folder (digests, scan cache). */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'inbox-left-home-'));
  const state = join(home, 'triage-state');
  mkdirSync(state, { recursive: true });
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  return { home, state };
}

function envFor(box, extra = {}) {
  return { ...process.env, HOME: box.home, INBOUND_TRIAGE_DIR: box.state,
    OD_GMAIL_PACE_DIR: join(box.home, 'pace'), JOB_QUEUE_DIR: join(box.home, 'queue'), ...extra };
}

/** Python preamble: the real modules, Gmail stubbed at worker_post, and an
 *  in-memory Airtable behind the dispatcher's own task read/write functions
 *  and the card gate. Each snippet calls out(obj) once. */
const PREAMBLE = `
import importlib.util, json, sys, os, io, contextlib
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
m = load('triage_under_test', ${JSON.stringify(TRIAGE)})
ad = load('dispatch_under_test', ${JSON.stringify(DISPATCH)})
m._fail_quiet["on"] = True
AF = ad.AF
CALLS, CREATED, PATCHES, STORE = [], [], [], {}
FAIL_LIST_WRITE = False
FAIL_CANCEL = False
VERDICT_DURING_WRITE = False
LABELS = ${JSON.stringify(LABELS)}
LISTS = {}            # gmail query fragment -> messages
def fake_worker(path, payload, sleep=None):
    CALLS.append({"path": path, "payload": payload})
    if path == "/gmail/labels":
        return {"labels": LABELS}
    if path == "/gmail/modify":
        return {"modified": len(payload.get("ids") or [])}
    if path == "/gmail/list":
        q = payload.get("q") or ""
        for frag, msgs in LISTS.items():
            if frag in q:
                return {"messages": msgs}
        return {"messages": []}
    raise AssertionError("unexpected worker call " + path)
m.worker_post = fake_worker
def fake_create(fields):
    CREATED.append(fields)
    rid = "recCARD%010d" % (len(STORE) + 1)
    STORE[rid] = {"id": rid, "createdTime": "2026-10-14T%02d:00:00.000Z" % len(STORE),
                  "fields": json.loads(json.dumps(fields))}
    return rid
m._create_card = fake_create
def fake_query(formula, max_records=None, minimal=False):
    if "LEFT({Agent Output}" in formula:
        return [json.loads(json.dumps(r)) for r in STORE.values()
                if ad.sel(r["fields"].get(AF["status"])) == "Approval"
                and str(r["fields"].get(AF["agentOutput"]) or "").startswith(m.CARD_PLACEHOLDER_HEAD)]
    if "LEFT({Task Name}" in formula and "'Approval'" in formula:
        return [json.loads(json.dumps(r)) for r in STORE.values()
                if ad.sel(r["fields"].get(AF["status"])) == "Approval"
                and not r["fields"].get(AF["approvalOutcome"])
                and not r["fields"].get(AF["deferredUntil"])]
    return []
ad.query_tasks = fake_query
ad.get_task = lambda tid: json.loads(json.dumps(STORE[tid]))
def fake_patch(tid, fields):
    if FAIL_LIST_WRITE and AF["agentOutput"] in fields:
        raise RuntimeError("Airtable 503")
    if FAIL_CANCEL and fields.get(AF["status"]) == "Cancelled":
        raise RuntimeError("Airtable 503 on cancel")
    if AF["notes"] in fields and AF["status"] not in fields:
        PATCHES.append(tid)       # an append: the card's message-id line changed
    STORE[tid]["fields"].update(json.loads(json.dumps(fields)))
    if VERDICT_DURING_WRITE and AF["agentOutput"] in fields:
        STORE[tid]["fields"][AF["approvalOutcome"]] = "Rejected"
    return STORE[tid]
ad.patch_task = fake_patch
def cache(entries):
    (m.base_dir() / "scan-cache.json").write_text(json.dumps(entries))
def attempt(fn):
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            return fn(), None
    except SystemExit:
        return None, dict(m._last_fail)
def quiet(fn):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn()
def modifies():
    return [c["payload"] for c in CALLS if c["path"] == "/gmail/modify"]
def card(i=0):
    return list(STORE.values())[i]["fields"]
def digest():
    rows = []
    for p in sorted(m.base_dir().glob("digest-*.jsonl")):
        rows += [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    return rows
def out(obj):
    print("RESULT " + json.dumps(obj))
`;

function runPy(box, snippet, extraEnv = {}) {
  const stdout = execFileSync('python3', ['-c', PREAMBLE + snippet], { encoding: 'utf8', env: envFor(box, extraEnv) });
  const line = stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error('no RESULT line:\n' + stdout);
  return JSON.parse(line.slice(7));
}

const TWO_IN_INBOX = `cache({
    "mA": {"sender": "friend@gmail.com", "subject": "Photos from the weekend", "threadId": "tA",
           "internalDate": 1791800000000, "inbox": True, "ask": "", "reply_state": ""},
    "mB": {"sender": "neighbour@example.com", "subject": "Lovely to see you", "threadId": "tB",
           "internalDate": 1791700000000, "inbox": True, "ask": "", "reply_state": ""},
    "mC": {"sender": "aunt@gmail.com", "subject": "A note", "threadId": "tC",
           "internalDate": 1791750000000, "inbox": True, "ask": "", "reply_state": ""},
    "mD": {"sender": "club@example.org", "subject": "Season report", "threadId": "tD",
           "internalDate": 1791760000000, "inbox": True, "ask": "", "reply_state": ""},
    "mP": {"sender": "agent@example.co.uk", "subject": "Your invoice", "threadId": "tP",
           "internalDate": 1791760000000, "inbox": True, "ask": "money due (invoice)", "reply_state": ""},
})`;
const LEAVE_AB = `
m.cmd_note("mA", "leave", "A friend sending weekend photos, nothing asked")
m.cmd_note("mB", "leave", "A neighbour saying it was lovely to catch up")
`;

describe('"for Kevin to read" mail leaves the inbox and comes to him on ONE approval card', () => {
  it('leave labels it 19, archives it, and the run raises one card he can answer', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
quiet(lambda: m.cmd_inbox_card("17:00", dispatch=ad))
quiet(lambda: m.cmd_inbox_card("17:00", dispatch=ad))
f = card()
out({"modifies": modifies(), "cards": len(CREATED), "name": f[AF["name"]],
     "status": f[AF["status"]], "team": f[AF["teamMember"]], "sentBy": f[AF["sentForApprovalBy"]],
     "output": f[AF["agentOutput"]], "plain": f[AF["plainSummary"]], "notes": f[AF["notes"]],
     "pendingLeft": m.pending_path().exists()})
`);
    expect(r.modifies).toEqual([
      { ids: ['mA'], addLabels: [READ_LABEL], removeLabels: ['INBOX'] },
      { ids: ['mB'], addLabels: [READ_LABEL], removeLabels: ['INBOX'] },
    ]);
    // ONE card, and the second call (the runner's backstop) does nothing.
    expect(r.cards).toBe(1);
    expect(r.pendingLeft).toBe(false);
    expect(r.name).toMatch(/^INBOX: 2 emails for you to read, since \d{1,2} \w{3} 17:00$/);
    expect(r.status).toBe('Approval');
    expect(r.team).toEqual([RESPONSE]);
    expect(r.sentBy).toEqual([RESPONSE]);
    expect(r.notes).toBe('INBOX CARD MESSAGE IDS: mA,mB');
    for (const s of ['friend@gmail.com | Photos from the weekend', 'A friend sending weekend photos',
      'https://mail.google.com/mail/u/0/#all/tA', 'neighbour@example.com | Lovely to see you']) {
      expect(r.output).toContain(s);
    }
    expect(r.output.indexOf('From people')).toBeLessThan(r.output.indexOf('From companies'));
    expect(r.output).toMatch(/\*\*Carrying this out will involve:\*\* Closing this card as read\. Nothing is sent\.$/);
    expect(r.plain).toMatch(/^TASK: Read 2 emails that came in for you/);
  });

  it('the next run ADDS to the open card: one card, numbered on, so no duplicate pair can hide emails', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
quiet(lambda: m.cmd_inbox_card("09:00", dispatch=ad))
first_name = card()[AF["name"]]
m.cmd_note("mC", "leave", "An aunt writing with family news, nothing asked")
m.cmd_note("mD", "leave", "The club's season report, for reading")
quiet(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
gate = m._load_gate()
f = card()
out({"cards": len(STORE), "created": len(CREATED), "patched": len(PATCHES),
     "output": f[AF["agentOutput"]], "name": f[AF["name"]], "notes": f[AF["notes"]],
     "plain": f[AF["plainSummary"]], "firstName": first_name,
     # why one card: two INBOX card names share one duplicate key, so the
     # Duplicates lane would tell Kevin to close the second
     "sameKey": gate.dupe_task_key("INBOX: 2 emails for you to read, since 14 Oct 09:00")
                == gate.dupe_task_key("INBOX: 2 emails for you to read, since 14 Oct 13:00")})
`);
    expect(r.sameKey).toBe(true);
    expect(r.cards).toBe(1);
    expect(r.created).toBe(1);
    expect(r.patched).toBe(1);
    expect(r.firstName).toMatch(/^INBOX: 2 emails for you to read, since \d{1,2} \w{3} 09:00$/);
    expect(r.name).toMatch(/^INBOX: 4 emails for you to read, since \d{1,2} \w{3} 09:00$/);
    expect(r.output.startsWith('INBOX CARD: 4 emails for you to read')).toBe(true);
    expect(r.output).toMatch(/For your information, added \d{1,2} \w{3} 13:00 \(2\)/);
    const nums = [...r.output.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]));
    expect(nums).toEqual([1, 2, 3, 4]);
    expect(r.notes.split(': ')[1].split(',').sort()).toEqual(['mA', 'mB', 'mC', 'mD']);
    expect(r.plain).toMatch(/^TASK: Read 4 emails/);
  });

  it('a card Kevin has decided is never added to: the next emails get a new card', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
quiet(lambda: m.cmd_inbox_card("09:00", dispatch=ad))
card()[AF["approvalOutcome"]] = "Approved as-is"
card()[AF["status"]] = "Today"
m.cmd_note("mC", "leave", "An aunt writing with family news, nothing asked")
quiet(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
out({"cards": len(STORE), "patched": len(PATCHES), "second": card(1)[AF["agentOutput"]]})
`);
    expect(r.cards).toBe(2);
    expect(r.patched).toBe(0);
    expect(r.second).toContain('1. aunt@gmail.com | A note');
  });

  it('an open card that reads blank is a STOP: nothing written to it, the emails stay queued', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
quiet(lambda: m.cmd_inbox_card("09:00", dispatch=ad))
real_get = ad.get_task
def blank_read(tid):
    rec = real_get(tid)
    rec["fields"].pop(AF["agentOutput"], None)
    return rec
ad.get_task = blank_read
m.cmd_note("mC", "leave", "An aunt writing with family news, nothing asked")
_, err = attempt(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
out({"err": err, "patched": len(PATCHES), "cards": len(STORE),
     "queued": [json.loads(l)["id"] for l in m.pending_path().read_text().splitlines()]})
`);
    expect(r.err.message).toMatch(/INBOX CARD NOT WRITTEN .*reads blank.*STOP/);
    expect(r.patched).toBe(0);
    expect(r.cards).toBe(1);
    expect(r.queued).toEqual(['mC']);
  });

  it('a failed card keeps every email queued for the next step, never lost', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}
m.cmd_note("mA", "leave", "A friend sending weekend photos, nothing asked")
def boom(fields):
    raise RuntimeError("gate exited 2")
m._create_card = boom
_, err = attempt(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
m._create_card = fake_create
quiet(lambda: m.cmd_inbox_card("17:00", dispatch=ad))
out({"err": err, "cards": len(STORE), "ids": card()[AF["notes"]]})
`);
    expect(r.err.message).toMatch(/INBOX CARD NOT WRITTEN/);
    expect(r.cards).toBe(1);
    expect(r.ids).toBe('INBOX CARD MESSAGE IDS: mA');
  });

  it('a card step killed part way loses nothing: the next step adopts its queue', () => {
    const box = sandbox();
    // First process: queue two emails, then die (SIGKILL) inside the card step.
    let killed = false;
    try {
      execFileSync('python3', ['-c', PREAMBLE + `${TWO_IN_INBOX}${LEAVE_AB}
import signal
m._create_card = lambda fields: os.kill(os.getpid(), signal.SIGKILL)
m.cmd_inbox_card("13:00", dispatch=ad)
`], { encoding: 'utf8', env: envFor(box) });
    } catch (e) { killed = e.signal === 'SIGKILL'; }
    expect(killed).toBe(true);
    const left = readdirSync(box.state).filter((f) => f.startsWith('inbox-card-taking-'));
    expect(left.length).toBe(1);
    // Second process: the orphan is adopted and both emails reach the card.
    const r = runPy(box, `
quiet(lambda: m.cmd_inbox_card("17:00", dispatch=ad))
out({"cards": len(STORE), "ids": card()[AF["notes"]] if STORE else "",
     "orphans": [p.name for p in m.base_dir().glob("inbox-card-taking-*")]})
`);
    expect(r.cards).toBe(1);
    expect(r.ids.split(': ')[1].split(',').sort()).toEqual(['mA', 'mB']);
    expect(r.orphans).toEqual([]);
  });

  it('mail that asks anything is refused for the card; an override is logged', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}
_, err = attempt(lambda: m.cmd_note("mP", "leave", "An agent sending an invoice to pay"))
moved_after_refusal = len(modifies())
m.cmd_note("mP", "leave", "A statement copy, already paid", override="paid by direct debit last week, nothing to do")
out({"err": err, "movedAfterRefusal": moved_after_refusal, "reason": digest()[-1]["reason"]})
`);
    expect(r.err.message).toMatch(/ASKS SOMETHING: money due \(invoice\)/);
    expect(r.movedAfterRefusal).toBe(0);
    expect(r.reason).toMatch(/^OVERRIDE ask signal \(money due \(invoice\)\): paid by direct debit/);
  });

  it('an overridden ask is listed first, under "These may need you to act", numbered straight through', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
m.cmd_note("mP", "leave", "A statement copy, already paid", override="paid by direct debit last week")
quiet(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
m.cmd_note("mC", "leave", "An aunt writing with family news, nothing asked")
quiet(lambda: m.cmd_inbox_card("17:00", dispatch=ad))
out({"output": card()[AF["agentOutput"]], "cards": len(STORE)})
`);
    const o = r.output;
    expect(r.cards).toBe(1);
    expect(o.indexOf('These may need you to act, added')).toBeGreaterThan(-1);
    expect(o.indexOf('These may need you to act, added')).toBeLessThan(o.indexOf('For your information, added'));
    expect(o).toContain('1. agent@example.co.uk | Your invoice');
    expect(o).toContain('Why it may need you: money due (invoice); kept as reading by override: paid by direct debit last week');
    // One number per email, 1..N across both sections and the later batch.
    expect([...o.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]))).toEqual([1, 2, 3, 4]);
    expect(o).toContain('4. aunt@gmail.com | A note');
  });

  it('the placeholder is created hidden (deferred) and the write that adds the list un-hides it', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
quiet(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
out({"created": CREATED[0], "after": card(), "tomorrow": ad.tomorrow_london(),
     "deferredKey": AF["deferredUntil"], "outKey": AF["agentOutput"]})
`);
    // As created through the gate: deferred to tomorrow, carrying only the placeholder.
    expect(r.created[r.deferredKey]).toBe(r.tomorrow);
    expect(r.created[r.outKey]).toMatch(/^INBOX LIST BEING WRITTEN:/);
    // After the one write: the list, and no longer deferred.
    expect(r.after[r.outKey]).toMatch(/^INBOX CARD: 2 emails/);
    expect(r.after[r.deferredKey]).toBeNull();
  });

  it('a card whose list cannot be written is cancelled and un-deferred, and the emails stay queued', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
FAIL_LIST_WRITE = True
_, err = attempt(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
out({"err": err, "status": card()[AF["status"]], "deferred": card().get(AF["deferredUntil"]),
     "output": card()[AF["agentOutput"]],
     "queued": sorted(json.loads(l)["id"] for l in m.pending_path().read_text().splitlines())})
`);
    expect(r.err.message).toMatch(/created but its list could not be written .*it was cancelled/);
    expect(r.status).toBe('Cancelled');
    // Cleared in the cancel write: a future Deferred Until off Approval breaks the knock-back invariant.
    expect(r.deferred).toBeNull();
    expect(r.output.startsWith('INBOX CARD:')).toBe(false);
    expect(r.queued).toEqual(['mA', 'mB']);
  });

  it('a verdict that lands before the list is caught on read-back: the card is cancelled, the emails stay queued', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
VERDICT_DURING_WRITE = True
_, err = attempt(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
out({"err": err, "status": card()[AF["status"]],
     "queued": sorted(json.loads(l)["id"] for l in m.pending_path().read_text().splitlines())})
`);
    expect(r.err.message).toMatch(/a verdict or a status change arrived before its list/);
    expect(r.status).toBe('Cancelled');
    expect(r.queued).toEqual(['mA', 'mB']);
  });

  it('if the cancel fails too, the placeholder stays hidden and the next card step cancels it', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}${LEAVE_AB}
FAIL_LIST_WRITE = True
FAIL_CANCEL = True
_, err = attempt(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
stuck = dict(card())
FAIL_LIST_WRITE = False
FAIL_CANCEL = False
quiet(lambda: m.cmd_inbox_card("17:00", dispatch=ad))
out({"err": err, "stuckStatus": stuck[AF["status"]], "stuckDeferred": stuck.get(AF["deferredUntil"]),
     "firstNow": card(0)[AF["status"]], "second": card(1)[AF["agentOutput"]], "cards": len(STORE)})
`);
    expect(r.err.message).toMatch(/the cancel failed too, so it stays hidden \(deferred\)/);
    expect(r.stuckStatus).toBe('Approval');
    expect(r.stuckDeferred).toBeTruthy();
    // Next step: the stuck placeholder is cancelled, and the emails reach a real card.
    expect(r.firstNow).toBe('Cancelled');
    expect(r.cards).toBe(2);
    expect(r.second).toMatch(/^INBOX CARD: 2 emails/);
  });

  it('a concrete ask is caught; a bare or rhetorical question mark is not (second review)', () => {
    const box = sandbox();
    const r = runPy(box, `
q = m._load_gate().unquoted_body
cases = {
  "newsletter": ("Autumn news", "Ready for race season? Our new range has landed. Shop the collection today."),
  "school": ("Term letter", "Did you know that our pupils read 2,000 books this term? Thank you for your support."),
  "ebay": ("Re: your listing", "Is this still available?"),
  "pay": ("Lunch money", "Please pay \u00a340 by Friday."),
  "statement": ("Your statement is ready", "Your monthly statement is now available to view."),
  "deadline": ("Forms", "Send the forms back before 12 Nov."),
  "request": ("Viewing", "Please confirm the time works for you."),
  "decision": ("Paint", "Do you want the blue or the green?"),
  "quoted": ("Re: photos", "Thanks, lovely.\\n\\nOn Mon, Kevin wrote:\\n> Can you pay me back?"),
  "dwp": ("Direct rent", "Please find attached the form for you to complete and return to DWP."),
  "keys": ("Keys", "Please advise when you are free to collect the keys."),
  "signature": ("Form", "We need your signature on the attached form."),
  "consent": ("Trip", "Kindly return the consent slip."),
  "boiler": ("Boiler", "I would be grateful if you could look at the boiler."),
  "arrears": ("Account", "Your account is now \u00a3120 in arrears."),
  "pleaseAdvise": ("Next step", "Please advise on the next step."),
  "pleaseCall": ("Call", "Please call me."),
  "politeNewsletter": ("October news", "Please find our October newsletter below. Please do not reply to this email."),
  "politeNote": ("Opening hours", "Please note our office closes early on bank holidays."),
  "environment": ("Minutes", "Here are the minutes.\\n\\nPlease consider the environment before printing this email."),
  "hesitate": ("Update", "All done on our side. Please do not hesitate to contact me with any questions."),
  "intended": ("Minutes", "Here are the minutes. If you are not the intended recipient, please notify us and delete it."),
  "seeAttached": ("Minutes", "Please see attached the minutes from Tuesday."),
  "seeBelow": ("News", "Please see below our latest update."),
  "advised": ("Move", "Please be advised the office moves next month."),
  "aware": ("Road", "Please be aware the road is closed this weekend."),
  "apologies": ("Sorry", "Please accept my apologies for missing the call."),
  "love": ("Hello", "Please give my love to the kids."),
  "signoff": ("Hello", "Lovely to see you all.\\n\\nKind regards\\nPat\\nPlease consider the environment before printing this email."),
  "manyThanks": ("Form", "Hi Kevin,\\nMany thanks for yesterday. Could you send the signed form by Friday?"),
  "bestRegards": ("Keys", "Hi Kevin,\\nBest regards from all of us, and can you return the keys on Monday?"),
  "thanksLine": ("Invoice", "Hi Kevin,\\nThanks\\nCan you pay the invoice this week?"),
  "postscript": ("Catch up", "Great to see you.\\nThanks,\\nAda\\n\\nPS please pay by Friday"),
  "disclaimer": ("Minutes", "Minutes attached. This email and any attachments are confidential; please notify the sender if received in error."),
  "askAboveSignoff": ("Lease", "Can you sign the lease?\\n\\nKind regards\\nPat"),
}
out({k: m.ask_signal(subj, q(body)) for k, (subj, body) in cases.items()})
`);
    expect(r.newsletter).toBe('');
    expect(r.school).toBe('');
    expect(r.ebay).toMatch(/^a question to you \(Is this still available\?\)/);
    expect(r.pay).toMatch(/^money due/);
    expect(r.statement).toBe('');
    expect(r.deadline).toMatch(/^a deadline \(before 12 Nov\)/);
    expect(r.request).toMatch(/^a request to act/);
    expect(r.decision).toMatch(/^a decision \(Do you want\)/);
    expect(r.quoted).toBe('');
    // Third review: the asks the narrowed check missed, and the politeness it must not flag.
    for (const k of ['dwp', 'keys', 'signature', 'consent', 'boiler', 'pleaseAdvise', 'pleaseCall']) {
      expect(r[k], k).toMatch(/^a request to act/);
    }
    expect(r.arrears).toMatch(/^money due \(arrears\)/);
    expect(r.politeNewsletter).toBe('');
    expect(r.politeNote).toBe('');
    // Fourth review: boilerplate under or around a person's words asks nothing.
    for (const k of ['environment', 'hesitate', 'intended', 'seeAttached', 'seeBelow', 'advised', 'aware',
      'apologies', 'love', 'signoff', 'disclaimer']) expect(r[k], k).toBe('');
    expect(r.askAboveSignoff).toMatch(/^a request to act \(Can you\)/);
    // Fifth review: nothing is cut at a sign-off, so an ask after one, or in a PS, still counts.
    for (const k of ['manyThanks', 'bestRegards', 'thanksLine', 'postscript']) expect(r[k], k).not.toBe('');
  });

  it('without the label it refuses before moving anything, and lane 12 is never the read label', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}
l8, l12, l13 = m.resolve_triage_labels(LABELS)
read_id = m.read_label(LABELS)["id"]
LABELS[:] = [l for l in LABELS if not l["name"].startswith("19")]
_, err = attempt(lambda: m.cmd_note("mA", "leave", "A friend sending weekend photos"))
out({"err": err, "modifies": modifies(), "queued": m.pending_path().exists(),
     "lane12": l12["id"], "readId": read_id})
`);
    expect(r.lane12).toBe('Label_899');
    expect(r.readId).toBe('Label_12');
    expect(r.err.message).toMatch(/LABEL MISSING/);
    expect(r.err.message).toContain(READ_LABEL);
    expect(r.modifies).toEqual([]);
    expect(r.queued).toBe(false);
  });

  it('a leave with no summary is refused: the summary is what Kevin reads', () => {
    const box = sandbox();
    const r = runPy(box, `${TWO_IN_INBOX}
_, err = attempt(lambda: m.cmd_note("mA", "leave", ""))
out({"err": err, "modifies": modifies()})
`);
    expect(r.err.message).toMatch(/needs --reason/);
    expect(r.modifies).toEqual([]);
  });

  it('at the length limit no number is skipped and no heading stands empty', () => {
    const box = sandbox();
    const r = runPy(box, `
# A person's email that fits, a second person's that does not, then a short
# company email that would fit in the space left: the old renderer skipped a
# number for the second and printed an empty heading.
items = [{"id": "p1", "sender": "a@gmail.com", "subject": "One", "internalDate": 1, "threadId": "t1", "summary": "s"},
         {"id": "p2", "sender": "b@gmail.com", "subject": "Two " + "y" * 300, "internalDate": 2, "threadId": "t2", "summary": "s"},
         {"id": "o1", "sender": "x@acme.co.uk", "subject": "Three", "internalDate": 3, "threadId": "t3", "summary": "s"}]
lines, shown = m.render_items(items, 1, {"gmail.com"}, 330)
out({"lines": lines, "shown": shown})
`);
    expect(r.shown).toEqual(['p1']);
    const text = r.lines.join('\n');
    expect([...text.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]))).toEqual([1]);
    expect(text).not.toContain('From companies');
  });
});

describe('answered and duplicate mail is filed out of the inbox, with no card', () => {
  it('answered (a later send went TO the sender): archived, nothing queued', () => {
    const box = sandbox();
    const r = runPy(box, `
cache({"mA": {"sender": "pat@example.com", "subject": "s", "threadId": "tA", "inbox": True, "ask": "", "reply_state": "answered"}})
m.cmd_note("mA", "answered", "we replied to the sender after it arrived")
quiet(lambda: m.cmd_inbox_card("09:00", dispatch=ad))
out({"modifies": modifies(), "cards": len(STORE)})
`);
    expect(r.modifies).toEqual([{ ids: ['mA'], removeLabels: ['INBOX'] }]);
    expect(r.cards).toBe(0);
  });

  it('a forward to someone else is not an answer: refused, nothing moved; an override is logged', () => {
    const box = sandbox();
    const r = runPy(box, `
cache({"mA": {"sender": "pat@example.com", "subject": "s", "threadId": "tA", "inbox": True, "ask": "", "reply_state": "elsewhere"}})
_, err = attempt(lambda: m.cmd_note("mA", "answered", "forwarded to Roy"))
before = len(modifies())
m.cmd_note("mA", "answered", "Roy replied from info@", override="Roy answered the sender from info@ this morning")
out({"err": err, "movedBefore": before, "moves": modifies(), "reason": digest()[-1]["reason"]})
`);
    expect(r.err.message).toMatch(/NOT ANSWERED/);
    expect(r.movedBefore).toBe(0);
    expect(r.moves).toEqual([{ ids: ['mA'], removeLabels: ['INBOX'] }]);
    expect(r.reason).toMatch(/^OVERRIDE forward-only thread: Roy answered/);
  });

  it('duplicate: archived the same way; a message already out of the inbox costs no call', () => {
    const box = sandbox();
    const r = runPy(box, `
cache({"mB": {"sender": "x@example.com", "subject": "s", "threadId": "tB", "inbox": True},
       "mC": {"sender": "x@example.com", "subject": "s", "threadId": "tC", "inbox": False}})
m.cmd_note("mB", "duplicate", "thread already has a completed task")
m.cmd_note("mC", "duplicate", "labelled lane mail, already handled")
out({"modifies": modifies(), "cards": len(STORE)})
`);
    expect(r.modifies).toEqual([{ ids: ['mB'], removeLabels: ['INBOX'] }]);
    expect(r.cards).toBe(0);
  });

  it('the scan stamps "answered" only where the later send went to the sender', () => {
    const box = sandbox();
    const r = runPy(box, `
def msg(i, frm, ts):
    return {"id": i, "threadId": "t" + i, "labelIds": ["INBOX"], "internalDate": ts,
            "headers": {"from": frm, "subject": "s"}, "body": "Thanks, lovely."}
LISTS["after:"] = [msg("r1", "Pat <pat@example.com>", 1000), msg("r2", "Sam <sam@example.com>", 1000)]
LISTS["in:sent"] = [
  {"id": "s1", "threadId": "tr1", "internalDate": 2000, "headers": {"from": "kevin@runpreneur.org.uk", "to": "Pat <pat@example.com>"}},
  {"id": "s2", "threadId": "tr2", "internalDate": 2000, "headers": {"from": "kevin@runpreneur.org.uk", "to": "roy@example.com"}}]
m.lookup_thread_tasks = lambda ids, fetch=None: {}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_scan(12)
res = json.loads(buf.getvalue().strip().splitlines()[-1])
c = m.read_scan_cache()
out({"r1": c["r1"]["reply_state"], "r2": c["r2"]["reply_state"],
     "sends": res["sent_thread_sends"]["tr2"][0]["to"]})
`);
    expect(r.r1).toBe('answered');
    expect(r.r2).toBe('elsewhere');
    expect(r.sends).toEqual(['roy@example.com']);
  });
});

describe('the score counts inbox mail older than 2 days, so it cannot read 0 over a full inbox', () => {
  // Drives the real scan (Gmail lists stubbed) into the real score: three old
  // emails in the inbox, and the run then acts on them.
  const SCAN = `
OLD = [{"id": i, "threadId": "t" + i, "labelIds": ["INBOX"], "internalDate": 1791000000000,
        "headers": {"from": "p@example.com", "subject": "old " + i}, "body": "Hello there."}
       for i in ("s1", "s2", "s3")]
LISTS["older_than:2d"] = OLD
m.lookup_thread_tasks = lambda ids, fetch=None: {}
written = []
m.airtable_patch_metric = lambda text: written.append(text)
quiet(lambda: m.cmd_scan(12))
scan_cache = m.read_scan_cache()
m.cmd_note("s1", "leave", "A neighbour saying hello, nothing asked")
`;

  it('three old emails, one filed: the score is 2, not 0', () => {
    const box = sandbox();
    const r = runPy(box, SCAN + `
quiet(lambda: m.cmd_score(0))
st = m.read_state()
out({"metric": written[-1], "detail": st["history_detail"][m.date.today().isoformat()]})
`);
    expect(r.metric).toBe('2 waiting; at zero 0 of last 7 days');
    expect(r.detail).toEqual({ agent: 0, inbox_over_2_days: 2, inbox_listing_truncated: false });
  });

  it("the agent's own count is added, and a message it deferred is never counted twice", () => {
    const box = sandbox();
    const r = runPy(box, SCAN + `
m.cmd_note("s2", "deferred", "task create failed, retry next run")
quiet(lambda: m.cmd_score(1))
out({"metric": written[-1]})
`);
    // s1 filed, s2 deferred (the agent's 1), s3 still there: 1 + 1, not 1 + 2.
    expect(r.metric).toMatch(/^2 waiting;/);
  });

  it('no scan from this slot: the score refuses rather than reuse another slot\'s numbers', () => {
    const box = sandbox();
    const r = runPy(box, SCAN + `
import datetime as _dt
later = (_dt.datetime.now() + _dt.timedelta(minutes=5)).astimezone().isoformat(timespec="seconds")
(m.base_dir() / "slot-results.jsonl").write_text(json.dumps({"ts": later, "slot": "13:00", "lane": "email", "ok": True}) + "\\n")
_, err = attempt(lambda: m.cmd_score(0))
(m.base_dir() / "slot-results.jsonl").unlink()
(m.base_dir() / "state.json").write_text("{}")
_, err2 = attempt(lambda: m.cmd_score(0))
out({"err": err, "err2": err2, "written": written})
`);
    expect(r.err.message).toMatch(/SCORE REFUSED/);
    expect(r.err2.message).toMatch(/SCORE REFUSED/);
    expect(r.written).toEqual([]);
  });
});

describe("Kevin's notes on INBOX cards reach the TRIAGE agent before its next run", () => {
  const TRIAGE_FILE = `---
name: inbound-comms-triage
---

You decide what reaches Kevin.

## Lessons from Kevin

Standing rules.

- 2026-09-01: INBOUND: an older lesson — keep this

## Never

Send anything.
`;
  const RESPONSE_FILE = `---
name: inbound-comms-response
---

You answer mail.

## Lessons from Kevin

Standing rules.
`;
  const WORDS = 'Never show me newsletters from the running club, archive them';
  const CARD_NAME = 'INBOX: 2 emails for you to read, since 15 Oct 09:00';
  const CARD = `CARD = {"id": "recCARD0000000001", "fields": {
    AF["name"]: ${JSON.stringify(CARD_NAME)},
    AF["approvalFeedback"]: ${JSON.stringify(WORDS)},
    AF["rememberThis"]: True,
    AF["approvalOutcome"]: "Approved as-is",
    AF["approvedAt"]: "2026-10-15T09:30:00.000Z",
    AF["sentForApprovalBy"]: [${JSON.stringify(RESPONSE)}],
    AF["teamMember"]: [${JSON.stringify(RESPONSE)}],
}}
TICKED = [CARD]
ad.query_tasks = lambda formula, max_records=None, minimal=False: list(TICKED)
ad.patch_task = lambda tid, fields: None
ad.mirror_lesson_to_register = lambda row, line: True
def files():
    return {n: open(os.path.join(ad.AGENT_DIR, n + ".md")).read()
            for n in ("inbound-comms-triage", "inbound-comms-response")}
`;

  function agentFiles(box, triage = TRIAGE_FILE) {
    writeFileSync(join(box.home, '.claude/agents/inbound-comms-triage.md'), triage);
    writeFileSync(join(box.home, '.claude/agents/inbound-comms-response.md'), RESPONSE_FILE);
  }

  it('the dispatcher alone files it with Inbox Response; inbox-lessons puts it in triage, inside its lessons', () => {
    const box = sandbox();
    agentFiles(box);
    const r = runPy(box, CARD + `
quiet(lambda: ad.cmd_lessons(None))
before = files()
quiet(lambda: m.cmd_inbox_lessons(dispatch=ad))
quiet(lambda: m.cmd_inbox_lessons(dispatch=ad))
out({"agentDir": ad.AGENT_DIR, "before": before, "after": files()})
`);
    expect(r.agentDir.startsWith(box.home)).toBe(true);
    expect(r.before['inbound-comms-response']).toContain(WORDS);
    expect(r.before['inbound-comms-triage']).not.toContain(WORDS);
    const t = r.after['inbound-comms-triage'];
    expect(t.split(WORDS).length - 1).toBe(1);
    expect(t).toContain(`- 2026-10-15: ${CARD_NAME} — ${WORDS}`);
    expect(t.indexOf(WORDS)).toBeGreaterThan(t.indexOf('## Lessons from Kevin'));
    expect(t.indexOf(WORDS)).toBeLessThan(t.indexOf('## Never'));
    expect(t).toContain('an older lesson — keep this');
  });

  it('a Request changes note still arrives after the resubmit cleared the Remember tick', () => {
    // The dispatcher wrote its lesson, then the agent's resubmit cleared
    // Remember This and Lesson Written At. The tick is gone; the lesson is
    // where the dispatcher stored it, and that is where this reads it.
    const box = sandbox();
    agentFiles(box);
    const r = runPy(box, CARD + `
CARD["fields"][AF["approvalOutcome"]] = "Changes requested"
quiet(lambda: ad.cmd_lessons(None))
CARD["fields"][AF["rememberThis"]] = False
CARD["fields"][AF["approvalFeedback"]] = ""
TICKED.clear()
quiet(lambda: m.cmd_inbox_lessons(dispatch=ad))
out({"after": files()})
`);
    expect(r.after['inbound-comms-response']).toContain(WORDS);
    expect(r.after['inbound-comms-triage']).toContain(`${CARD_NAME} — ${WORDS}`);
  });

  it('a note the dispatcher already rerouted to triage (with its stamp) is not written twice', () => {
    const box = sandbox();
    agentFiles(box, TRIAGE_FILE.replace('- 2026-09-01',
      `- 2026-10-15: ${CARD_NAME} — [2026-10-15 09:30] ${WORDS}\n- 2026-09-01`));
    const r = runPy(box, CARD + `
quiet(lambda: m.cmd_inbox_lessons(dispatch=ad))
out({"after": files()})
`);
    expect(r.after['inbound-comms-triage'].split(WORDS).length - 1).toBe(1);
  });

  it('a failed Tasks read is NOT CHECKED, never "no lessons"', () => {
    const box = sandbox();
    agentFiles(box);
    const r = runPy(box, `
def broken(formula, max_records=None, minimal=False):
    raise RuntimeError("Airtable 422 unknown field")
ad.query_tasks = broken
_, err = attempt(lambda: m.cmd_inbox_lessons(dispatch=ad))
out({"err": err})
`);
    expect(r.err.message).toMatch(/INBOX LESSONS NOT CHECKED/);
  });

  it('the runner, run for real against stub scripts, copies lessons BEFORE the agent and raises the card AFTER it', () => {
    const box = sandbox();
    const repo = join(box.home, 'repo');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    const calls = join(box.home, 'calls.log');
    const stub = (name, body = '') => {
      writeFileSync(join(repo, 'scripts', name),
        'import sys, json\n' +
        `open(${JSON.stringify(calls)}, "a").write(${JSON.stringify(name)} + " " + " ".join(sys.argv[1:]) + "\\n")\n` + body);
    };
    stub('slot-label.py', 'print("13:00")\n');
    stub('imessage-sweep.py', 'print("{}")\n');
    stub('agent-dispatch.py', 'print("{}")\n');
    stub('allowance.py', 'sys.exit(0)\n');
    stub('inbound-triage.py',
      'cmd = sys.argv[1] if len(sys.argv) > 1 else ""\n' +
      'print(json.dumps({"ok": True}) if cmd == "health" else "{}")\n' +
      'sys.exit(1 if cmd == "history-stale" else 0)\n');
    writeFileSync(join(repo, 'scripts', 'slot-postrun.sh'), `#!/bin/bash\necho "slot-postrun.sh" >> ${JSON.stringify(calls)}\nexit "$2"\n`);
    chmodSync(join(repo, 'scripts', 'slot-postrun.sh'), 0o755);
    const claude = join(box.home, 'claude');
    writeFileSync(claude, `#!/bin/bash\necho "claude" >> ${JSON.stringify(calls)}\nexit 0\n`);
    chmodSync(claude, 0o755);
    const token = join(box.home, 'token');
    writeFileSync(token, 'fake-token');
    execFileSync('bash', [RUNNER], {
      encoding: 'utf8', stdio: 'pipe',
      env: envFor(box, {
        INBOUND_TRIAGE_RUNNER_REPO: repo, INBOUND_TRIAGE_RUNNER_CLAUDE: claude,
        INBOUND_TRIAGE_RUNNER_LOG_DIR: join(box.home, 'logs'),
        INBOUND_TRIAGE_RUNNER_DISPATCH_RUNS: join(box.home, 'dispatch'),
        INBOUND_TRIAGE_RUNNER_TOKEN_FILE: token,
      }),
    });
    const order = readFileSync(calls, 'utf8').trim().split('\n');
    const at = (re) => order.findIndex((l) => re.test(l));
    expect(at(/^inbound-triage\.py inbox-lessons$/)).toBeGreaterThan(-1);
    expect(at(/^claude$/)).toBeGreaterThan(at(/^inbound-triage\.py inbox-lessons$/));
    expect(at(/^inbound-triage\.py inbox-card --slot 13:00$/)).toBeGreaterThan(at(/^claude$/));
    expect(at(/^slot-postrun\.sh$/)).toBeGreaterThan(at(/^inbound-triage\.py inbox-card/));
  });
});

describe('the one-off backlog: ONE batch card (Kevin: "Let\'s do a batch run")', () => {
  const INBOX = `
def msg(i, frm, subj, body="Lovely to hear from you.", labels=None, ts=1789600000000):
    return {"id": i, "threadId": "t" + i, "labelIds": ["INBOX"] + (labels or []), "internalDate": ts,
            "headers": {"from": frm, "subject": subj}, "body": body}
LISTS["in:inbox"] = [
    msg("d1", "Pat <pat@gmail.com>", "Holiday photos"),                                  # leave, asks nothing -> for information
    msg("d6", "Sam <sam@gmail.com>", "Dinner", body="Please pay me back by Friday."),    # leave, money due -> may need you to act
    msg("d2", "agent@example.co.uk", "Re: viewing"),                                     # answered, to the sender -> archived
    msg("d7", "tenant@example.com", "Boiler"),                                           # answered, forwarded only -> may need you to act
    msg("d3", "noreply@example.com", "Your statement"),                                  # duplicate -> archived
    msg("d4", "x@example.com", "Lane mail still here"),                                  # label12 -> counted only
    msg("d5", "y@example.com", "Never decided"),                                         # no decision -> the scan's job
    msg("d8", "Kim <kim@gmail.com>", "Kevin filed this", labels=["Label_7"]),            # Kevin's own label -> left alone
    msg("d9", "tenant2@example.com", "Update", body="Just an update on the flat."),       # leave, the old note asks -> act
]
LISTS["in:sent"] = [
    {"id": "s2", "threadId": "td2", "internalDate": 1789700000000, "headers": {"from": "kevin@runpreneur.org.uk", "to": "agent@example.co.uk"}},
    {"id": "s7", "threadId": "td7", "internalDate": 1789700000000, "headers": {"from": "kevin@runpreneur.org.uk", "to": "roy@example.com"}},
]
(m.base_dir() / "digest-2026-09-20.jsonl").write_text("\\n".join(json.dumps(r) for r in [
    {"id": "d1", "do": "leave", "reason": "Photos from a friend, nothing to answer", "ts": "2026-09-20T09:00:00"},
    {"id": "d6", "do": "leave", "reason": "A friend about dinner", "ts": "2026-09-20T09:00:00"},
    {"id": "d2", "do": "answered", "ts": "2026-09-20T09:01:00"},
    {"id": "d7", "do": "answered", "reason": "Tenant reporting the boiler", "ts": "2026-09-20T09:01:00"},
    {"id": "d3", "do": "duplicate", "ts": "2026-09-20T09:02:00"},
    {"id": "d4", "do": "label12", "ts": "2026-09-20T09:03:00"},
    {"id": "d8", "do": "leave", "reason": "x", "ts": "2026-09-20T09:03:00"},
    {"id": "d9", "do": "leave", "reason": "Tenant asks Kevin to call back about the flat", "ts": "2026-09-20T09:04:00"},
]) + "\\n")
def holder(job, pid):
    p = m.queue_holder_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"job": job, "pid": pid, "acquired_iso": "2026-10-14T19:00:00Z"}))
DIGESTS = lambda: sorted(p.name + ":" + str(len(p.read_text().splitlines())) for p in m.base_dir().glob("digest-*.jsonl"))
def backlog(apply):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        m.cmd_backlog(apply=apply, dispatch=ad)
    return json.loads(buf.getvalue().strip().splitlines()[-1])
`;

  it('--dry-run reads the inbox, the sent folder and the digests, and writes nothing to Gmail or Airtable', () => {
    const box = sandbox();
    const r = runPy(box, INBOX + `
before = DIGESTS()
res = backlog(False)
out({"res": res, "paths": sorted(set(c["path"] for c in CALLS)), "cards": len(STORE),
     "patched": len(PATCHES), "digestsSame": before == DIGESTS(), "ledger": m.ledger_path().exists(),
     "preview": open(res["preview_file"]).read()})
`);
    expect(r.paths).toEqual(['/gmail/labels', '/gmail/list']);
    expect(r.cards).toBe(0);
    expect(r.patched).toBe(0);
    expect(r.digestsSame).toBe(true);
    expect(r.ledger).toBe(false);
    expect(r.res).toMatchObject({
      mode: 'dry-run', card_may_need_you_to_act: 3, card_act_because_answer_unconfirmed: 1,
      card_for_your_information: 1, to_archive: 2, to_archive_answered_confirmed: 1,
      to_archive_duplicate: 1, skipped_user_label: 1, decided_otherwise_still_in_inbox: { label12: 1 },
      left_for_triage_no_decision: 1, card_items_that_fit: 4, gmail_writes: 0, airtable_writes: 0,
    });
    expect(r.res.card_chars_if_new).toBe(r.preview.trim().length);
    expect(r.res.preview_file.startsWith(box.state)).toBe(true);
    // The card itself: act first, each with why; then for your information.
    const p = r.preview;
    expect(p.indexOf('These may need you to act')).toBeLessThan(p.indexOf('For your information'));
    expect(p).toContain('1. sam@gmail.com | Dinner');
    expect(p).toMatch(/Why it may need you: money due \(pay\)/);
    expect(p).toContain('2. tenant@example.com | Boiler');
    expect(p).toContain('Why it may need you: the later send went to other people, not to the sender');
    expect(p).toContain('3. tenant2@example.com | Update');
    expect(p).toContain('Why it may need you: the earlier triage note mentions a request (asks)');
    expect(p).toContain('4. pat@gmail.com | Holiday photos');
    expect(p).toContain('turns each number you name into its own task');
    expect(p).not.toContain('Lane mail still here');
    expect(p).not.toContain('Kevin filed this');
  });

  it('--apply refuses unless the queue runs it as inbound-triage-backlog', () => {
    const box = sandbox();
    const r = runPy(box, INBOX + `
_, unwrapped = attempt(lambda: m.cmd_backlog(apply=True, dispatch=ad))
holder("inbound-triage-backlog", os.getppid() + 999999)
_, other = attempt(lambda: m.cmd_backlog(apply=True, dispatch=ad))
out({"unwrapped": unwrapped, "other": other, "calls": len(CALLS)})
`);
    expect(r.unwrapped.message).toMatch(/BACKLOG REFUSED: --apply runs only under the queue/);
    expect(r.other.message).toMatch(/belongs to another process/);
    expect(r.calls).toBe(0);
  });

  it('--apply: both sections go on the ONE open card, every carded email is labelled and archived, nothing goes back to triage', () => {
    const box = sandbox();
    const r = runPy(box, INBOX + `
cache({"o1": {"sender": "friend@gmail.com", "subject": "Earlier", "threadId": "to1", "internalDate": 1, "inbox": True, "ask": ""}})
m.cmd_note("o1", "leave", "An earlier note from a friend, nothing asked")
quiet(lambda: m.cmd_inbox_card("09:00", dispatch=ad))
CALLS.clear()
holder("inbound-triage-backlog", os.getppid())
res = backlog(True)
first_cards = len(STORE)
moves_first = modifies()
res2 = backlog(True)
d = digest()
out({"res": res, "cards": len(STORE), "firstCards": first_cards, "patched": len(PATCHES),
     "moves": moves_first, "output": card()[AF["agentOutput"]], "name": card()[AF["name"]],
     "dos": sorted(set(r["do"] for r in d)), "second": res2.get("carded")})
`);
    expect(r.firstCards).toBe(1);
    expect(r.cards).toBe(1);
    expect(r.patched).toBe(1);
    expect(r.name).toMatch(/^INBOX: 5 emails for you to read, since/);
    const o = r.output;
    expect(o.indexOf('These may need you to act')).toBeLessThan(o.indexOf('For your information (from the backlog'));
    expect([...o.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]))).toEqual([1, 2, 3, 4, 5]);
    expect(o).toContain('2. sam@gmail.com | Dinner');
    expect(o).toContain('5. pat@gmail.com | Holiday photos');
    expect(r.moves[0]).toEqual({ ids: ['d6', 'd7', 'd9', 'd1'], addLabels: [READ_LABEL], removeLabels: ['INBOX'] });
    expect(r.moves[1]).toEqual({ ids: ['d2', 'd3'], removeLabels: ['INBOX'] });
    const ids = r.moves.flatMap((p) => p.ids);
    for (const untouched of ['d4', 'd5', 'd8']) expect(ids).not.toContain(untouched);
    expect(r.dos).not.toContain('retriage');
    expect(r.second).toBe(0);
  });

  it('refuses while a triage slot holds the queue lock, before any Gmail call', () => {
    const box = sandbox();
    const r = runPy(box, INBOX + `
holder("inbound-triage", 4242)
_, err = attempt(lambda: m.cmd_backlog(apply=False, dispatch=ad))
out({"err": err, "calls": len(CALLS)})
`);
    expect(r.err.message).toMatch(/BACKLOG REFUSED: the inbound-triage slot holds the queue lock/);
    expect(r.calls).toBe(0);
  });
});

describe('the people and pages around the card', () => {
  it('Inbox Response is told what an INBOX card verdict means: approve = seen, a named number = one task', () => {
    // Its definition file is its prompt; this guards the instruction a redo needs.
    const f = readFileSync(join(process.env.HOME, '.claude/agents/inbound-comms-response.md'), 'utf8');
    const block = f.slice(f.indexOf('## INBOX cards'), f.indexOf('## Step 0')).replace(/\s+/g, ' ');
    expect(block).toMatch(/Approved as-is:\*\* he has seen them/);
    expect(block).toMatch(/turn EACH number he names into its own task/);
    expect(block).toContain('scripts/create-agent-task.py create');
    // Closed only with every named item's task read back; a failure goes back to Kevin.
    expect(block).toContain('scripts/agent-dispatch.py outcome <taskId>');
    expect(block).toMatch(/Close the card ONLY when every item he named has a task id read back/);
    expect(block).toMatch(/do NOT use that line/);
    // How his note is read: lists, ranges, sections, none, and no guessing.
    for (const s of ['"2 and 14"', '"3-7"', '"all the act ones"', '"none"', 'is NOT guessed']) expect(block).toContain(s);
    expect(block).toContain('Nothing. Information only.');
  });

  it('the Inbound Comms page no longer offers "Respond" on label 19, and every other label is unchanged', () => {
    const html = readFileSync(join(ROOT, 'follow-up.html'), 'utf8');
    const src = html.match(/function getActionButtonLabel\(\) \{[\s\S]*?\n {4}\}/)[0];
    const label = (name) => vm.runInNewContext(`${src}\ngetActionButtonLabel()`, { currentLabel: name });
    expect(label('19: for Kevin to read')).toBe('Follow up');
    for (const n of ['1: to respond', '10: property compliance', '12: kevin to respond', '13: maintenance',
      '18: creditor', '8: task created']) expect(label(n), n).toBe('Respond');
    expect(label('3: to pay')).toBe('Delay Payment');
    expect(label('6: newsletter')).toBe('Follow up');
  });

  it('the draft step does not treat label 19 as "to respond" either', () => {
    const html = readFileSync(join(ROOT, 'follow-up.html'), 'utf8');
    const line = html.match(/const isToRespondDraft = ([^\n]+);/)[1];
    const respond = (name) => vm.runInNewContext(line, { currentLabel: name });
    expect(respond('19: for Kevin to read')).toBe(false);
    for (const n of ['1: to respond', '12: kevin to respond', '13: maintenance']) expect(respond(n), n).toBe(true);
    expect(respond('6: newsletter')).toBe(false);
  });

  it('the Gmail worker returns the Cc header, so a reply-all that answered the sender in Cc is seen', async () => {
    const src = readFileSync(join(ROOT, 'workers/drive-upload/worker.js'), 'utf8');
    const grab = (marker) => {
      const start = src.indexOf(marker);
      if (start === -1) throw new Error(`${marker} not found in worker.js`);
      if (marker.startsWith('const ')) return src.slice(start, src.indexOf(';', start) + 1);
      let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
      }
      throw new Error(`could not parse ${marker}`);
    };
    const code = [grab('function b64urlDecodeUtf8('), grab('const INLINE_PHOTO_MIN_BYTES'),
      grab('function extractAttachments('), grab('function extractPlainText('),
      grab('async function gmailList(')].join('\n');
    const fetch = async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/messages?')
        ? { messages: [{ id: 'm1' }] }
        : { id: 'm1', threadId: 't1', labelIds: ['SENT'], internalDate: '1', snippet: '',
            payload: { headers: [{ name: 'From', value: 'kevin@runpreneur.org.uk' },
              { name: 'To', value: 'roy@example.com' }, { name: 'Cc', value: 'Pat <pat@example.com>' },
              { name: 'Subject', value: 'Re: keys' }], mimeType: 'text/plain', body: { data: '' } } }),
      text: async () => '',
    });
    const ctx = vm.createContext({ fetch, URLSearchParams, TextDecoder, atob, Uint8Array });
    vm.runInContext(code, ctx);
    const res = await vm.runInContext("gmailList('token', { q: 'in:sent' })", ctx);
    expect(res.messages[0].headers.cc).toBe('Pat <pat@example.com>');
    expect(res.messages[0].headers.to).toBe('roy@example.com');
  });
});

// ─── THE REAL GATE, A FAKE AIRTABLE ────────────────────────────────────────
// The card is created by scripts/create-agent-task.py (through merge_card's
// create_card, --force) in its own process, and read and written back by the
// dispatcher's own client. A sitecustomize on PYTHONPATH sends every
// api.airtable.com call from every one of those processes to this server and
// refuses any other network call, so the test sees the exact HTTP the robots
// would send. Nothing in the production scripts was changed to allow it.
describe('the card through the real task gate, against a fake Airtable over HTTP', () => {
  const records = new Map();
  const seen = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);   // v0, base, table, rec?
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const json = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, table: parts[2], rec: parts[3] || null, typecast: json && json.typecast, body });
      if (parts[2] !== 'tblqB8b22hKBL4PF1') return send(200, { records: [] });
      if (req.method === 'POST' && !parts[3]) {
        n += 1;
        const id = `recFAKE${String(n).padStart(10, '0')}`;
        const rec = { id, createdTime: `2026-10-14T1${n}:00:00.000Z`, fields: { ...json.fields } };
        records.set(id, rec);
        return send(200, rec);
      }
      if (parts[3]) {
        const rec = records.get(parts[3]);
        if (!rec) return send(404, { error: 'NOT_FOUND' });
        if (req.method === 'PATCH') Object.assign(rec.fields, json.fields);
        return send(200, rec);
      }
      const formula = url.searchParams.get('filterByFormula') || '';
      if (formula.includes('LEFT({Agent Output}')) {
        return send(200, { records: [...records.values()].filter((r) => r.fields.fldx4qCw17UfrKpaN === 'Approval'
          && String(r.fields.fldzswp8fx6PqpLQ5 || '').startsWith('INBOX LIST BEING WRITTEN:')) });
      }
      if (formula.includes('LEFT({Task Name}') && formula.includes("'Approval'")) {
        return send(200, { records: [...records.values()].filter((r) => r.fields.fldx4qCw17UfrKpaN === 'Approval'
          && !r.fields.fldrHBSr6qoUfaKuZ && !r.fields.fldJ9IHS1yxwYzYSN) });
      }
      return send(200, { records: [] });
    });
  });
  const listening = new Promise((r) => server.listen(0, '127.0.0.1', r));
  afterAll(() => server.close());

  it('creates ONE Approval card through create-agent-task.py, then adds the next run to it', async () => {
    await listening;
    const box = sandbox();
    mkdirSync(join(box.home, '.config/od'), { recursive: true });
    writeFileSync(join(box.home, '.config/od/airtable_pat'), 'fake-pat');
    const site = join(box.home, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'sitecustomize.py'), `
import os, urllib.request, urllib.error
_BASE = os.environ.get("FAKE_AIRTABLE_BASE")
if _BASE:
    _orig = urllib.request.urlopen
    def _redirect(req, *a, **k):
        url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
        if url.startswith("https://api.airtable.com"):
            new = _BASE + url[len("https://api.airtable.com"):]
            if isinstance(req, urllib.request.Request):
                req = urllib.request.Request(new, data=req.data, headers=dict(req.header_items()), method=req.get_method())
            else:
                req = new
        elif not url.startswith(_BASE):
            raise urllib.error.URLError("network blocked in test: " + url.split("?")[0])
        return _orig(req, *a, **k)
    urllib.request.urlopen = _redirect
`);
    const py = `
import importlib.util, json, sys, os, io, contextlib
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("t", ${JSON.stringify(TRIAGE)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.worker_post = lambda path, payload, sleep=None: (
    {"labels": ${JSON.stringify(LABELS)}} if path == "/gmail/labels" else {"modified": 1})
(m.base_dir() / "scan-cache.json").write_text(json.dumps({
    i: {"sender": i + "@gmail.com", "subject": "Hello " + i, "threadId": "t" + i,
        "internalDate": 1791800000000, "inbox": True, "ask": ""} for i in ("a", "b", "c")}))
res = []
with contextlib.redirect_stdout(io.StringIO()) as buf:
    m.cmd_note("a", "leave", "A friend saying hello, nothing asked")
    m.cmd_note("b", "leave", "Another friend saying hello, nothing asked")
    m.cmd_inbox_card("09:00")
    m.cmd_note("c", "leave", "A third friend saying hello, nothing asked")
    m.cmd_inbox_card("13:00")
print("RESULT " + json.dumps([json.loads(l) for l in buf.getvalue().splitlines() if l.startswith('{"card"')]))
`;
    const { stdout } = await run('python3', ['-c', py], {
      encoding: 'utf8', timeout: 120000,
      env: envFor(box, { PYTHONPATH: site, FAKE_AIRTABLE_BASE: `http://127.0.0.1:${server.address().port}` }),
    });
    const steps = JSON.parse(stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop().slice(7));
    expect(steps.map((s) => s.card)).toEqual(['created', 'appended']);
    const tasks = [...records.values()];
    expect(tasks.length).toBe(1);
    const f = tasks[0].fields;
    expect(f.fldx4qCw17UfrKpaN).toBe('Approval');                     // Status
    expect(f.fld30Yw8SWYVp049g).toEqual([RESPONSE]);                  // Sent For Approval By
    expect(f.flduCtmQGpOA4eWaj).toEqual([RESPONSE]);                  // Team Member
    expect(f.fldgFjGBw6bTKJFCD).toMatch(/^INBOX: 3 emails for you to read, since \d{1,2} \w{3} 09:00$/);
    expect([...f.fldzswp8fx6PqpLQ5.matchAll(/^(\d+)\. /gm)].map((x) => Number(x[1]))).toEqual([1, 2, 3]);
    expect(f.fldR7apBzSp3oxFxz).toContain('INBOX CARD MESSAGE IDS: a,b,c');
    // The gate's create went out with typecast OFF, as every gate create does.
    const create = seen.find((s) => s.method === 'POST' && s.table === 'tblqB8b22hKBL4PF1' && !s.rec);
    expect(create.typecast).toBe(false);
    // The gate's request mirrors its --fields-json, which `ps` can read: it
    // carries the placeholder, never a sender or a subject.
    expect(create.body).not.toMatch(/@gmail\.com|Hello [abc]/);
    expect(create.body).toContain('INBOX LIST BEING WRITTEN');
    // Born hidden, and the list write un-hid it.
    expect(JSON.parse(create.body).fields.fldJ9IHS1yxwYzYSN).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.fldJ9IHS1yxwYzYSN).toBeNull();
  }, 120000);
});

describe('the sandbox held', () => {
  it('no test above wrote into the repo', () => {
    // A stray preview or digest in the working tree would be private mail in a public repo.
    const strays = readdirSync(SCRIPTS).filter((f) => /backlog-preview|inbox-card|digest-/.test(f));
    expect(strays).toEqual([]);
    expect(existsSync(join(ROOT, 'backlog-preview.txt'))).toBe(false);
  });
});
