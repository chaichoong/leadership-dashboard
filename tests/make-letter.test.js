import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
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

  it('adds no new dependency', () => {
    expect(SRC, 'a PDF library crept in; Chromium is already here and headless-proven')
      .not.toMatch(/require\(['"](reportlab|pdfkit|fpdf|puppeteer)/);
    expect(SRC).toMatch(/playwright-core/);
  });
});
