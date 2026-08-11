import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GS = readFileSync(resolve(ROOT, 'gmail-invoice-script.gs'), 'utf8');

// Finding 20260810-queue-fixer-065.
//
// reconcileWithGmail() decides Paid vs Unpaid by asking whether an invoice's
// Gmail thread is still in the '3: to pay' label. It enumerated that label with
// `label.getThreads(0, 100)` and never paged. Gmail returns at most 100 threads
// and gives no signal that it truncated, so once the label held more than 100
// emails, every thread past the first 100 was absent from the set — and absence
// is exactly how the script recognises "this has been paid". It then set
// Status = Paid and stamped a Paid Date on genuinely unpaid invoices. Nothing
// errored.
//
// Same class as the recon-accuracy pagination incident (Aug 2026), which
// measured the first 100 of 259 rows and read as plausible for a month.
//
// This is Apps Script, not a module, so the reader is parsed out and driven
// against a fake label. Re-implementing the loop in the test would guard nothing.
function loadReader() {
  const m = GS.match(/var THREAD_PAGE_SIZE[\s\S]*?\nfunction readAllThreads\([\s\S]*?\n\}/);
  if (!m) throw new Error('readAllThreads not found in gmail-invoice-script.gs');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return readAllThreads;`)();
}

// A label holding `total` threads, answering the same way Gmail does: at most
// `max` per call, fewer only when the end is reached.
function fakeLabel(total) {
  const calls = [];
  return {
    calls,
    getThreads(start, max) {
      calls.push([start, max]);
      const out = [];
      for (let i = start; i < Math.min(start + max, total); i++) {
        out.push({ getId: () => 'thread-' + i });
      }
      return out;
    },
  };
}

const readAllThreads = loadReader();
const ids = (threads) => threads.map((t) => t.getId());

describe('reconcileWithGmail reads the whole label', () => {
  it('reads every thread when the label holds more than one page', () => {
    const label = fakeLabel(259);
    const got = readAllThreads(label);
    expect(got.length, 'the read stopped at the first page — everything beyond it '
      + 'would be marked Paid').toBe(259);
    expect(ids(got)).toContain('thread-258');
    expect(got.truncated).toBe(false);
  });

  it('a label smaller than one page needs exactly one call', () => {
    const label = fakeLabel(37);
    expect(readAllThreads(label).length).toBe(37);
    expect(label.calls).toHaveLength(1);
  });

  it('an exact multiple of the page size is not cut short', () => {
    // The classic off-by-one: 200 threads returns two full pages, and stopping
    // on "the page was full" without one more call would be right by luck.
    const got = readAllThreads(fakeLabel(200));
    expect(got.length).toBe(200);
    expect(got.truncated).toBe(false);
  });

  it('an empty label is an empty read, not an error', () => {
    const got = readAllThreads(fakeLabel(0));
    expect(got.length).toBe(0);
    expect(got.truncated).toBe(false);
  });

  it('a pathological label is flagged truncated rather than trusted', () => {
    const got = readAllThreads(fakeLabel(100 * 100 + 5));
    expect(got.truncated, 'a partial read would mark the remainder Paid').toBe(true);
  });
});

describe('the reconcile refuses to write from a partial read', () => {
  it('a truncated read returns an error instead of marking anything Paid', () => {
    const fn = GS.match(/function reconcileWithGmail\(\)[\s\S]*?\n\}/)[0];
    expect(fn, 'the single-page read is back').not.toMatch(/label\.getThreads\(0, 100\)/);
    expect(fn).toMatch(/readAllThreads\(label\)/);
    expect(fn, 'a truncated read is not checked before writing')
      .toMatch(/if \(gmailThreads\.truncated\)[\s\S]{0,400}return \{[\s\S]{0,200}error/);
    // The refusal must come BEFORE any Airtable write.
    expect(fn.indexOf('truncated')).toBeLessThan(fn.indexOf('updateAirtableRecord'));
  });

  it('the result reports both directions and both counts', () => {
    const fn = GS.match(/function reconcileWithGmail\(\)[\s\S]*?\n\}/)[0];
    for (const k of ['gmailThreadCount', 'airtableRecordCount', 'markedPaid', 'restoredUnpaid']) {
      expect(fn, `${k} is missing from the result — a silent truncation would be invisible`)
        .toContain(k);
    }
  });
});
