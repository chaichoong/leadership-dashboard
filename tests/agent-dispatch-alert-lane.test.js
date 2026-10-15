import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// The system-alert lane (build_queue) parks machine mail about Apps Script,
// Cloudflare and Airtable failures so it never reaches Kevin's gate. Until
// 14 Sep 2026 the match also read the task's Description and NOTES. Notes
// carry every agent run log, and those logs say "Gmail quota" whenever a scan
// hit a limit, so real matters were parked and never dispatched: measured on
// the live queue that morning, 11 of the 24 "alerts" were a letter before
// action 19 days overdue, a four-figure rent payment to verify, a £50+VAT demand,
// two compliance renewals, a domain renewal and quote replies. These fixtures
// are those tasks' real shapes.
function py(snippet) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('system-alert lane — sender and subject only', () => {
  it('the queue (task_lane, which build_queue lists by) asks the classifier about the sender and the NAME, never the notes', () => {
    const fn = SRC.slice(SRC.indexOf('def task_lane('), SRC.indexOf('\ndef ', SRC.indexOf('def task_lane(') + 1));
    expect(fn).toMatch(/hit_alert = alert_lane_match\(t\.get\("inboundSender"\), t\.get\("inboundTask"\), t\["name"\]\)/);
    expect(fn).not.toMatch(/system_alert_match\([^)]*t\["notes"\]/);
    expect(fn).toMatch(/if hit_alert and alert_veto\(t\):/);
  });

  it('the two WRITE paths use the same rule: clear-alerts and the submit gate read sender and name, then veto', () => {
    const clear = SRC.slice(SRC.indexOf('def cmd_clear_alerts('), SRC.indexOf('def cmd_', SRC.indexOf('def cmd_clear_alerts(') + 10));
    expect(clear).toMatch(/hit = system_alert_match\(t\.get\("inboundSender"\), t\["name"\]\)/);
    expect(clear).toMatch(/alert_veto\(/);
    const submit = SRC.slice(SRC.indexOf('def cmd_submit('), SRC.indexOf('def cmd_', SRC.indexOf('def cmd_submit(') + 10));
    expect(submit).toMatch(/alert_hit = system_alert_match\(tf_probe\.get\(AF\["inboundSender"\], ""\), _pn\)/);
    expect(submit).toMatch(/alert_veto\(/);
    expect(SRC.match(/system_alert_match\([^)]*notes/g)).toBeNull();
  });

  it('a note that mentions the Gmail quota does not make a letter before action an alert', () => {
    const r = py(`
t = {"name": "INBOUND: POST: Example Law energy letter before action Jo GBP 80 - overdue", "description": "",
     "notes": "[11 Sep 2026 - agent] scan hit the Gmail quota, retried", "inboundSender": "kevinbrittain@gmail.com",
     "tier1": True, "creditor": "letter before action"}
print(json.dumps({"hit": m.system_alert_match(t["inboundSender"], t["name"]), "veto": m.alert_veto(t)}))`);
    expect(r.hit).toBe('');
    expect(r.veto).toBe('tier 1');
  });

  it('money is never an alert, even when the subject says Apps Script', () => {
    const r = py(`
cases = [
  {"name": "INBOUND: Letting agent - £1,234.56 paid to Jo Example account, verify and reconcile", "description": ""},
  {"name": "INBOUND: Harry Example (Example Advisers) - £50+VAT payment required before meeting", "description": ""},
  {"name": "INBOUND: cafehighgate.co.uk expires in 24 hours - renew at $9.98 or let lapse", "description": "Apps Script forwarded this. Renewal is GBP 8"},
]
print(json.dumps([m.alert_veto(dict(c, tier1=False, creditor="")) for c in cases]))`);
    expect(r).toEqual(['names a sum of money', 'names a sum of money', 'names a sum of money']);
  });

  // Review of PR #794 (15 Oct 2026): a task a session or an agent raised was parked as an alert by its
  // own words. "Check five Airtable automation failure notices" (no sender, not inbound) sat parked,
  // and a Builder fix named for the Gmail quota it caps sat 10.8 days with no robot handed it.
  it('the NAME patterns park only inbound mail; the machine-sender rule parks always', () => {
    const r = py(`
print(json.dumps({
  "sessionRaised": m.alert_lane_match("", False, "Check five Airtable automation failure notices (28 Sep to 14 Oct)"),
  "builderFix": m.alert_lane_match("", None, "Cap the sender-history rebuild so it stops burning its whole budget on a full Gmail quota"),
  "airtableMail": m.alert_lane_match("noreply@airtable.com", True, "Run failed: Daily rent sync"),
  "machineSenderNoTick": m.alert_lane_match("noreply@notify.cloudflare.com", False, "Your worker hit an error"),
  "inboundTicked": m.alert_lane_match("", True, "Apps Script failure: daily sync stopped"),
  "inboundForwarded": m.alert_lane_match("kevinbrittain@gmail.com", False, "Fwd: Airtable automation failed"),
}))`);
    expect(r.sessionRaised).toBe('');
    expect(r.builderFix).toBe('');
    expect(r.airtableMail).toBe('noreply@airtable.com');
    expect(r.machineSenderNoTick).toBe('noreply@notify.cloudflare.com');
    expect(r.inboundTicked).toMatch(/apps script/);
    expect(r.inboundForwarded).toMatch(/airtable automation/);
  });

  // Review round 2 of PR #794: the GATES keep the full match. An agent's write-up named for a breakage
  // is swept off Kevin's queue, and the same task, now at Today with the Builder, is worked, not parked.
  it('an agent-raised "Apps Script trigger stopped" card is swept off Approval, then worked by the Builder, never parked', () => {
    const r = py(`
import io, contextlib, types
AF = m.AF
TASK = {"id": "recAgentAlertAaaa", "fields": {AF["name"]: "Apps Script trigger stopped", AF["status"]: {"name": "Approval"},
        AF["teamMember"]: ["recqmKBmq8ZGkxVH9"], AF["sentForApprovalBy"]: ["recqmKBmq8ZGkxVH9"],
        AF["agentOutput"]: "The nightly trigger stopped on 14 Oct; recommend re-creating it.", AF["notes"]: ""}}
m.query_tasks = lambda formula, **k: [json.loads(json.dumps(TASK))]
def patch_task(tid, fields):
    TASK["fields"].update(fields)
    return TASK
m.patch_task = patch_task
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_clear_alerts(types.SimpleNamespace(dry_run=False))
swept = json.loads(buf.getvalue())
t = m.task_view(TASK)
ctx = m.lane_context([], {}, "", [], None)
print(json.dumps({"moved": [x["task"] for x in swept["items"]], "status": t["status"], "team": t["teamMemberIds"],
                  "sender": t["sentForApprovalByIds"], "lane": m.task_lane(t, ctx)[0]}))`);
    expect(r.moved).toEqual(['recAgentAlertAaaa']);
    expect(r.status).toBe('Today');
    expect(r.team).toEqual(['recQkO6BA4w5zqwZ4']);   // the Builder
    expect(r.sender).toEqual([]);
    expect(r.lane).toBe('newWork');                 // the lane does not park it by its words
  });

  it('a real Apps Script failure mail is still an alert (the lane keeps its job)', () => {
    const r = py(`
t = {"name": "INBOUND: Meetings Intake script failing - Gmail quota exceeded again", "description": "",
     "inboundSender": "noreply-apps-scripts-notifications@google.com", "tier1": False, "creditor": ""}
print(json.dumps({"hit": m.system_alert_match(t["inboundSender"], t["name"]), "veto": m.alert_veto(t)}))`);
    expect(r.hit).toBe('apps-scripts-notifications@google.com');
    expect(r.veto).toBe('');
  });
});
