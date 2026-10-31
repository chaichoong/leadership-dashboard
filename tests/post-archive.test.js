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
    // The refusal does not archive, and it does not mark the SOURCE emailed...
    expect(run(['check', '--source', p.source, '--marker', p.marker]).code).toBe(0);
    // ...but it keeps the one document that did send (finding 20261027-agent-dispatch-1095).
    expect(JSON.parse(readFileSync(p.marker, 'utf8'))[Object.keys(
      JSON.parse(readFileSync(p.marker, 'utf8')))[0]].sent)
      .toEqual({ 'hmrc_letter.pdf': '2026-10-26' });
  });

  // Finding 20261027-agent-dispatch-1095, verified 27 Oct on task recDy2W56Qc8SJvxr: the
  // ledger was written only when EVERY document sent, so 3 of 5 clean sends were forgotten
  // and the next pass emailed all five again (the 23 and 25 Oct double emails). Back-tested
  // by deleting the record_sent call in cmd_archive: the first two expects below fail.
  it('a partial send is remembered document by document, so the retry re-sends only the failure', () => {
    const p = plant();
    run(['archive', ...p.base, '--result', 'hmrc_letter.pdf=0', '--result', 'council_notice.pdf=1']);
    // The next pass asks per document before sending.
    const done = run(['check', '--source', p.source, '--document', 'hmrc_letter.pdf',
                      '--marker', p.marker]);
    expect(done.code).toBe(3);
    expect(done.out).toContain('ALREADY EMAILED document hmrc_letter.pdf');
    expect(run(['check', '--source', p.source, '--document', 'council_notice.pdf',
                '--marker', p.marker]).code).toBe(0);
    // The whole source still reads as not emailed, and says which to skip.
    const whole = run(['check', '--source', p.source, '--marker', p.marker]);
    expect(whole.code).toBe(0);
    expect(whole.out).toContain('must be skipped: hmrc_letter.pdf');
    // The retry sends only council_notice.pdf and the source archives, counting both.
    const r = run(['archive', ...p.base, '--result', 'council_notice.pdf=0']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('after 2 clean send(s) (1 of them recorded by an earlier pass)');
    expect(existsSync(join(p.processed, 'scan-2026-10-26.pdf'))).toBe(true);
    expect(readdirSync(p.split)).toEqual([]);
  });

  it('sent records a clean send on its own, and refuses a non-zero one', () => {
    const p = plant();
    expect(run(['sent', '--source', p.source, '--result', 'hmrc_letter.pdf=0',
                '--marker', p.marker, '--date', '2026-10-26']).code).toBe(0);
    expect(run(['check', '--source', p.source, '--document', 'hmrc_letter.pdf',
                '--marker', p.marker]).code).toBe(3);
    const bad = run(['sent', '--source', p.source, '--result', 'council_notice.pdf=1',
                     '--marker', p.marker]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('nothing to record');
    expect(run(['check', '--source', p.source, '--document', 'council_notice.pdf',
                '--marker', p.marker]).code).toBe(0);
  });

  it('a marker from the older script still reads as emailed, so an upgrade re-emails nothing', () => {
    const p = plant();
    run(['archive', ...p.base,
         '--result', 'hmrc_letter.pdf=0', '--result', 'council_notice.pdf=0']);
    // The flat shape the previous version wrote: a date and a count, no `emailed` key.
    const dg = Object.keys(JSON.parse(readFileSync(p.marker, 'utf8')))[0];
    writeFileSync(p.marker, JSON.stringify(
      { [dg]: { source: 'scan-2026-10-26.pdf', date: '2026-10-20', documents: 2 } }));
    const again = join(p.home, 'same-content.pdf');
    writeFileSync(again, '%PDF-1.4 two documents\n');
    const c = run(['check', '--source', again, '--marker', p.marker]);
    expect(c.code).toBe(3);
    expect(c.out).toContain('ALREADY EMAILED');
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
