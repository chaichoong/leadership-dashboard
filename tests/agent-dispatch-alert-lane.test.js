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
  it('build_queue asks the classifier about the sender and the NAME, never the notes', () => {
    const fn = SRC.slice(SRC.indexOf('def build_queue('), SRC.indexOf('def cmd_queue('));
    expect(fn).toMatch(/hit_alert = system_alert_match\(t\.get\("inboundSender"\), t\["name"\]\)/);
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
t = {"name": "INBOUND: POST: CST Law British Gas letter before action Ciara GBP 80 - overdue", "description": "",
     "notes": "[11 Sep 2026 - agent] scan hit the Gmail quota, retried", "inboundSender": "kevinbrittain@gmail.com",
     "tier1": True, "creditor": "letter before action"}
print(json.dumps({"hit": m.system_alert_match(t["inboundSender"], t["name"]), "veto": m.alert_veto(t)}))`);
    expect(r.hit).toBe('');
    expect(r.veto).toBe('tier 1');
  });

  it('money is never an alert, even when the subject says Apps Script', () => {
    const r = py(`
cases = [
  {"name": "INBOUND: Letting agent - £1,234.56 paid to Ciara Brittain account, verify and reconcile", "description": ""},
  {"name": "INBOUND: Hayden Watson (MHHP) - £50+VAT payment required before meeting", "description": ""},
  {"name": "INBOUND: cafehighgate.co.uk expires in 24 hours - renew at $9.98 or let lapse", "description": "Apps Script forwarded this. Renewal is GBP 8"},
]
print(json.dumps([m.alert_veto(dict(c, tier1=False, creditor="")) for c in cases]))`);
    expect(r).toEqual(['names a sum of money', 'names a sum of money', 'names a sum of money']);
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
