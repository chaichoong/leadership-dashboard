// The payment-run week, and the fact that the tab and the scan agree about it.
//
// There are TWO implementations of one rule: run_window() in
// scripts/payment-run.py fills the table, paymentRunWindow() in js/invoices.js
// draws it. If they ever disagree the tab silently shows the wrong week — rows
// the scan filed as "this week" appear under "Still owed", or the reverse, and
// nothing errors. So both are extracted from source and compared here rather
// than copied into the test, which would only prove the copy agrees with itself.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(ROOT, 'scripts', 'payment-run.py');

// Pull the real function out of js/invoices.js and evaluate it. Copying it
// would defeat the point: the test must break when the SHIPPED code changes.
function loadJsWindow() {
  const src = readFileSync(join(ROOT, 'js', 'invoices.js'), 'utf8');
  const start = src.indexOf('function paymentRunWindow(');
  expect(start, 'paymentRunWindow() not found in js/invoices.js').toBeGreaterThan(-1);
  // Walk braces from the function's opening brace to its matching close.
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  expect(end, 'could not find the end of paymentRunWindow()').toBeGreaterThan(open);
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}; return paymentRunWindow;`)();
}

function pyWindow(asof) {
  const out = execFileSync('python3', [PY, 'window', '--asof', asof], { encoding: 'utf8' });
  return JSON.parse(out);
}

const paymentRunWindow = loadJsWindow();

describe('payment run window', () => {
  it('ends at Friday 21:00, not 16:00 — Kevin moved the cutoff on 18 Sep 2026', () => {
    const { end } = paymentRunWindow(new Date('2026-09-16T09:00:00+01:00'));
    expect(end.getHours()).toBe(21);
    expect(end.getDay()).toBe(5); // Friday
  });

  it('a Friday BEFORE 21:00 still belongs to that evening’s run', () => {
    const { start, end } = paymentRunWindow(new Date('2026-09-18T20:59:00+01:00'));
    expect(end.toISOString()).toBe(new Date('2026-09-18T21:00:00+01:00').toISOString());
    expect(start.toISOString()).toBe(new Date('2026-09-11T21:00:00+01:00').toISOString());
  });

  it('a minute after the cutoff opens the next week', () => {
    const { start, end } = paymentRunWindow(new Date('2026-09-18T21:01:00+01:00'));
    expect(end.toISOString()).toBe(new Date('2026-09-25T21:00:00+01:00').toISOString());
    // No gap and no overlap: this week starts exactly where the last one ended.
    expect(start.toISOString()).toBe(new Date('2026-09-18T21:00:00+01:00').toISOString());
  });

  it('the window is always exactly seven days', () => {
    for (const day of ['2026-09-14', '2026-09-16', '2026-09-19', '2026-09-20']) {
      const { start, end } = paymentRunWindow(new Date(`${day}T12:00:00+01:00`));
      expect((end - start) / 86400000).toBe(7);
    }
  });

  it('the tab and the scan agree about the week — both read from source', () => {
    // If these drift, rows filed by the scan as "this week" would be drawn
    // under "Still owed" and nothing would raise an error.
    for (const asof of ['2026-09-15T09:00:00+01:00',
                        '2026-09-18T20:59:00+01:00',
                        '2026-09-18T21:01:00+01:00',
                        '2026-10-28T09:00:00+00:00']) {
      const py = pyWindow(asof);
      const js = paymentRunWindow(new Date(asof));
      expect(new Date(py.start).toISOString(), `start for ${asof}`).toBe(js.start.toISOString());
      expect(new Date(py.end).toISOString(), `end for ${asof}`).toBe(js.end.toISOString());
    }
  });

  it('survives the clocks going back — the cutoff is 21:00 LOCAL, not a fixed UTC hour', () => {
    // BST ends 25 Oct 2026. A window pinned to a UTC hour would drift to 20:00
    // or 22:00 local and quietly move the boundary for half the year.
    const py = pyWindow('2026-10-28T09:00:00+00:00');
    const js = paymentRunWindow(new Date('2026-10-28T09:00:00+00:00'));
    expect(js.end.getHours()).toBe(21);
    expect(new Date(py.end).getHours()).toBe(21);
  });
});

describe('the payment-run script is self-consistent', () => {
  it('its own selftest passes', () => {
    // The scan's pure functions — the pre-filter, the duplicate key, the payee
    // corroboration, the quota classification — are covered there, offline.
    const out = execFileSync('python3', [PY, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('all checks pass');
  });
});
