import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GEN = resolve(ROOT, 'scripts/make-letter.js');
const SRC = readFileSync(GEN, 'utf8');
const require_ = createRequire(import.meta.url);
const mod = require_(GEN);

// Stage one of the pipeline: an agent makes the PDF. It only counts if the
// print service can actually read the address off the page, because Pingen has
// NO address parameter — where the address SITS is the address.
describe('make-letter.js', () => {
  it('passes its own selftest', () => {
    const out = execFileSync('node', [GEN, '--selftest'], { encoding: 'utf8' });
    expect(out).toContain('PASS refuses a bare "To:" line in the address');
    expect(out, 'a generator check regressed').not.toContain('FAIL ');
  });

  // 64mm is MEASURED against the live Pingen API, not chosen:
  //   57mm -> address truncated, action_required
  //   64mm -> all lines read, "valid"
  //   71mm -> all lines read, STILL action_required
  // Six HMRC letters were returned "Not at this address" and charged for.
  it('pins the address block at the measured window position', () => {
    expect(mod.ADDRESS_TOP_MM).toBe(64);
    expect(mod.ADDRESS_LEFT_MM).toBe(25);
    const html = mod.buildHtml({
      from: 'agile-lets',
      to: ['Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX'],
      body: ['x'],
    });
    expect(html).toMatch(/top:\s*64mm/);
    expect(html).toMatch(/left:\s*25mm/);
  });

  // The address block must hold ONLY the address. Anything else in the window
  // becomes part of what the printer reads — that is how a reference line ended
  // up recorded as the recipient of a real letter.
  it('puts nothing but the address in the window block', () => {
    const html = mod.buildHtml({
      to: ['Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX'],
      ref: 'Ref: SHOULD NOT BE IN THE WINDOW',
      date: '28 August 2026',
      body: ['body text'],
    });
    const block = html.match(/<div class="to">([\s\S]*?)<\/div>/)[1];
    expect(block).toBe('Corporation Tax\nHM Revenue and Customs\nBX9 1AX');
    expect(block).not.toMatch(/Ref:|August/);
  });

  it('refuses the exact defects that lost real letters', () => {
    const base = { to: ['A Name', 'A Street', 'AB1 2CD'], body: ['x'] };
    expect(() => mod.validate({ ...base, to: ['To:', ...base.to] })).toThrow(/To:/);
    expect(() => mod.validate({ ...base, to: ['Only', 'Two'] })).toThrow(/3 non-empty/);
    expect(() => mod.validate({ ...base, body: [] })).toThrow(/body/);
  });

  it('escapes caller text so a document cannot inject markup', () => {
    const html = mod.buildHtml({
      to: ['A Name', 'A Street', 'AB1 2CD'],
      body: ['<script>alert(1)</script>'],
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  // A generator that writes anywhere else just moves the problem: the sending
  // scripts only post from the attachments directory.
  it('defaults its output into the attachments directory', () => {
    const p = mod.outputPath({ to: ['A Name', 'A Street', 'AB1 2CD'], body: ['x'], name: 'HMRC letter' });
    expect(p.startsWith(mod.OUT_DIR + '/')).toBe(true);
    expect(p).toMatch(/HMRC_letter\.pdf$/);
  });

  // THE SELF-CHECK, back-tested.
  //
  // A real headless agent generated a letter with this tool on 28 Aug 2026 and
  // reported it had "opened the PDF locally for visual verification". It cannot
  // see anything. Its success meant only that the script exited zero. So the
  // tool now measures the laid-out page itself and refuses if the address did
  // not land in the envelope window.
  it('REFUSES when the address does not render in the window, and writes no file', () => {
    const spec = {
      from: 'agile-lets',
      to: ['Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX'],
      body: ['x'],
      name: 'layout_backtest',
    };
    // Break the layout the way a stylesheet failure or a bad edit would.
    const broken = mod.buildHtml(spec).replace(/top:\s*64mm/, 'top: 95mm');
    const out = join(tmpdir(), `letter-backtest-${process.pid}.pdf`);
    rmSync(out, { force: true });

    const r = spawnSync('node', ['-e', `
      const m = require(${JSON.stringify(GEN)});
      const fs = require('fs');
      m.__renderForTest(${JSON.stringify(broken)}, ${JSON.stringify(out)}, ${JSON.stringify(spec.to)})
        .then(() => { console.log('WROTE'); })
        .catch(e => { console.error(e.message); process.exit(1); });
    `], { encoding: 'utf8' });

    expect(r.status, 'a mispositioned address was accepted').not.toBe(0);
    expect((r.stderr || '') + (r.stdout || '')).toMatch(/not 64mm\/25mm|rendered at/);
    expect(existsSync(out), 'a refused letter left a file behind for something to post').toBe(false);
  }, 60000);

  it('reports the address position it MEASURED, not the one it assumed', () => {
    const src = SRC;
    expect(src).toMatch(/getBoundingClientRect/);
    expect(src).toMatch(/verifiedAddressPositionMm/);
    expect(src, 'the measured position must come from the laid-out page')
      .toMatch(/verifyLayout\(page, expectedLines\)/);
  });

  // A real agent could not write to its own $AGENT_SLOT_SCRATCH and fell back
  // to /tmp, leaving the spec AND the finished letter world-readable until
  // reboot. A letter carries creditor, tenant and legal detail. Stdin removes
  // the temp file entirely; the command line is not an option either, because
  // argv is readable via ps.
  it('accepts the spec on stdin so no temp file is needed', () => {
    const spec = JSON.stringify({
      from: 'agile-lets',
      to: ['Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX'],
      body: ['No temp file anywhere.'],
    });
    const out = join(tmpdir(), `letter-stdin-${process.pid}.pdf`);
    rmSync(out, { force: true });
    const r = spawnSync('node', [GEN, '--spec', '-', '--out', out],
      { input: spec, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).verifiedAddressPositionMm.top).toBe(64);
    expect(existsSync(out)).toBe(true);
    rmSync(out, { force: true });
  }, 60000);

  it('refuses a spec that is not valid JSON, rather than guessing', () => {
    const r = spawnSync('node', [GEN, '--spec', '-'], { input: 'not json', encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect((r.stderr || '') + (r.stdout || '')).toMatch(/not valid JSON/);
  }, 60000);

  it('adds no new dependency', () => {
    expect(SRC, 'a PDF library crept in; Chromium is already here and headless-proven')
      .not.toMatch(/require\(['"](reportlab|pdfkit|fpdf|puppeteer)/);
    expect(SRC).toMatch(/playwright-core/);
  });
});
