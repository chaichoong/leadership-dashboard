// A lookup miss must never read as "Kevin never replied".
//
// Regression origin: 24 Aug 2026, finding 20260824-inbound-messages-sweep-335 —
// the SEVENTH filing of the same bug (149, 202, 234, 261, 305, 321 before it).
//
// `whatsapp-sweep.py sent --jid X` matched only `ZWACHATSESSION.ZCONTACTJID`.
// Airtable's Inbound Sender is written for a human, so it holds a group chat's
// DISPLAY NAME, or a JID with the contact name appended. Both matched zero rows
// and the command exited 0 with {"found": false} — byte-identical to a genuine
// no-reply. The task could never be auto-closed and every run reported success.
//
// Secondary: the outgoing query filtered ZMESSAGETYPE = 0, so a reply Kevin
// sent as a link (7) or a photo (8) was also counted as silence.
//
// Back-tested: restoring `WHERE s.ZCONTACTJID = ?` as the only match makes the
// display-name case fail; returning 0 on an unresolved identifier makes the
// exit-code case fail; dropping 7 and 8 makes the reply-types case fail.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SWEEP = resolve(ROOT, 'scripts/whatsapp-sweep.py');
const SRC = readFileSync(SWEEP, 'utf8');

function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ws', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${code}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('whatsapp sent: identifier resolution', () => {
  it('passes the script selftest, which covers the cleaning rules', () => {
    const out = execFileSync('python3', [SWEEP, 'selftest'], { encoding: 'utf8' });
    expect(out.trim()).toBe('selftest ok');
  });

  it('strips a display-name suffix off a JID', () => {
    const r = py(`print(json.dumps([
        m.strip_display_suffix('447881924047@s.whatsapp.net (Roy Lavin)'),
        m.strip_display_suffix('447881924047@s.whatsapp.net'),
        m.strip_display_suffix('Any excuse'),
    ]))`);
    expect(r).toEqual([
      '447881924047@s.whatsapp.net',
      '447881924047@s.whatsapp.net',
      'Any excuse',
    ]);
  });

  it('resolves on the chat display name, not only the JID', () => {
    // The query itself is the fix: matching ZCONTACTJID alone is what made a
    // group chat name unresolvable.
    expect(SRC).toMatch(/ZPARTNERNAME = \?/);
  });

  it('exits non-zero when the identifier matches no chat at all', () => {
    let code = 0;
    let output = '';
    try {
      output = execFileSync('python3', [SWEEP, 'sent', '--jid', 'zzz-no-such-chat-xyz'], {
        encoding: 'utf8',
      });
    } catch (err) {
      code = err.status;
      output = `${err.stdout || ''}${err.stderr || ''}`;
    }
    expect(code, 'an unresolvable identifier must not exit 0').toBe(2);
    expect(output).toMatch(/"resolved": false/);
    expect(output).not.toMatch(/"found": false/);
  });

  it('counts a link or an attachment as a reply', () => {
    const types = py(`print(json.dumps(list(m.REPLY_MESSAGE_TYPES)))`);
    expect(types).toEqual(expect.arrayContaining([0, 7, 8]));
  });
});
