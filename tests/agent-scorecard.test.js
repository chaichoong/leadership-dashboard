import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/agent-scorecard.py');

// Agent chats (Kevin, 17 and 18 Nov 2026): each AI agent has a standing Claude Code chat whose
// folder hook runs this script, so the chat opens with the agent's scorecard. The selftest drives
// the gate's three worked examples, shaped from the live records read on 18 Nov 2026:
//   Accounts Receivable: the live rent row (58 of 67, 86.6%, below the 97.5% floor) beats the
//     register's 47-day-old 96.9%, which must never show as current.
//   Compliance: an undated register reading is labelled "undated reading".
//   Bookkeeper: re-measured live from the AI Recon Audit table, 83% (273 of 327) against 95%.
// Kevin's note of 19 Nov 2026 ("how can we ensure that the agents do not forget things discussed in
// previous communications?"): the same hook now gives each chat LAST TIME WE SPOKE from its own saved
// conversations and brain log, again after Claude Code summarises the chat, and logs every answered
// question to the brain. The selftest drives an invented conversation for that.
// and the rules that keep a wrong number off the screen: a source that cannot be read says
// "unavailable" on its own line, a stale or grey hand-back row says "can't tell", and the hook
// never blocks Kevin's message.
describe('agent-scorecard.py', () => {
  it('passes its own selftest (worked examples, reading ages, unreadable sources, hook timing, usage count, last time we spoke)', () => {
    const out = JSON.parse(execFileSync('python3', [SCRIPT, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(84);
  });

  it('the hook is silent outside an agent chat folder and never fails the prompt', () => {
    const out = execFileSync('python3', [SCRIPT, 'hook'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'test', cwd: tmpdir() }),
      env: { ...process.env, OD_AGENT_CHAT: '', AGENT_SCORECARD_STATE: mkdtempSync(join(tmpdir(), 'sc-')) },
    });
    expect(out).toBe('');
  });

  it('recall refuses an unknown chat by name, listing the real ones', () => {
    let err = '';
    try {
      execFileSync('python3', [SCRIPT, 'recall', 'operations'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      err = String(e.stderr);
      expect(e.status).toBe(2);
    }
    expect(err).toContain('operations-manager');
  });

  it('show refuses an unknown chat by name, listing the real ones', () => {
    let err = '';
    try {
      execFileSync('python3', [SCRIPT, 'show', 'operations'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      err = String(e.stderr);
      expect(e.status).toBe(2);
    }
    expect(err).toContain('operations-manager');
    expect(err).toContain('ceo-room');
  });
});
