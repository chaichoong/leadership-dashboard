// SIGN AS KEVIN (Kevin, 16 Oct 2026): "with signing things, the initial request is to come to me,
// but if I say so, I can give you approval to sign on my behalf."
//
// One approved card is the authority for ONE Adobe agreement, named by Adobe's own id. Every test
// here drives the real code: the card parser and the approval check in Python, the robot's `sign`
// chain in real Chrome against fixture pages served at Adobe's own addresses (Playwright routes, no
// network), and the hand-back count. The fixture pages copy what the live pages showed on 16 Oct
// 2026 (the agreement page's "Status:" line, View & Sign opening /public/esign?aid=<id> in a new
// tab, the signature box's aria-label, the footer Submit's "All required fields complete").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const require_ = createRequire(import.meta.url);

const DIR = mkdtempSync(join(tmpdir(), 'sign-for-kevin-'));
const LEDGER = join(DIR, 'signed.jsonl');
const ID = 'CBJCHBCAABAAv-itJ-OopqgnZeh0r-YrhKg53Y8-Vglm';
const OTHER_ID = 'CBJCHBCAABAAzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const NAME = 'AST_Test_Tenant_1_Example_Street';
const CARD = [`SIGN AS KEVIN: ${NAME}`, `AGREEMENT ID: ${ID}`, 'SIGNER: info@agilelets.co.uk',
  'DOCUMENT: ~/knowledge-os/attachments/unsigned_recTESTTESTTEST01_AST.pdf', '---',
  'The tenancy agreement for a test flat. Signing it makes Agile Lets the landlord on it.',
  '', '**Carrying this out will involve:** the robot signs this one agreement with your saved signature.'].join('\n');

// Python with the real modules loaded: `m` is agent-dispatch.py, `F` is agent_email_format.py.
function py(code, arg) {
  const script = `
import importlib.util, json, sys, os, types
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
os.environ["SIGN_FOR_KEVIN_LEDGER"] = ${JSON.stringify(LEDGER)}
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
import agent_email_format as F
arg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None
def rec(output, outcome="Approved as-is", approved_at="2026-10-16T12:00:00.000Z", created="2026-10-16T10:00:00.000Z",
        sent_by=True, approver="", status="Approval", name="A tenancy agreement to sign", notes=""):
    f = {m.AF["agentOutput"]: output, m.AF["status"]: status, m.AF["name"]: name, m.AF["notes"]: notes}
    if outcome: f[m.AF["approvalOutcome"]] = outcome
    if approved_at: f[m.AF["approvedAt"]] = approved_at
    if sent_by: f[m.AF["sentForApprovalBy"]] = ["recQkO6BA4w5zqwZ4"]
    if approver: f[m.AF["approver"]] = {"email": approver}
    return {"id": "recTESTTESTTEST01", "createdTime": created, "fields": f}
m.approved_text_changed = lambda tid: False
${code}
`;
  const argv = ['-c', script];
  if (arg !== undefined) argv.push(JSON.stringify(arg));
  return JSON.parse(execFileSync('python3', argv, { encoding: 'utf8', env: { ...process.env, SIGNIN_SKIP_WALK: '1' } }).trim().split('\n').pop());
}

afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

describe('the SIGN AS KEVIN card names one agreement on a door the robot holds', () => {
  it('parses the card the dry run prints, at submit and everywhere else', () => {
    const out = py(`c = F.validate_submission_any(arg)
print(json.dumps([F.detect_kind(arg), c["kind"], c["agreement"], c["agreementId"], c["signer"], F.sign_as_kevin(arg)["agreementId"],
                  F.sign_as_kevin("TO: a@b.com\\nFROM: kevinbrittain@gmail.com\\nSUBJECT: x\\n---\\nhi")]))`, CARD);
    expect(out).toEqual(['signkevin', 'signkevin', NAME, ID, 'info@agilelets.co.uk', ID, null]);
  });

  it('refuses a card that would let the robot guess', () => {
    const bad = {
      noId: CARD.replace(/AGREEMENT ID: .*\n/, ''),
      gmail: CARD.replace('SIGNER: info@agilelets.co.uk', 'SIGNER: kevinbrittain@gmail.com'),
      roy: CARD.replace('SIGNER: info@agilelets.co.uk', 'SIGNER: roy.lavin1978@gmail.com'),
      twoSigners: CARD.replace('SIGNER: info@agilelets.co.uk', 'SIGNER: info@agilelets.co.uk, kevinbrittain@gmail.com'),
      notPdf: CARD.replace('_AST.pdf', '_AST.docx'),
      noBody: CARD.split('---')[0] + '---\n',
      twice: CARD.replace(`AGREEMENT ID: ${ID}`, `AGREEMENT ID: ${ID}\nAGREEMENT ID: ${OTHER_ID}`),
      extra: CARD.replace('SIGNER:', 'TO: someone@example.com\nSIGNER:'),
      spaceInId: CARD.replace(ID, 'CBJCHBCAAB AAv-itJ'),
    };
    const out = py(`out = {}
for k, v in arg.items():
    try:
        F.validate_submission_any(v); out[k] = "accepted"
    except F.EmailFormatError as e:
        out[k] = str(e)
print(json.dumps(out))`, bad);
    for (const [k, why] of Object.entries(out)) expect(why, k).not.toBe('accepted');
    expect(out.noId).toMatch(/AGREEMENT ID/);
    expect(out.gmail).toMatch(/cannot sign for kevinbrittain@gmail.com.*KEVIN ONLY: signature/);
    expect(out.notPdf).toMatch(/\.pdf/);
    expect(out.twice).toMatch(/appears twice/);
  });

  it('the Python card and the robot agree on the doors, the id shape and the ledger', () => {
    const ab = require_(join(SCRIPTS, 'agent-browser.js'));
    const out = py(`print(json.dumps([list(F.SIGN_AS_KEVIN_SIGNERS), F.AGREEMENT_ID_RE.pattern]))`);
    expect(out[0]).toEqual(Object.keys(ab.SIGN_DOORS));
    expect(out[1]).toBe(ab.AGREEMENT_ID_RE.source);
    const jsSrc = readFileSync(join(SCRIPTS, 'agent-browser.js'), 'utf8');
    const pySrc = readFileSync(DISPATCH, 'utf8');
    expect(jsSrc).toContain("'knowledge-os', 'logs', 'sign-for-kevin', 'signed.jsonl'");
    expect(pySrc).toContain('~/knowledge-os/logs/sign-for-kevin/signed.jsonl');
  });
});

describe("the 15-minute dashboard files the card as a signature for Kevin, his own level", () => {
  it('classifies it apart from an email reply', () => {
    const acc = require_(join(ROOT, 'js/agent-accuracy.js'));
    expect(acc.decisionCategory(CARD, 'Correspondence', 'A tenancy agreement to sign')).toBe('sign for Kevin');
    expect(acc.AUTONOMY_LEVELS['sign for Kevin'].level).toBe('C');
  });
});

describe('the approval the robot reads: Kevin approved THIS card, as it stands, in his queue', () => {
  const state = (recExpr, before = '') => py(`${before}
c, p = m.sign_as_kevin_state(${recExpr})
print(json.dumps([bool(c), p]))`, CARD);

  it('a clean approval signs', () => {
    expect(state('rec(arg)')).toEqual([true, '']);
  });

  it('refuses every way the approval could be wrong', () => {
    expect(state('rec(arg, outcome=None, approved_at=None)')[1]).toMatch(/not approved/);
    expect(state('rec(arg, outcome="Changes requested")')[1]).toMatch(/not approved/);
    expect(state('rec(arg, outcome="Approved with minor edits")')[1]).toMatch(/WITH EDITS/);
    expect(state('rec(arg, sent_by=False)')[1]).toMatch(/never went through the approval gate/);
    expect(state('rec(arg, approved_at="2026-10-16T09:00:00.000Z")')[1]).toMatch(/copied, not given/);
    expect(state('rec(arg, approver="someone@example.com")')[1]).toMatch(/only Kevin approves his signature/);
    expect(state('rec(F.TIER1_BANNER + "\\n\\n" + arg)')[1]).toMatch(/private legal matter/);
    expect(state('rec(arg, status="Completed")')[1]).toMatch(/Completed/);
    expect(state('rec(arg)', 'm.approved_text_changed = lambda t: True')[1]).toMatch(/changed after Kevin approved/);
    expect(state('rec(arg)', 'def boom(t): raise RuntimeError("no read")\nm.approved_text_changed = boom')[1])
      .toMatch(/could not be shown that the card is unchanged/);
    expect(state('rec("TO: a@b.com\\nFROM: kevinbrittain@gmail.com\\nSUBJECT: x\\n---\\nhi")')).toEqual([false, expect.stringMatching(/not a SIGN AS KEVIN card/)]);
  });

  it('a card the robot has already signed is never signed twice', () => {
    writeFileSync(LEDGER, JSON.stringify({ cmd: 'signed', task: 'recTESTTESTTEST01', agreementId: ID }) + '\n');
    try {
      expect(state('rec(arg)')[1]).toMatch(/already signed/);
    } finally { rmSync(LEDGER, { force: true }); }
  });

  it('"unchanged since approval" is two Airtable reads, each the other\'s control', () => {
    const out = py(`calls = []
def q(answers):
    def f(table, formula, fields):
        calls.append(formula); return answers.pop(0)
    return f
res = []
for answers in ([[], [{"id": "x"}]], [[{"id": "x"}], []], [[], []], [[{"id": "x"}], [{"id": "x"}]]):
    m.query_records = q(list(answers))
    m.approved_text_changed = None
    spec2 = importlib.util.spec_from_file_location("ad2", ${JSON.stringify(DISPATCH)})
    m2 = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(m2)
    m2.query_records = q(list(answers))
    try:
        res.append(m2.approved_text_changed("recTESTTESTTEST01"))
    except RuntimeError as e:
        res.append("raised")
print(json.dumps([res, calls[-2:]]))`);
    expect(out[0]).toEqual([false, true, 'raised', 'raised']);
    expect(out[1][0]).toMatch(/IS_AFTER\(LAST_MODIFIED_TIME\(\{Agent Output\}\), \{Approved At\}\)/);
    expect(out[1][1]).toMatch(/NOT\(IS_AFTER/);
  });
});

describe('submit: the card goes to Kevin alone, with the document, never on his legal matter', () => {
  const submit = (output, { attach = ['/tmp/unsigned_recTESTTESTTEST01_AST.pdf'], type = 'Correspondence', name = 'A tenancy agreement to sign' } = {}) => py(`
import tempfile
captured = {}
m.patch_task = lambda task, fields: captured.setdefault("writes", []).append(fields) or {"id": task}
def fake_get(task):
    f = {m.AF["name"]: arg["name"], m.AF["notes"]: ""}
    for w in captured.get("writes", []): f.update(w)
    return {"id": task, "createdTime": "2026-10-16T10:00:00.000Z", "fields": f}
m.get_task = fake_get
m.upload_attachment = lambda task, path: os.path.basename(path)
m.supersede_attachments = lambda task, names: []
m.require_role_agent_live = lambda *a, **k: None
fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(arg["output"]); fh.close()
args = types.SimpleNamespace(task="recTESTTESTTEST01", agent="recQkO6BA4w5zqwZ4", type=arg["type"], output_file=fh.name,
                             tier1=False, attach=arg["attach"], plain_task="A tenancy agreement for a test flat.",
                             plain_approve="The robot signs it for you with your saved signature.")
out = {}
try:
    m.cmd_submit(args); out["refused"] = False
except SystemExit as e:
    out["refused"] = True; out["error"] = str(e)
w = (captured.get("writes") or [{}])[-1]
out["assignee"] = (w.get(m.AF["assignee"]) or {}).get("email")
out["notes"] = w.get(m.AF["notes"], "")
out["status"] = w.get(m.AF["status"])
print(json.dumps(out))`, { output, attach, type, name });

  const TRACK = '\n\nTRACK RECORD: none found (searched tasks, Gmail for info@agilelets.co.uk)';
  it('a good card reaches Kevin, stamped with the agreement id for the close gate', () => {
    const out = submit(CARD + TRACK);
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ refused: false, status: 'Approval', assignee: 'kevin@runpreneur.org.uk' });
    expect(out.notes).toContain(`SIGN AS KEVIN CARD: ${ID} (${NAME})`);
  });

  it('refuses a card without its document, on his legal matter, or typed as anything but Correspondence', () => {
    expect(submit(CARD + TRACK, { attach: [] }).error).toMatch(/attach the document Kevin is asked to sign/);
    expect(submit(CARD + TRACK, { attach: ['/tmp/some_other_file.pdf'] }).error).toMatch(/attach the document/);
    expect(submit(CARD + TRACK, { type: 'Admin' }).error).toMatch(/--type Correspondence/);
    expect(submit('TIER-1\n' + CARD + TRACK, { name: 'CREDITOR: restraint order statement' }).refused).toBe(true);
    const banner = py('print(json.dumps(F.TIER1_BANNER))');
    expect(submit(banner + '\n\n' + CARD + TRACK).error).toMatch(/private legal matter/);
  });
});

describe('complete: a SIGN AS KEVIN task closes on the robot\'s own ledger row, or a stated reason', () => {
  const complete = (notes, { output = CARD, notSigned = '' } = {}) => py(`
captured = {}
m.patch_task = lambda task, fields: captured.setdefault("writes", []).append(fields) or {"id": task}
m.get_task = lambda task: rec(arg["output"], status="Today", notes=arg["notes"])
m.ledger_append = lambda *a, **k: None
m.task_fields_owe_certificate = lambda *a, **k: False
args = types.SimpleNamespace(task="recTESTTESTTEST01", keep_open=False, note="", no_certificate="", evidence="", not_signed=arg["notSigned"])
out = {}
try:
    m.cmd_complete(args); out["refused"] = False
except SystemExit as e:
    out["refused"] = True; out["error"] = str(e)
w = (captured.get("writes") or [{}])[-1]
out["status"] = w.get(m.AF["status"]); out["notes"] = w.get(m.AF["notes"], "")
print(json.dumps(out))`, { notes, output, notSigned });

  it('refuses without the robot\'s row, even after the card text was replaced by a report', () => {
    expect(complete('').error).toMatch(/robot's ledger has no signature/);
    const stamped = `[16 Oct 2026 12:00 — agent-dispatch] SIGN AS KEVIN CARD: ${ID} (${NAME}).`;
    expect(complete(stamped, { output: 'Signed it. All done.' }).error).toMatch(new RegExp(ID));
  });

  it('closes with the robot\'s row, or with the reason the robot did not sign it written to Notes', () => {
    appendFileSync(LEDGER, JSON.stringify({ cmd: 'signed', task: 'recTESTTESTTEST01', agreementId: ID }) + '\n');
    try {
      expect(complete('')).toMatchObject({ refused: false, status: 'Completed' });
    } finally { rmSync(LEDGER, { force: true }); }
    const out = complete('', { notSigned: 'Kevin signed it himself from his phone on 16 Oct.' });
    expect(out).toMatchObject({ refused: false, status: 'Completed' });
    expect(out.notes).toMatch(/NOT SIGNED BY THE ROBOT: Kevin signed it himself/);
  });
});

describe('the copy everyone signed is filed on the task, and nothing is reopened', () => {
  it('signed --then file attaches once and leaves status and verdict alone', () => {
    const pdf = join(DIR, 'signed_recTESTTESTTEST01_AST.pdf');
    writeFileSync(pdf, '%PDF-1.7 test');
    const out = py(`
notes = {"v": ""}
writes = []
def patch(task, fields):
    writes.append(fields)
    if m.AF["notes"] in fields: notes["v"] = fields[m.AF["notes"]]
    return {"id": task}
m.patch_task = patch
m.get_task = lambda task: rec(${JSON.stringify(CARD)}, status="Completed", notes=notes["v"])
m.upload_attachment = lambda task, path: os.path.basename(path)
args = types.SimpleNamespace(task="recTESTTESTTEST01", agreement=${JSON.stringify(NAME)}, pdf=arg, then="file")
r1 = m.cmd_signed(args); r2 = m.cmd_signed(args)
print(json.dumps({"codes": [r1, r2], "keys": sorted({k for w in writes for k in w}), "notes": notes["v"], "writes": len(writes)}))`, pdf);
    expect(out.codes).toEqual([0, 0]);
    expect(out.writes).toBe(1);                                     // the second poll finds it filed
    expect(out.notes).toMatch(new RegExp(`SIGNED COPY FILED: ${NAME} is signed by everyone`));
    expect(out.keys).toEqual([py('print(json.dumps(m.AF["notes"]))')]);   // no status, verdict or holder written
  });
});

describe('the hand-back score never counts a signature that took this route', () => {
  it('a SIGN AS KEVIN card is one of his cards and not a hand-back; the old Your step still is', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    x = importlib.util.module_from_spec(spec); spec.loader.exec_module(x); return x
A = load("ath", "ai_team_health.py"); aar = load("aar", "agent-accuracy-report.py")
L = ZoneInfo("Europe/London"); NOW = datetime(2026, 10, 20, 11, 0, tzinfo=timezone.utc)
st = lambda dt: dt.astimezone(L).strftime("%d %b %Y %H:%M")
iso = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ")
AG = "recAGENTxxxxxxx01"
team = [{"id": AG, "fields": {"Name": "AI Property", "Is AI Agent": True}}]
D2 = NOW - timedelta(days=2); D1 = NOW - timedelta(days=1)
def card(i, notes):
    return {"id": i, "fields": {"Task Name": i, "Notes": notes, "Sent For Approval By": [AG],
                                "Approval Outcome": "Approved as-is", "Approved At": iso(D2)}}
route = ("[%s — agent-dispatch] SIGN AS KEVIN CARD: ${ID} (${NAME}). Kevin's Approve lets the robot sign this one agreement.\\n"
         "[%s — robot] SIGNED FOR KEVIN: ${NAME} (${ID}) on Kevin's approval. Adobe now reads: Completed") % (st(D2 - timedelta(hours=1)), st(D1))
old = "[%s — agent-dispatch] BLOCKER OPEN (KEVIN signature): sign the Agile Lets box in Adobe" % st(D1)
fallback = route.split("\\n")[0] + "\\n[%s — agent-dispatch] BLOCKER OPEN (KEVIN signature): Adobe asked for initials too" % st(D1)
rows = [card("rROUTE", route), card("rOLD", old), card("rFALLBACK", fallback)]
f = A.facts_handback(rows, rows, team, aar, NOW, [])
print(json.dumps({"cards": f["cards"], "back": f["back"], "items": sorted(i["id"] for i in f["items"])}))
`], { encoding: 'utf8' });
    const f = JSON.parse(out.trim().split('\n').pop());
    expect(f).toEqual({ cards: 3, back: 2, items: ['rFALLBACK', 'rOLD'] });
  });
});

// ── The robot, in real Chrome, against Adobe's addresses served from fixtures ─────────────────────
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported by the tests */ }
let ab, browser;
const OUTCOME = join(DIR, 'outcome.py');

beforeAll(async () => {
  process.env.SIGN_FOR_KEVIN_LEDGER = LEDGER;
  process.env.AGENT_UPLOAD_DIR = DIR;
  process.env.AGENT_SIGN_LIST_MS = '200';
  process.env.AGENT_SIGN_SETTLE_MS = '100';
  process.env.AGENT_SIGN_CONFIRM_GAP_MS = '200';
  process.env.AGENT_OUTCOME_SCRIPT = OUTCOME;
  writeFileSync(OUTCOME, 'import os\nprint(os.environ["OUTCOME_JSON"])\n');
  delete require_.cache[require_.resolve(join(SCRIPTS, 'agent-browser.js'))];
  ab = require_(join(SCRIPTS, 'agent-browser.js'));
  browser = await chromium.launch();
});
afterAll(async () => { if (browser) await browser.close(); });

// One fake Adobe. `s` holds what the live pages would show; the routes read and change it.
function adobe(over = {}) {
  return Object.assign({
    rows: [{ id: ID, name: NAME }],
    agreements: { [ID]: { name: NAME, status: 'Waiting For Me to Sign' }, [OTHER_ID]: { name: 'Some_Other_Document', status: 'Waiting For Me to Sign' } },
    boxes: 1, extraRequired: 0, savedLabel: 'Agile Lets', signingAid: null, signingTitle: null,
    statusAfterSubmit: 'Completed', submits: 0, rowSignPressed: 0,
  }, over);
}
async function fakeAdobe(s) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const html = (body) => ({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>[role=gridcell]{display:inline-block;min-width:40px;min-height:20px}</style>${body}` });
  await ctx.route((u) => u.hostname === 'acrobat.adobe.com', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/link/documents/agreements')) {
      return route.fulfill(html(`<nav><a>Drafts (3)</a><a>Waiting for you (${s.rows.length})</a></nav><div role="grid">${s.rows.map((r) =>
        `<div role="row"><div role="gridcell"></div><div role="gridcell" class="pick" data-id="${r.id}"></div><div role="gridcell">Me</div>`
        + `<div role="gridcell"><div title="${r.name}">${r.name}</div></div><div role="gridcell"><button class="rowsign">Sign</button></div></div>`).join('')}</div>
<div id="panel"></div><script>
document.querySelectorAll('.pick').forEach(c => c.addEventListener('click', () => {
  document.getElementById('panel').innerHTML = '<button id="open">Open Agreement</button>';
  document.getElementById('open').onclick = () => { location.href = '/link/signatures/?signUri=' + encodeURIComponent('/public/agreements/view/' + c.dataset.id + '?type=esign&app=dc'); };
}));
document.querySelectorAll('.rowsign').forEach(b => b.onclick = () => fetch('/row-sign', { method: 'POST' }));
</script>`));
    }
    if (u.pathname === '/row-sign') { s.rowSignPressed++; return route.fulfill({ status: 204 }); }
    if (u.pathname.startsWith('/link/signatures')) {
      const id = (u.searchParams.get('signUri') || '').match(/view\/([^?]+)/)[1];
      const a = s.agreements[id];
      if (!a) return route.fulfill(html('<p>Not found</p>'));
      return route.fulfill(html(`<div>File information</div><div>${a.name}</div><div>Created 16 Oct 2026 14:55</div><div>Status:${a.status}</div>
${/Waiting For Me/.test(a.status) || s.alwaysView ? `<button id="view">View &amp; Sign</button>` : ''}<a role="button" href="/download/${id}">Download PDF</a>
<script>const v = document.getElementById('view'); if (v) v.onclick = () => window.open('https://na1.documents.adobe.com/public/esign?aid=${s.signingAid || id}&pid=p1&app=dc');</script>`));
    }
    if (u.pathname.startsWith('/download/')) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename="a.pdf"' }, body: '%PDF-1.7 unsigned' });
    }
    return route.fulfill(html('<p>acrobat</p>'));
  });
  await ctx.route((u) => u.hostname.endsWith('documents.adobe.com'), async (route) => {
    const u = new URL(route.request().url());
    const aid = u.searchParams.get('aid');
    if (u.pathname === '/submit') {
      s.submits++;
      if (s.agreements[aid] && s.statusAfterSubmit) s.agreements[aid].status = s.statusAfterSubmit;
      return route.fulfill({ status: 204 });
    }
    const a = s.agreements[aid] || { name: '?' };
    const boxes = Array.from({ length: s.boxes }, () => '<div data-testid="signature-form-field" aria-label="Click to Sign (required)" style="width:120px;height:30px;border:1px solid"></div>').join('');
    return route.fulfill(html(`<input aria-label="Document Title" value="${s.signingTitle || a.name}">
<div id="left"></div>${boxes}<input data-testid="date-of-signing-field" value="16/10/2026">
<button data-testid="footer-submit-button">Submit</button><script>
const EXTRA = ${s.extraRequired};
const footer = document.querySelector('[data-testid=footer-submit-button]');
function refresh() {
  const empty = [...document.querySelectorAll('[data-testid=signature-form-field]')].filter(b => /Click to Sign/.test(b.getAttribute('aria-label'))).length + EXTRA;
  document.getElementById('left').textContent = empty + ' required field' + (empty === 1 ? '' : 's') + ' remaining';
  footer.setAttribute('aria-label', empty ? empty + ' required fields remaining' : 'All required fields complete. Click submit to sign.');
}
document.querySelectorAll('[data-testid=signature-form-field]').forEach(b => b.onclick = () => { b.setAttribute('aria-label', ${JSON.stringify(s.savedLabel)} + ' Click to change (required)'); refresh(); });
footer.onclick = () => fetch('/submit?aid=${aid}', { method: 'POST' }).then(() => { footer.remove(); document.body.append("You're all set"); });
refresh();
</script>`));
  });
  return ctx;
}

async function runFlow(s, o) {
  const ctx = await fakeAdobe(s);
  const page = await ctx.newPage();
  try {
    return await ab.runSignFlow(page, ctx, Object.assign({ task: 'recTESTTESTTEST01', name: NAME, id: ID, door: ab.SIGN_DOORS['info@agilelets.co.uk'] }, o));
  } finally { await ctx.close(); }
}

describe('the robot signs the approved agreement, and only it', () => {
  it('signs the agreement by its id with the saved signature and proves it on Adobe\'s own page', async () => {
    const s = adobe();
    const r = await runFlow(s, { mode: 'sign' });
    expect(r).toMatchObject({ agreementId: ID, statusBefore: 'Waiting For Me to Sign', statusAfter: 'Completed', boxes: 1 });
    expect(s.submits).toBe(1);
    expect(s.rowSignPressed).toBe(0);
  });

  it('signs every box on the document, not just the first', async () => {
    const s = adobe({ boxes: 3 });
    expect((await runFlow(s, { mode: 'sign' })).boxes).toBe(3);
    expect(s.submits).toBe(1);
  });

  const refused = async (over, o, re) => {
    const s = adobe(over);
    await expect(runFlow(s, Object.assign({ mode: 'sign' }, o))).rejects.toThrow(re);
    expect(s.submits).toBe(0);
  };

  it('refuses an id whose agreement is not the one Kevin approved', () =>
    refused({}, { id: OTHER_ID }, /is not named "AST_Test_Tenant_1_Example_Street"/));
  it('refuses when the signing page is for another agreement', () =>
    refused({ signingAid: OTHER_ID }, {}, /signing page is for agreement CBJCHBCAABAAzzz/));
  it('refuses when the signing page shows another document', () =>
    refused({ signingTitle: 'Something_Else' }, {}, /document is "Something_Else"/));
  // The worst case: Adobe still offers View & Sign, so only the status check stops it (back-test, 16 Oct 2026).
  it('refuses an agreement no longer waiting for this account', () =>
    refused({ alwaysView: true, agreements: { [ID]: { name: NAME, status: 'Waiting for Others' } } }, {},
      /is not waiting for this account's signature \(Adobe: "Waiting for Others"\)/));
  it('refuses when Adobe asks for more than his signature', () =>
    refused({ extraRequired: 1 }, {}, /asks for more than Kevin's signature/));
  it('refuses when Adobe puts anything but the saved signature in a box', () =>
    refused({ savedLabel: 'Roy Lavin' }, {}, /other than the saved signature "Agile Lets"/));

  it('does not believe a Submit that Adobe\'s own page does not show', async () => {
    const s = adobe({ statusAfterSubmit: null });
    await expect(runFlow(s, { mode: 'sign' })).rejects.toThrow(/SIGN NOT CONFIRMED/);
    expect(s.submits).toBe(1);
  });
});

describe('the dry run finds one agreement, reads its id, downloads it, and signs nothing', () => {
  it('prints what the card needs', async () => {
    const s = adobe();
    const r = await runFlow(s, { mode: 'dry', id: undefined, shot: join(DIR, 'dry.png') });
    expect(r).toMatchObject({ agreementId: ID, status: 'Waiting For Me to Sign', onlySignature: true, asks: { boxes: 1, empty: 1, remaining: 1 } });
    expect(readFileSync(r.unsigned, 'utf8')).toBe('%PDF-1.7 unsigned');
    expect(s.submits).toBe(0);
  });
  it('says when Adobe asks for more than a signature', async () => {
    const r = await runFlow(adobe({ extraRequired: 1 }), { mode: 'dry', id: undefined });
    expect(r.onlySignature).toBe(false);
  });
  it('refuses two waiting agreements of one name, and none', async () => {
    await expect(runFlow(adobe({ rows: [{ id: ID, name: NAME }, { id: OTHER_ID, name: NAME }] }), { mode: 'dry', id: undefined }))
      .rejects.toThrow(/2 agreements named .* duplicate/);
    await expect(runFlow(adobe({ rows: [] }), { mode: 'dry', id: undefined })).rejects.toThrow(/no agreement named/);
  });
});

describe('signBinding: the robot reads Kevin\'s approval through agent-dispatch.py, and believes nothing else', () => {
  const ok = { outcome: 'Approved as-is', approved: true, formCard: false, trial: '', signProblem: '',
    signAsKevin: { agreement: NAME, agreementId: ID, signer: 'info@agilelets.co.uk', document: '/x.pdf' } };
  const bind = (state) => { process.env.OUTCOME_JSON = JSON.stringify(state); return ab.signBinding('recTESTTESTTEST01'); };
  it('returns the approved card with its door', () => {
    expect(bind(ok)).toMatchObject({ agreementId: ID, agreement: NAME, door: { savedSignature: 'Agile Lets' } });
  });
  it('refuses whatever the Python check refused, and checks the plain fields again', () => {
    expect(() => bind({ ...ok, signProblem: 'it is not approved (Approval Outcome: not set)' })).toThrow(/may not be signed: it is not approved/);
    expect(() => bind({ ...ok, outcome: 'Approved with minor edits' })).toThrow(/not approved as it stands/);
    expect(() => bind({ ...ok, approved: false })).toThrow(/not approved as it stands/);
    expect(() => bind({ ...ok, formCard: true })).toThrow(/not approved as it stands/);
    expect(() => bind({ ...ok, signAsKevin: { ...ok.signAsKevin, signer: 'kevinbrittain@gmail.com' } })).toThrow(/door the robot holds/);
    expect(() => bind({ ...ok, signAsKevin: null })).toThrow(/door the robot holds/);
  });
  it('refuses an agreement the robot already signed for that task', () => {
    appendFileSync(LEDGER, JSON.stringify({ cmd: 'signed', task: 'recTESTTESTTEST01', agreementId: ID }) + '\n');
    try { expect(() => bind(ok)).toThrow(/already signed/); } finally { rmSync(LEDGER, { force: true }); }
  });
});

describe('no plan signs on Adobe: prepare and commit refuse every signing press', () => {
  async function plan(s, steps) {
    const ctx = await fakeAdobe(s);
    const page = await ctx.newPage();
    try { return await ab.runSteps(page, steps, true, null); } finally { await ctx.close(); }
  }
  it('refuses View & Sign, the row\'s Sign, and opening a signing page', async () => {
    const page = 'https://acrobat.adobe.com/link/signatures/?signUri=' + encodeURIComponent(`/public/agreements/view/${ID}?type=esign&app=dc`);
    await expect(plan(adobe(), [{ do: 'goto', url: page }, { do: 'click', selector: '#view' }])).rejects.toThrow(/BROWSER REFUSED: "View & Sign" is a signing control/);
    await expect(plan(adobe(), [{ do: 'goto', url: ab.SIGN_LIST_URL }, { do: 'click', selector: '.rowsign' }])).rejects.toThrow(/signing control/);
    await expect(plan(adobe(), [{ do: 'goto', url: `https://na1.documents.adobe.com/public/esign?aid=${ID}` }])).rejects.toThrow(/is an Adobe signing page/);
  });
  it('still lets a plan press Download PDF on Adobe, and words like Sign in', async () => {
    const page = 'https://acrobat.adobe.com/link/signatures/?signUri=' + encodeURIComponent(`/public/agreements/view/${ID}?type=esign&app=dc`);
    const r = await plan(adobe(), [{ do: 'goto', url: page }, { do: 'click', selector: '[role=button]:has-text("Download PDF")' },
      { do: 'goto', url: ab.SIGN_LIST_URL }, { do: 'click', selector: '.pick' }, { do: 'wait', ms: 100 }]);
    expect(r.done.map((d) => d.do)).toEqual(['goto', 'click', 'goto', 'click', 'wait']);
    expect(ab.SIGN_WORDS_RE.test('Sign in')).toBe(false);
    expect(ab.SIGN_WORDS_RE.test('Sign-in')).toBe(false);
    expect(ab.SIGN_WORDS_RE.test('Request e-signatures')).toBe(false);
    expect(ab.SIGN_WORDS_RE.test('Send')).toBe(false);
    for (const w of ['Sign', 'View & Sign', 'Click to Sign', 'e-sign', 'Signature', 'footer-submit-button', 'signature-form-field']) {
      expect(ab.SIGN_WORDS_RE.test(w), w).toBe(true);
    }
  });
});
