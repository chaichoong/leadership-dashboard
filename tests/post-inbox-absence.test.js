// The post pipeline's absence check (finding 20260818-post-manager-weekly-214).
//
// WHY (16 Aug 2026)
// The weekly post phase triggers on a PDF appearing in Google Drive. It ran on
// schedule from 3 Jul to 16 Aug and reported "No new scanned post to process"
// every single week. That was true about the FOLDER and silent about the POST.
// The 16 Aug scan held 29 documents dated 26 Jun to 30 Jul; a 7-day Utilita
// demand, a 14-day Companies House strike-off window, a 14-day charging-order
// window and a 3 Aug BW Legal deadline had all closed unread.
//
// A job that reports success while its real input sits unscanned is
// indistinguishable from a working job. These tests hold the check to the
// "trust surfaces must report absence" rule: silence is only good news when
// something is proving the pipe is fed.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/post-inbox-absence.py');
const DAY = 86400;

// Build a Post Inbox whose Processed folder holds one PDF aged `daysAgo`.
function inbox({ processed = true, pdfs = [], base = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'postinbox-'));
  const root = join(dir, 'Post Inbox');
  if (base) mkdirSync(root, { recursive: true });
  if (base && processed) {
    const p = join(root, 'Processed');
    mkdirSync(p, { recursive: true });
    const now = Date.now() / 1000;
    for (const { name, daysAgo } of pdfs) {
      const f = join(p, name);
      writeFileSync(f, '%PDF-1.4\n');
      utimesSync(f, now - daysAgo * DAY, now - daysAgo * DAY);
    }
  }
  return { root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(root, extra = []) {
  try {
    const stdout = execFileSync('python3', [SCRIPT, '--dir', root, ...extra],
      { encoding: 'utf8' });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('post inbox absence check', () => {
  it('passes quietly when post was scanned inside the window', () => {
    const { root, cleanup } = inbox({ pdfs: [{ name: 'a.pdf', daysAgo: 3 }] });
    const { code, out } = run(root);
    cleanup();
    expect(code).toBe(0);
    expect(out).toMatch(/fresh/);
  });

  it('replays the seven-week gap: 44 days unscanned alarms', () => {
    // 3 Jul to 16 Aug 2026 is the real gap. Before this check it read as
    // "nothing to do" six weeks running.
    const { root, cleanup } = inbox({ pdfs: [{ name: 'a.pdf', daysAgo: 44 }] });
    const { code, out } = run(root);
    cleanup();
    expect(code, 'a seven-week silence still read as a pass').toBe(1);
    expect(out).toMatch(/No physical post has been scanned/i);
    expect(out, 'the alert does not say what Kevin must do').toMatch(/Scan/i);
  });

  it('judges on the NEWEST processed file, not the oldest', () => {
    const { root, cleanup } = inbox({ pdfs: [
      { name: 'old.pdf', daysAgo: 400 }, { name: 'new.pdf', daysAgo: 2 }] });
    const { code } = run(root);
    cleanup();
    expect(code).toBe(0);
  });

  // ── THE CONTROL ────────────────────────────────────────────────────
  // The check being replaced could only ever return "fine". A replacement that
  // also cannot fail buys nothing, so every unreadable state exits 2.
  it('a missing Post Inbox folder is NOT a pass', () => {
    const { root, cleanup } = inbox({ base: false });
    const { code, out } = run(root);
    cleanup();
    expect(code, 'an unmounted Google Drive read as "no post"').toBe(2);
    expect(out).toMatch(/CANNOT TELL/);
  });

  it('a missing Processed folder is NOT a pass', () => {
    const { root, cleanup } = inbox({ processed: false });
    const { code, out } = run(root);
    cleanup();
    expect(code).toBe(2);
    expect(out).toMatch(/CANNOT TELL/);
  });

  it('an empty Processed folder is NOT a pass', () => {
    const { root, cleanup } = inbox({ pdfs: [] });
    const { code, out } = run(root);
    cleanup();
    expect(code).toBe(2);
    expect(out).toMatch(/CANNOT TELL/);
  });

  it('ignores non-PDF clutter when deciding freshness', () => {
    const { root, cleanup } = inbox({ pdfs: [{ name: 'a.pdf', daysAgo: 44 }] });
    writeFileSync(join(root, 'Processed', '.DS_Store'), 'x');
    const { code } = run(root);
    cleanup();
    expect(code, 'a stray .DS_Store made a stale inbox look fresh').toBe(1);
  });

  it('the threshold is a real boundary, not a rounding artefact', () => {
    const fresh = inbox({ pdfs: [{ name: 'a.pdf', daysAgo: 13 }] });
    expect(run(fresh.root).code).toBe(0);
    fresh.cleanup();
    const stale = inbox({ pdfs: [{ name: 'a.pdf', daysAgo: 15 }] });
    expect(run(stale.root).code).toBe(1);
    stale.cleanup();
  });

  it('honours --stale-days so the window can be tuned without a code change', () => {
    const { root, cleanup } = inbox({ pdfs: [{ name: 'a.pdf', daysAgo: 10 }] });
    expect(run(root).code).toBe(0);
    expect(run(root, ['--stale-days', '7']).code).toBe(1);
    cleanup();
  });
});
