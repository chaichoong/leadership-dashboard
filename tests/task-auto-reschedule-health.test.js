// 20260822-agent-dispatch-319.
//
// autoRescheduleOverdue() returns {count, failed}. The caller did
// `const r=await autoRescheduleOverdue();` and never read r. A PATCH that
// failed was a console.warn nobody sees, so the task showed today's date in
// the browser and its real date in Airtable until the next reload — and the
// "Auto-reschedule overdue ran" health check returned a HARDCODED pass, off
// the very data that had just been computed and discarded.
//
// A health check that cannot fail is not a check. Both halves are read out of
// the shipped source, so restoring either shape fails here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'os/tasks/index.html'), 'utf8');

function braceEnd(from) {
  let i = src.indexOf('{', from), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error('unbalanced braces');
}

// The real check body, run against a supplied lastAutoReschedule.
function runCheck(lastAutoReschedule) {
  const marker = src.indexOf("name:'Auto-reschedule overdue ran'");
  if (marker === -1) throw new Error('the auto-reschedule health check has been renamed or removed');
  const runAt = src.indexOf('run:()=>', marker);
  const body = src.slice(src.indexOf('{', runAt), braceEnd(runAt));
  return new Function('lastAutoReschedule', `return (() => ${body})();`)(lastAutoReschedule);
}

describe('auto-reschedule health check reports what happened', () => {
  it('fails when a task did not actually move', () => {
    // The bug: on screen it says today, in Airtable it does not.
    const r = runCheck({ count: 3, failed: 2 });
    expect(r.status, 'a failed reschedule still read as a pass').toBe('fail');
    expect(r.detail).toMatch(/2 overdue task/);
  });

  it('passes with the real count when everything moved', () => {
    const r = runCheck({ count: 4, failed: 0 });
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/4 overdue task/);
  });

  it('says so plainly when there was nothing to move', () => {
    const r = runCheck({ count: 0, failed: 0 });
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/No overdue tasks needed moving/);
  });

  it('does not claim a pass before it has run', () => {
    const r = runCheck(null);
    expect(r.status).toBe('warn');
  });

  it('is honest about the paths that skip entirely', () => {
    const r = runCheck({ count: 0, skipped: 'not Kevin' });
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/Not applicable/);
  });

  it('is not a hardcoded pass — it reads a variable', () => {
    // Back-stop: `return {status:'pass',...}` with no branch above it is the
    // exact shape this finding was about.
    const marker = src.indexOf("name:'Auto-reschedule overdue ran'");
    const body = src.slice(src.indexOf('{', src.indexOf('run:()=>', marker)),
                           braceEnd(src.indexOf('run:()=>', marker)));
    expect(body).toContain('lastAutoReschedule');
    expect(body).toMatch(/status:'fail'/);
  });

  it('the caller stores the result instead of dropping it on the floor', () => {
    expect(src, 'the result is assigned to a local that nothing reads')
      .not.toMatch(/const\s+r\s*=\s*await\s+autoRescheduleOverdue\(\)/);
    expect(src).toMatch(/lastAutoReschedule\s*=\s*await\s+autoRescheduleOverdue\(\)/);
  });
});
