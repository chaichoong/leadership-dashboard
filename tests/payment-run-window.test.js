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
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name}() not found in js/invoices.js`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  expect(end, `could not find the end of ${name}()`).toBeGreaterThan(open);
  return src.slice(start, end);
}

function loadJsWindow() {
  const src = readFileSync(join(ROOT, 'js', 'invoices.js'), 'utf8');
  const body = ['paymentRunWindow', 'paymentRunBuckets', 'localISODate']
    .map((n) => extractFn(src, n)).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return { paymentRunWindow, paymentRunBuckets, localISODate };`)();
}

function pyWindow(asof) {
  const out = execFileSync('python3', [PY, 'window', '--asof', asof], { encoding: 'utf8' });
  return JSON.parse(out);
}

const { paymentRunWindow, paymentRunBuckets, localISODate } = loadJsWindow();

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

describe('three sections', () => {
  // Kevin, 18 Sep 2026, six minutes past the cutoff with the week's invoices
  // still unpaid: what he was about to pay had dropped out of "This week" and
  // landed in "Still owed" beside February's debts. Two boundaries, not one.
  const FRIDAY_9PM_PLUS = new Date('2026-09-18T21:05:00+01:00');

  it('after the cutoff, the week being paid is Last week', () => {
    const { thisWeekStart, lastWeekStart } = paymentRunBuckets(FRIDAY_9PM_PLUS);
    expect(thisWeekStart.toISOString()).toBe(new Date('2026-09-18T21:00:00+01:00').toISOString());
    expect(lastWeekStart.toISOString()).toBe(new Date('2026-09-11T21:00:00+01:00').toISOString());
  });

  it('the £90 invoice from 16 Sep lands in Last week, NOT Still owed', () => {
    // The exact regression Kevin reported, with the real invoice date.
    const { thisWeekStart, lastWeekStart } = paymentRunBuckets(FRIDAY_9PM_PLUS);
    const day = '2026-09-16';
    expect(day >= localISODate(thisWeekStart)).toBe(false);   // not This week
    expect(day >= localISODate(lastWeekStart)).toBe(true);    // IS Last week
  });

  it('February stays in Still owed', () => {
    const { lastWeekStart } = paymentRunBuckets(FRIDAY_9PM_PLUS);
    expect('2026-02-03' >= localISODate(lastWeekStart)).toBe(false);
  });

  it('the tab and the script agree on BOTH boundaries — both read from source', () => {
    for (const asof of ['2026-09-18T20:59:00+01:00',
                        '2026-09-18T21:05:00+01:00',
                        '2026-09-21T09:00:00+01:00',
                        '2026-10-28T09:00:00+00:00']) {
      const py = pyWindow(asof);
      const js = paymentRunBuckets(new Date(asof));
      expect(new Date(py.buckets.thisWeekStart).toISOString(), `thisWeekStart for ${asof}`)
        .toBe(js.thisWeekStart.toISOString());
      expect(new Date(py.buckets.lastWeekStart).toISOString(), `lastWeekStart for ${asof}`)
        .toBe(js.lastWeekStart.toISOString());
    }
  });

  it('localISODate does not slip a day via UTC', () => {
    // toISOString() converts to UTC first, so a London time in the small hours
    // of BST returns the PREVIOUS day and shifts every section boundary.
    expect(localISODate(new Date('2026-07-01T00:30:00+01:00'))).toBe('2026-07-01');
    expect(new Date('2026-07-01T00:30:00+01:00').toISOString().slice(0, 10)).toBe('2026-06-30');
  });
});

describe('the scan reads backwards from now, never forwards', () => {
  // THE 18 Sep 2026 bug. The job is scheduled for 21:00 — the cutoff itself —
  // so asking "which week is it" at that instant answers with the one just
  // STARTING. The first live run scanned seven days of mail that had not
  // arrived, reported "0 new payables", and exited 0.
  it.each(['2026-09-18T20:59:00+01:00',
           '2026-09-18T21:00:00+01:00',
           '2026-09-18T21:05:00+01:00',
           '2026-09-19T02:00:00+01:00'])
    ('firing at %s still covers the week that just closed', (asof) => {
      const py = pyWindow(asof);
      const start = new Date(py.scanRange.start);
      const end = new Date(py.scanRange.end);
      expect(end.getTime()).toBe(new Date(asof).getTime());       // ends now
      expect(start.getTime()).toBeLessThan(new Date('2026-09-11T21:00:00+01:00').getTime());
    });

  it('the scan range is never the empty week ahead', () => {
    const py = pyWindow('2026-09-18T21:00:00+01:00');
    expect(new Date(py.scanRange.start).getTime())
      .toBeLessThan(new Date(py.window ?? py.start ?? '2026-09-18T21:00:00+01:00').getTime());
    // and the display week that instant IS the one ahead, which is exactly why
    // the two must not share a definition
    expect(new Date(py.start).toISOString())
      .toBe(new Date('2026-09-18T21:00:00+01:00').toISOString());
  });
});
