// A signed document must become its agent's next job, not a log line
// (4 Sep 2026). Three letters of authority came back signed on 2 Sep; the
// watcher downloaded them on 3 Sep, printed "next: submit gate 2" and
// stopped. Their tasks were Completed at gate 1, so nothing ever read that.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const { unhandedSigned } = require_(join(ROOT, 'scripts', 'signature-watch.js'));
const src = readFileSync(join(ROOT, 'scripts', 'signature-watch.js'), 'utf8');

const rows = [
  { cmd: 'register', task: 'recA', agreement: 'loa-a', then: 'post' },
  { cmd: 'register', task: 'recB', agreement: 'loa-b', then: 'email' },
  { cmd: 'signed', task: 'recA', agreement: 'loa-a', then: 'post', pdf: '/x/a.pdf' },
  { cmd: 'signed', task: 'recB', agreement: 'loa-b', then: 'email', pdf: '/x/b.pdf' },
  { cmd: 'handoff', task: 'recA', agreement: 'loa-a' },
];

describe('signature-watch hands signed documents to their agent', () => {
  it('lists every signed row that has no hand-off yet, and only those', () => {
    expect(unhandedSigned(rows).map((r) => r.task)).toEqual(['recB']);
    expect(unhandedSigned(rows.filter((r) => r.cmd !== 'handoff')).map((r) => r.task)).toEqual(['recA', 'recB']);
    expect(unhandedSigned([])).toEqual([]);
  });
  it('poll hands off in BOTH branches — the early "nothing registered" return once skipped it', () => {
    const poll = src.slice(src.indexOf('async function cmdPoll'), src.indexOf('async function cmdStatus'));
    expect((poll.match(/handOffAll\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(poll).not.toMatch(/Submit gate 2 for each/);
  });
  it('the hand-off goes through the dispatch engine, which has the command', () => {
    expect(src).toMatch(/'agent-dispatch\.py'\), 'signed'/);
    const help = execFileSync('python3', [join(ROOT, 'scripts', 'agent-dispatch.py'), 'signed', '--help'], { encoding: 'utf8' });
    expect(help).toMatch(/--agreement/);
    expect(help).toMatch(/--pdf/);
    expect(help).toMatch(/--then/);
  });
});
