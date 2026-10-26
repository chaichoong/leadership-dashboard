import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/post-archive.py');

// Finding 20261023-phase-3-1053 (seen 23 and 24 Oct 2026): step 6 of the post pass archived the
// source with shell commands, which an unattended run refuses, so the post was emailed and then
// emailed again the following week. Every assertion below DRIVES the script against a planted
// tree — a grep of its source would prove only that the rule is written down.

const run = (args) => {
  try {
    return { code: 0, out: execFileSync('python3', [SCRIPT, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
};

const plant = () => {
  const home = mkdtempSync(join(tmpdir(), 'post-archive-'));
  const split = join(home, 'Split');
  const processed = join(home, 'Processed');
  mkdirSync(split);
  const source = join(home, 'scan-2026-10-26.pdf');
  writeFileSync(source, '%PDF-1.4 two documents\n');
  writeFileSync(join(split, 'hmrc_letter.pdf'), 'a');
  writeFileSync(join(split, 'council_notice.pdf'), 'b');
  const marker = join(home, 'logs', 'emailed.json');
  const base = ['--source', source, '--split', split, '--processed', processed,
                '--marker', marker, '--date', '2026-10-26'];
  return { home, split, processed, source, marker, base };
};

describe('post-archive: its own back-tested selftest', () => {
  it('passes, which is what proves each refusal fires on a planted fault', () => {
    const r = run(['--selftest']);
    expect(r.out).toContain('post-archive selftest: ok');
    expect(r.code).toBe(0);
  });
});

describe('post-archive, driven against a planted post tree', () => {
  it('archives the source and clears Split/ when every document sent cleanly', () => {
    const p = plant();
    const r = run(['archive', ...p.base,
                   '--result', 'hmrc_letter.pdf=0', '--result', 'council_notice.pdf=0']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('archived scan-2026-10-26.pdf');
    expect(existsSync(p.source)).toBe(false);
    expect(existsSync(join(p.processed, 'scan-2026-10-26.pdf'))).toBe(true);
    expect(readdirSync(p.split)).toEqual([]);
    // The marker names the source and how many documents went, never its contents.
    expect(readFileSync(p.marker, 'utf8')).toContain('scan-2026-10-26.pdf');
  });

  it('REFUSES on a failed send and leaves the source and Split/ for the retry', () => {
    const p = plant();
    const r = run(['archive', ...p.base,
                   '--result', 'hmrc_letter.pdf=0', '--result', 'council_notice.pdf=1']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('did not send: council_notice.pdf');
    expect(existsSync(p.source)).toBe(true);
    expect(readdirSync(p.split).length).toBe(2);
    expect(existsSync(p.marker)).toBe(false);   // a refusal records nothing
  });

  it('REFUSES when a document in Split/ has no recorded send at all', () => {
    const p = plant();
    const r = run(['archive', ...p.base, '--result', 'hmrc_letter.pdf=0']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no recorded send: council_notice.pdf');
    expect(existsSync(p.source)).toBe(true);
  });

  it('REFUSES with no send results, because nothing then proves the post was emailed', () => {
    const p = plant();
    const r = run(['archive', ...p.base]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no send results given');
    expect(existsSync(p.source)).toBe(true);
  });

  it('records the send BEFORE the move, so a source left behind is never emailed twice', () => {
    const p = plant();
    // Processed/ is a FILE, so the move cannot land: the sends still happened.
    writeFileSync(p.processed, 'not a directory');
    const r = run(['archive', ...p.base,
                   '--result', 'hmrc_letter.pdf=0', '--result', 'council_notice.pdf=0']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('will NOT be emailed again');
    expect(existsSync(p.source)).toBe(true);
    const c = run(['check', '--source', p.source, '--marker', p.marker]);
    expect(c.code).toBe(3);
    expect(c.out).toContain('ALREADY EMAILED');
  });

  it('check reads the content, so a renamed copy of an emailed source is still caught', () => {
    const p = plant();
    run(['archive', ...p.base,
         '--result', 'hmrc_letter.pdf=0', '--result', 'council_notice.pdf=0']);
    const renamed = join(p.home, 'post-again.pdf');
    writeFileSync(renamed, '%PDF-1.4 two documents\n');
    expect(run(['check', '--source', renamed, '--marker', p.marker]).code).toBe(3);
    const other = join(p.home, 'different.pdf');
    writeFileSync(other, '%PDF-1.4 a different scan\n');
    expect(run(['check', '--source', other, '--marker', p.marker]).code).toBe(0);
  });
});
