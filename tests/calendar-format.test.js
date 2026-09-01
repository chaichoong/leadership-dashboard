// The CALENDAR contract: one parser, shared by the submit gate and the
// carry-out script (scripts/agent_calendar_format.py).
//
// WHY (1 Sep 2026, Inbound Comms Response extension)
// A calendar entry is the first carry-out that writes to Kevin's own diary
// rather than sending a message. Two rules must hold and stay held:
//   1. The submit gate and calendar-write.py judge the SAME shape — a submit
//      that passes must be creatable after approval (the email contract's
//      finding 20260811-agent-dispatch-085, applied here from day one).
//   2. No attendees, ever. A diary entry never emails a third party; an
//      invite is Correspondence and goes through the email gate.
// These tests drive the real Python module rather than re-implementing it.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

function run(pyBody, arg) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
${pyBody}
`;
  return JSON.parse(
    execFileSync('python3', ['-c', py, arg], { encoding: 'utf8' }).trim());
}

function parse(output) {
  return run(`
from agent_calendar_format import parse_calendar, CalendarFormatError
try:
    print(json.dumps({"ok": True, "event": parse_calendar(sys.argv[1])}))
except CalendarFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`, output);
}

function submitProblem(output, taskType) {
  return run(`
from agent_calendar_format import calendar_submit_problem
print(json.dumps({"problem": calendar_submit_problem(sys.argv[1], ${JSON.stringify(taskType)})}))
`, output);
}

const GOOD = [
  'CALENDAR:',
  'TITLE: Aviva HMO policy renewal call',
  'START: 2099-09-10 14:00',
  'END: 2099-09-10 14:30',
  'LOCATION: Zoom',
  '---',
  'Renewal call for the HMO buildings policy before the 15 Sep deadline.',
  '**Carrying this out will involve:** the entry lands in your diary.',
].join('\n');

describe('the documented shape parses', () => {
  it('returns the event with London timezone and RFC3339 local times', () => {
    const r = parse(GOOD);
    expect(r.ok).toBe(true);
    expect(r.event.title).toBe('Aviva HMO policy renewal call');
    expect(r.event.start).toBe('2099-09-10T14:00:00');
    expect(r.event.end).toBe('2099-09-10T14:30:00');
    expect(r.event.timeZone).toBe('Europe/London');
    expect(r.event.location).toBe('Zoom');
  });

  it('strips the carry-out line from the summary', () => {
    const r = parse(GOOD);
    expect(r.event.summary).toContain('Renewal call');
    expect(r.event.summary).not.toContain('Carrying this out');
  });

  it('tolerates a leading tier-1 banner, same as the email contract', () => {
    const r = run(`
from agent_email_format import TIER1_BANNER
from agent_calendar_format import parse_calendar
print(json.dumps({"ok": True, "event": parse_calendar(TIER1_BANNER + "\\n\\n" + sys.argv[1])}))
`, GOOD);
    expect(r.ok).toBe(true);
  });
});

describe('malformed shapes are refused, never guessed', () => {
  const cases = [
    ['missing END', 'CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\n---\nsummary'],
    ['END before START', 'CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 13:00\n---\nsummary'],
    ['END equal to START', 'CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 14:00\n---\nsummary'],
    ['a human time format', 'CALENDAR:\nTITLE: x\nSTART: tomorrow 2pm\nEND: 2099-09-10 15:00\n---\nsummary'],
    ['a missing summary', 'CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 15:00\n---\n'],
    ['a missing --- line', 'CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 15:00\nsummary'],
    ['an unknown header', 'CALENDAR:\nTITLE: x\nCOLOUR: red\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 15:00\n---\nsummary'],
    ['an empty TITLE', 'CALENDAR:\nTITLE:\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 15:00\n---\nsummary'],
  ];
  for (const [label, output] of cases) {
    it(`refuses ${label}`, () => {
      expect(parse(output).ok).toBe(false);
    });
  }

  it('refuses attendees BY NAME with the reason that matters', () => {
    const r = parse('CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\nEND: 2099-09-10 15:00\nATTENDEES: a@b.com\n---\nsummary');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('never emails a third party');
  });
});

describe('the submit gate rule', () => {
  it('is quiet on outputs that are not claiming the CALENDAR shape', () => {
    expect(submitProblem('TO: a@b.com\nSUBJECT: x\n---\nbody', 'Correspondence').problem).toBe('');
    expect(submitProblem('Findings written up in Notes.', 'Research').problem).toBe('');
  });

  it('requires --type Admin on a CALENDAR output', () => {
    const r = submitProblem(GOOD, 'Correspondence');
    expect(r.problem).toContain('--type Admin');
  });

  it('passes a well-formed CALENDAR output submitted as Admin', () => {
    expect(submitProblem(GOOD, 'Admin').problem).toBe('');
  });

  it('surfaces the parse error BEFORE approval on a malformed block', () => {
    const r = submitProblem('CALENDAR:\nTITLE: x\nSTART: 2099-09-10 14:00\n---\nsummary', 'Admin');
    expect(r.problem).toContain('malformed');
  });
});

describe('calendar-write.py', () => {
  it('passes its own offline selftest (past-date grace, ledger contract, shapes)', () => {
    const out = execFileSync('python3',
      [resolve(SCRIPTS, 'calendar-write.py'), 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('selftest passed');
  });
});
