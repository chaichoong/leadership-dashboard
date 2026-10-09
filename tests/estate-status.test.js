import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITER = resolve(ROOT, 'scripts/estate-status.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// Kevin's audit, 14 Sep 2026. From 13:00 Friday to 19:00 Sunday the Claude
// allowance was out and nothing ran; every wrapper logged it and no surface
// Kevin looks at said so. scripts/estate-status.py mirrors the job logs into
// the Estate Status table every ten minutes; the Estate status tab on the AI
// Agents page reads it. These tests guard the mirror AND its wiring: a writer
// filling fields the page cannot see, or a page tab nobody can open, recreates
// the exact invisibility this was built to end.

describe('estate-status.py', () => {
  it('passes its own selftest (allowance -> Blocked with the reset time, Running, Skipped, Idle, plain-words failure)', () => {
    const out = JSON.parse(execFileSync('python3', [WRITER, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(16);
  });

  it('is registered in job-schedule.json as a lock-exempt ten-minute job and described in the automations list', () => {
    const sched = JSON.parse(read('scripts/job-schedule.json'));
    expect(sched['estate-status']).toBeTruthy();
    expect(sched['estate-status'].cron).toBe('*/10 * * * *');
    expect(sched['estate-status'].lockExempt).toBe(true);
    expect(sched['estate-status'].mode).toBe('wrapped');
    expect(read('js/automations-data.js')).toMatch(/key: 'estate-status'/);
  });

  it('never writes an empty board: a missing status log or an empty schedule refuses, loudly', () => {
    const src = read('scripts/estate-status.py');
    expect(src).toMatch(/refusing to write an empty board/);
    expect(src).toMatch(/is missing — the wrappers write it on every run/);
  });
});

// Kevin approved 2 Oct 2026 (task recJfXJeMwZPENonk, finding 20261002-agent-dispatch-722): a job
// that goes silent kept its last status and drifted to Idle after a week, which no attention list
// reads. Drives the real refresh (dry run: no table, no task read) over a temp schedule and logs.
describe('a slot that passes with no record reads Missed', () => {
  function refresh(ownRecordAfterSlot) {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys, tempfile, types
from datetime import datetime, timedelta, timezone
spec = importlib.util.spec_from_file_location("es", ${JSON.stringify(WRITER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
own_after = sys.argv[1] == "1"
now = datetime.now(timezone.utc)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
daily = lambda t: "%d %d * * *" % (t.astimezone(m.LONDON).minute, t.astimezone(m.LONDON).hour)
slot, other_slot = now - timedelta(hours=3), now - timedelta(hours=2)
d = tempfile.mkdtemp()
m.SCHEDULE = os.path.join(d, "s.json")
json.dump({"night-publish": {"cron": daily(slot), "mode": "wrapped"},
           "other-job": {"cron": daily(other_slot), "mode": "wrapped"},
           "zz-new-job-never-run": {"cron": daily(slot), "mode": "wrapped"}}, open(m.SCHEDULE, "w"))
fin = [{"ts": iso(now - timedelta(hours=27)), "job": "night-publish", "ok": True, "exit": 0},
       {"ts": iso(now - timedelta(hours=1)), "job": "other-job", "ok": True, "exit": 0}]
if own_after:
    fin.append({"ts": iso(slot + timedelta(minutes=5)), "job": "night-publish", "ok": True, "exit": 0})
m.STATUS_LOG = os.path.join(d, "job-status.jsonl")
open(m.STATUS_LOG, "w").write("\\n".join(json.dumps(r) for r in fin) + "\\n")
m.QUEUE_LOG = os.path.join(d, "queue-events.jsonl")
rep = lambda key: (lambda now, **k: {"key": key, "kind": "report", "status": "Worked", "detail": "stub"})
for name in ("allowance_row", "needs_you_row", "robot_signins_row", "blockers_row", "built_row"):
    setattr(m, name, rep(name))
m.cmd_refresh(types.SimpleNamespace(dry_run=True, no_loop_health=True))
`, ownRecordAfterSlot ? '1' : '0'], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  }

  it('a job silent past its slot while another job ran is Missed and on the attention list', () => {
    const r = refresh(false);
    expect(r.byStatus.Missed).toBe(1);
    expect(r.attention).toContain('night-publish: Missed');
    expect(r.attention).not.toContain('other-job: Missed');   // control: a job that ran after its slot is not
  });

  it('a job just added to the schedule that has never left a record is new, not Missed (review of #749)', () => {
    const r = refresh(false);
    expect(r.attention).toContain('night-publish: Missed');   // control: the rule is firing on this board
    expect(r.attention).not.toContain('zz-new-job-never-run: Missed');
    expect(r.byStatus.Missed).toBe(1);
  });

  it('a job that left a record after its slot is not Missed', () => {
    const r = refresh(true);
    expect(r.byStatus.Missed).toBeUndefined();
    expect(r.byStatus.Worked).toBeGreaterThanOrEqual(2);
  });
});

describe('the Estate status tab', () => {
  const page = read('os/agents/index.html');

  it('field ids match the writer (drift guard)', () => {
    const pageBlock = page.match(/const ES = \{([\s\S]*?)\};/);
    const pyBlock = read('scripts/estate-status.py').match(/^ES = \{([\s\S]*?)\}/m);
    expect(pageBlock, 'ES block on the page (control)').not.toBeNull();
    expect(pyBlock, 'ES block in the writer (control)').not.toBeNull();
    const keys = ['key', 'kind', 'label', 'schedule', 'status', 'lastRun', 'lastWorked', 'detail', 'nextDue', 'runs24h', 'fails24h', 'payload', 'updated'];
    for (const k of keys) {
      const pageId = pageBlock[1].match(new RegExp(`${k}:\\s*'(fld[A-Za-z0-9]+)'`));
      const pyId = pyBlock[1].match(new RegExp(`"${k}":\\s*"(fld[A-Za-z0-9]+)"`));
      expect(pageId, `${k} on the page`).not.toBeNull();
      expect(pyId, `${k} in the writer`).not.toBeNull();
      expect(pyId[1]).toBe(pageId[1]);
    }
    expect(page).toMatch(/const ESTATE_TBL = 'tblZVrdzivyBueZVf'/);
    expect(read('scripts/estate-status.py')).toMatch(/TABLE = "tblZVrdzivyBueZVf"/);
  });

  it('names WHY each not-moving row is stalled, from the lane the writer carries (15 Sep 2026)', () => {
    // The writer copies loop-health's lane into the payload; the tab renders it.
    expect(read('scripts/estate-status.py')).toMatch(/"lane": s\.get\("lane"\)/);
    expect(page).toMatch(/estateLaneChip\(s\.lane\)/);
    for (const lane of ['withKevin', 'deferred', 'signInNeeded', 'withRoy', 'invisible', 'withAgent']) {
      expect(page, `lane ${lane} has a label`).toMatch(new RegExp(`${lane}:\\s*'[^']+'`));
    }
  });

  it('is a page tab Kevin can open, deep-linkable as #tab=estate (and #tab=status)', () => {
    expect(page).toMatch(/id="ptab-estate"[^>]*onclick="switchAgentsView\('estate'\)"/);
    expect(page).toMatch(/<div class="page-view" id="view-estate">/);
    expect(page).toMatch(/const AGENT_VIEWS = \['dashboard','approvals','checks','estate','built'\];/);
    expect(page).toMatch(/'status': 'estate'/);
    expect(page).toMatch(/if\(view==='estate'\) loadEstateStatus\(\);/);
  });

  it('says when the mirror itself has stopped, instead of showing a calm old board', () => {
    expect(page).toMatch(/The status writer itself has stopped/);
    expect(page).toMatch(/const ESTATE_STALE_MIN = 30;/);
    // and the sync bar carries the same check, so the sidebar dot goes red too
    expect(page).toMatch(/name: 'Estate status fresh'/);
  });

  it('a read error is shown as an error, never as an empty list', () => {
    expect(page).toMatch(/Could not read the Estate Status table \(\$\{esc\(e\.message\|\|e\)\}\)\. This list is NOT empty/);
    expect(page).toMatch(/Could not read the content table \(\$\{esc\(e\.message\|\|e\)\}\)\. This list is NOT empty/);
  });

  it('escapes every Airtable-sourced string it renders', () => {
    const block = page.slice(page.indexOf('function renderEstateStatus('), page.indexOf('async function loadEstateContent('));
    // every gf(...) read that lands in HTML goes through esc()
    const raw = block.match(/\$\{gf\(r,'[a-zA-Z0-9]+'\)\}/g) || [];
    expect(raw, 'unescaped field interpolations').toEqual([]);
  });

  it('shows the channels the publisher actually writes (same field names as LINK_FIELDS)', () => {
    const pub = read('scripts/content-engine/publish.py');
    for (const name of ['YouTube Full Link', 'Link of Youtube Shorts', 'Link of Facebook Reels', 'Link of Instagram Reels', 'Link of Linkedin Post', 'Link of Tiktok Video', 'Link of Threads Post', 'Blog Link']) {
      expect(pub, `${name} written by publish.py (control)`).toContain(`"${name}"`);
      expect(page, `${name} read by the tab`).toContain(`'${name}'`);
    }
  });
});

// Kevin, 25 Sep 2026: the Robot sign-ins panel on the AI Agents page. Driven end
// to end on files in a temp folder: the real `agent-browser.js signin-list` and
// `sites` read our own sites file, and the writer reads our own keep-alive,
// ledger and meter logs. Nothing on this Mac is read or written.
describe('the robot-signins row', () => {
  it('reads every source and ranks the newest look, per sign-in, from the real list', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const dir = mkdtempSync(resolve(tmpdir(), 'od-signins-'));
    try {
      const f = (name, body) => { const p = resolve(dir, name); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); return p; };
      const sites = f('sites.json', {
        'my.utilita.co.uk': { label: 'Utilita', login: true, profiles: [
          { profile: 'utilita-apt1', label: 'Flat 1', loginUrl: 'https://my.utilita.co.uk/energy' },
          { profile: 'utilita-apt2', label: 'Flat 2', loginUrl: 'https://my.utilita.co.uk/energy' }] },
        'www.strava.com': { label: 'Strava', login: true },
      });
      const keep = f('status.json', { at: '2026-09-25T06:40:05+01:00', sites: {
        'app.pingen.com': { state: 'signed-in' }, 'www.edfenergy.com': { state: 'signed-out' } } });
      const ledger = f('runs.jsonl', [
        '{"at":"2026-09-25T06:56:28Z","cmd":"session","site":"app.pingen.com","signedIn":false,"profile":"default"}',
        'not json at all',
        '{"at":"2026-09-25T06:59:37Z","cmd":"login","host":"www.edfenergy.com","profile":"default"}',
      ].join('\n'));
      const readings = f('readings.jsonl', [
        '{"at":"2026-09-25T10:05:25","label":"Apartment 1","ok":true,"problem":null}',
        '{"at":"2026-09-25T10:05:25","label":"Apartment 2","ok":false,"problem":"SIGN-IN NEEDED"}',
      ].join('\n'));
      const accounts = f('accounts.json', { accounts: [{ label: 'Apartment 1', profile: 'utilita-apt1' }, { label: 'Apartment 2', profile: 'utilita-apt2' }] });
      const py = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('es', ${JSON.stringify(WRITER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.KEEPALIVE_STATUS, m.BROWSER_LEDGER, m.UTILITA_READINGS, m.UTILITA_ACCOUNTS = sys.argv[1:5]
row = m.robot_signins_row(datetime(2026, 9, 25, 10, 10, tzinfo=timezone.utc))
print(json.dumps(row))`;
      const row = JSON.parse(execFileSync('python3', ['-c', py, keep, ledger, readings, accounts],
        { encoding: 'utf8', env: { ...process.env, AGENT_BROWSER_SITES_FILE: sites } }));
      expect(row.status, row.detail).toBe('Worked');
      expect(row.key).toBe('robot-signins');
      const p = JSON.parse(row.payload);
      const by = Object.fromEntries(p.lines.map((l) => [l.label, l]));
      // The builtins come through the real list (control: Pingen and HMRC are builtins).
      expect(by['Pingen (letters)'].state).toBe('signed-out');          // 06:56 robot check beats 06:40 keep-alive
      expect(by['EDF Energy'].state).toBe('you-signed-in');             // his sign-in came after the last look
      expect(by.HMRC.state).toBe('on-demand');
      expect(by['Flat 1']).toMatchObject({ profile: 'utilita-apt1', state: 'signed-in', how: 'hourly read', at: '2026-09-25T09:05:25.000Z' });
      expect(by['Flat 2']).toMatchObject({ profile: 'utilita-apt2', state: 'signed-out' });
      expect(p.lines.some((l) => l.host === 'my.utilita.co.uk' && l.profile === 'default')).toBe(false);
      expect(p.unlisted).toContain('Strava');
      expect(row.detail).toMatch(/signed out \(/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is written every ten minutes with the rest of the board, and on its own after a sign-in', () => {
    const src = read('scripts/estate-status.py');
    const build = src.slice(src.indexOf('def build_rows('), src.indexOf('def cmd_refresh('));
    expect(build).toMatch(/rows\.append\(robot_signins_row\(now\)\)/);
    // The single-row command never goes through upsert(), which would mark every other row "No longer scheduled".
    const one = src.slice(src.indexOf('def cmd_signins('), src.indexOf('def selftest('));
    expect(one).not.toMatch(/upsert\(/);
    expect(read('scripts/robot-signin.applescript')).toMatch(/scripts\/estate-status\.py signins/);
  });
});

// Kevin, 7 Oct 2026: a red row older than 2 days raises ONE owned task. That day agent-blockers had
// been red 9 days and data-invariants and job-digest had not been green once in the week read, with
// no owner. These drive the REAL red_rows_pass with the open-task read and the create replaced by
// fakes. The live shape that mattered: a job failing daily has a Last Run of today, so red-since
// must come from the oldest evidence, never the newest failure.
describe('a red row raises one Builder task', () => {
  const NOW = '2026-10-07T10:00:00+00:00';
  const ago = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  function red({ rows = [], stored = {}, state = {}, open = [{ id: 'recOTHER000000001', name: 'something else' }], openFails = false }) {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location("es", ${JSON.stringify(WRITER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
made = []
def open_tasks():
    if a["openFails"]:
        raise RuntimeError("HTTP 503")
    return [(t["id"], t["name"]) for t in a["open"]]
def create(fields):
    made.append(fields); return "recNEWTASK%07d" % len(made)
res = m.red_rows_pass(a["rows"], a["stored"], datetime.fromisoformat(a["now"]), a["state"], open_tasks, create,
                      m.dispatch_const("BUILDER_REC_ID"), logs_dir="/nonexistent")
print("---JSON---"); print(json.dumps({"res": res, "made": made, "rows": a["rows"], "builder": m.dispatch_const("BUILDER_REC_ID")}))
`], { input: JSON.stringify({ rows, stored, state, open, openFails, now: NOW }), encoding: 'utf8' });
    return JSON.parse(out.split('---JSON---')[1]);
  }
  const job = (key, f) => ({ key, kind: 'job', status: 'Failed', detail: 'exit code 1. Last thing it said: the check failed on row 12 of the sheet today', ...f });

  it('red 1 day: nothing', () => {
    const r = red({ rows: [job('data-invariants', { lastWorked: ago(1), lastRun: ago(0.1) })] });
    expect(r.made).toHaveLength(0);
    expect(r.res.young).toEqual(['data-invariants']);
  });
  it('red 3 days: one task for the Builder, named for the row, and the row says which task', () => {
    const r = red({ rows: [job('data-invariants', { lastWorked: ago(3), lastRun: ago(0.1) })] });
    expect(r.made).toHaveLength(1);
    const f = r.made[0];
    expect(f.fldgFjGBw6bTKJFCD).toBe('RED: data-invariants — exit code 1. Last thing it said: the check failed on row 12');
    expect(f.flduCtmQGpOA4eWaj).toEqual([r.builder]);
    expect(r.builder).toBe('recQkO6BA4w5zqwZ4');
    expect(f.fldx4qCw17UfrKpaN).toBe('Today');
    expect(f.fldRGhBQViKZKtkQ6).toMatch(/the check failed on row 12 of the sheet today/);
    expect(f.fldRGhBQViKZKtkQ6).toMatch(/job-status\.jsonl/);
    expect(r.rows[0].detail).toMatch(/Builder task recNEWTASK0000001 raised\.$/);
  });
  it('red 3 days with its task already open: no second task, even after the Detail changed', () => {
    const open = [{ id: 'recRED00000000001', name: 'RED: data-invariants — exit code 1. Last thing it said: an older tail' }];
    const r = red({ rows: [job('data-invariants', { lastWorked: ago(3) })], open });
    expect(r.made).toHaveLength(0);
    expect(r.res.existing).toEqual([{ key: 'data-invariants', task: 'recRED00000000001' }]);
    expect(r.rows[0].detail).toMatch(/task recRED00000000001 raised/);
  });
  it('a row with a blank Detail finds its own task next time (no twin every ten minutes)', () => {
    const first = red({ rows: [job('job-z', { lastWorked: ago(3), detail: '' })] });
    expect(first.made[0].fldgFjGBw6bTKJFCD).toBe('RED: job-z —');
    const again = red({ rows: [job('job-z', { lastWorked: ago(3), detail: '' })],
      open: [{ id: 'recRED00000000003', name: first.made[0].fldgFjGBw6bTKJFCD }] });
    expect(again.made).toHaveLength(0);
  });
  it('another job\'s RED task is not this job\'s (the prefix carries the key and the dash)', () => {
    const open = [{ id: 'recRED00000000002', name: 'RED: data-invariants-weekly — exit code 1' }];
    expect(red({ rows: [job('data-invariants', { lastWorked: ago(3) })], open }).made).toHaveLength(1);
  });
  it('a weekly job that worked 6 days ago and failed this morning is not two days red', () => {
    const r = red({ rows: [job('weekly-x', { lastWorked: ago(6), firstFail: ago(0.2), lastRun: ago(0.2) })] });
    expect(r.made).toHaveLength(0);
    expect(r.res.young).toEqual(['weekly-x']);
  });
  it('classify carries the first failure after the last good run, from the real finishes', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("es", ${JSON.stringify(WRITER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = datetime(2026, 10, 7, 10, 0, tzinfo=timezone.utc)
fin = [{"job": "j", "ts": "2026-10-01T06:00:00Z", "ok": False}, {"job": "j", "ts": "2026-10-02T06:00:00Z", "ok": True},
       {"job": "j", "ts": "2026-10-05T06:00:00Z", "ok": False}, {"job": "j", "ts": "2026-10-06T06:00:00Z", "ok": False}]
r = m.classify("j", {"cron": "0 6 * * *"}, fin, [], now, logs_dir="/nonexistent")
print(json.dumps({k: r.get(k) for k in ("status", "firstRun", "firstFail", "lastWorked")}))
`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim().split('\n').pop())).toEqual({ status: 'Failed', firstRun: '2026-10-01T06:00:00.000Z',
      firstFail: '2026-10-05T06:00:00.000Z', lastWorked: '2026-10-02T06:00:00.000Z' });
  });
  it('a row that never worked: Last Run is used', () => {
    const r = red({ rows: [job('job-digest', { lastWorked: null, lastRun: ago(3) })] });
    expect(r.made).toHaveLength(1);
    expect(r.res.raised[0].since).toBe('last run');
  });
  it('a job failing daily (Last Run today) is red since its first run in the week read', () => {
    const r = red({ rows: [job('job-digest', { lastWorked: null, lastRun: ago(0.1), firstRun: ago(6) })] });
    expect(r.made).toHaveLength(1);
    expect(r.res.raised[0].since).toBe('first run in the week read');
  });
  it('blank Last Worked and blank Last Run: dated from the first time this writer saw it red', () => {
    const fresh = red({ rows: [job('job-x', { lastWorked: null, lastRun: null })] });
    expect(fresh.made).toHaveLength(0);
    expect(fresh.res.state['job-x']).toBe('2026-10-07T10:00:00.000Z');
    const later = red({ rows: [job('job-x', { lastWorked: null, lastRun: null })], state: { 'job-x': ago(3) } });
    expect(later.made).toHaveLength(1);
    expect(later.res.raised[0].since).toBe('first seen red by this writer');
  });
  it('a row no longer red drops out of the state, so a later red starts its own clock', () => {
    const r = red({ rows: [job('job-x', { status: 'Worked' })], state: { 'job-x': ago(9) } });
    expect(r.res.state).toEqual({});
  });
  it('a report row whose Detail names the owner raises nothing; one that names nobody does', () => {
    const blockers = { key: 'agent-blockers', kind: 'report', status: 'Failed', lastWorked: ago(9),
      detail: 'Robots blocked on 35 tasks. For you: add axa.co.uk to the robot\'s list; 12 steps only you can do.' };
    const blind = { key: 'built-inventory', kind: 'report', status: 'Failed', lastWorked: ago(4),
      detail: 'The inventory could not be read: file missing.' };
    const r = red({ rows: [blockers, blind] });
    expect(r.res.owned).toEqual(['agent-blockers']);
    expect(r.made.map((f) => f.fldgFjGBw6bTKJFCD)).toEqual(['RED: built-inventory — The inventory could not be read: file missing.']);
  });
  it('a row another script writes is read from the table, and its Detail is patched once', () => {
    const stored = { 'rent-position': { kind: 'report', status: 'Failed', lastWorked: ago(5), detail: 'The rent read failed.', id: 'recROW' } };
    const r = red({ stored });
    expect(r.made).toHaveLength(1);
    expect(r.res.patch['rent-position']).toMatch(/^The rent read failed\. Builder task recNEWTASK0000001 raised\.$/);
  });
  it('a broken open-task read raises nothing and says so', () => {
    expect(red({ rows: [job('job-y', { lastWorked: ago(5) })], open: [] }).res.errors.join(' ')).toMatch(/ZERO tasks/);
    const failed = red({ rows: [job('job-y', { lastWorked: ago(5) })], openFails: true });
    expect(failed.made).toHaveLength(0);
    expect(failed.res.errors.join(' ')).toMatch(/HTTP 503/);
    expect(failed.res.state['job-y']).toBeTruthy();
  });
  it('the refresh fails loudly on a red-pass error, and the dry run never reads or writes tasks', () => {
    const src = read('scripts/estate-status.py');
    const refresh = src.slice(src.indexOf('def cmd_refresh('), src.indexOf('def cmd_signins('));
    expect(refresh).toMatch(/return 1 if red\.get\("errors"\) else 0/);
    expect(refresh).toMatch(/dry run: no table or task read/);
    expect(src).toMatch(/return cmd_refresh\(args\)/);
  });
});

// 8 Oct 2026: the page's Your turn test asks "has the sweep looked at this card?" by comparing the
// card's time with the sweep's. A sweep that READ the board at 15:45 and finished at 15:52 never saw
// a card written at 15:50, so the row carries the read time (readAt), not the file's finish time.
describe('the Robots blocked row says when the sweep read the board', () => {
  it('sweptAt is the sweep\'s own readAt, and the file time only for a report without one', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const dir = mkdtempSync(resolve(tmpdir(), 'od-blockers-'));
    const withRead = resolve(dir, 'with.json'), without = resolve(dir, 'without.json');
    const base = { openTasksRead: 3, open: [], woken: [], stale: [], closedWhileBlocked: [], surfaced: [], doneRefused: [], planRepairs: [], sitesError: '', findingsError: '', readErrors: {} };
    writeFileSync(withRead, JSON.stringify({ ...base, readAt: '2026-10-08T14:45:00.000Z',
      open: [{ task: 'recStepAaaaaaaaaa', name: 'x', agent: 'a', kind: 'KEVIN', subject: 'purchase', fix: 'f', days: 0,
               step: 'Buy it.', yourStep: true, planProblem: 'step 6 (kevin) needs say' }] }));
    writeFileSync(without, JSON.stringify(base));
    const script = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('es', ${JSON.stringify(WRITER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = datetime.now(timezone.utc)
a = json.loads(m.blockers_row(now, ${JSON.stringify(withRead)})["payload"])
b = json.loads(m.blockers_row(now, ${JSON.stringify(without)})["payload"])
print(json.dumps([a["sweptAt"], b["sweptAt"], a["open"][0].get("planProblem")]))`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(r[0]).toBe('2026-10-08T14:45:00.000Z');
    expect(r[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(r[1]).not.toBe('2026-10-08T14:45:00.000Z');
    // A plan the sweep refused reaches the page, which then shows no Your turn for it.
    expect(r[2]).toBe('step 6 (kevin) needs say');
  });
});
