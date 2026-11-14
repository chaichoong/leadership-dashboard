import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Real Chrome launches in this file, same reason as agent-browser-upload.test.js: a source
// assertion would prove nothing here. Playwright's own default behaviour is the bug.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported below */ }

// TWO BLOCKERS, ONE FILE (findings 20261015-agent-dispatch-884, 20261013-agent-dispatch-859,
// 20261113-agent-dispatch-1302).
//
//   * NATIVE CONFIRM. Fintable asks "Disable this account?" through window.confirm.
//     Playwright DISMISSES every dialog unless something handles it, so the robot clicked
//     Disable three times, read Enabled three times, and had no on-page modal to look at.
//   * NO DOWNLOAD STEP. A NewDay letter behind a DOWNLOAD PDF button and an Acturis schedule
//     behind a script-driven link both saved nothing: the only download code in agent-browser.js
//     was Adobe's own, bound to Adobe's selectors.
//
// Back-tested by deleting the `dialog` branch (the account stays enabled, as it did live) and by
// deleting the `download` case (unknown step "download").

let dir, downloadDir, confirmPage, downloadPage, viewerPage, mod;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-dialog-'));
  downloadDir = join(dir, 'downloads');
  mkdirSync(downloadDir, { recursive: true });
  // Set BEFORE the require: DOWNLOAD_DIR is read once at module load, and a test never
  // writes into the real ~/knowledge-os folders.
  process.env.AGENT_DOWNLOAD_DIR = downloadDir;
  process.env.AGENT_UPLOAD_DIR = join(dir, 'attachments');
  mkdirSync(process.env.AGENT_UPLOAD_DIR, { recursive: true });
  mod = require_(join(ROOT, 'scripts/agent-browser.js'));

  // Fintable's shape: the only record of the click is what confirm() was answered.
  confirmPage = join(dir, 'confirm.html');
  writeFileSync(confirmPage, `<!doctype html><meta charset="utf-8">
<button id="disable">Disable this account</button><p id="state">Enabled</p>
<script>
document.getElementById('disable').addEventListener('click', () => {
  if (window.confirm('Disable this account?')) document.getElementById('state').textContent = 'Disabled';
});
</script>`);

  // Acturis' shape: a link with no href that builds the file in script.
  downloadPage = join(dir, 'download.html');
  writeFileSync(downloadPage, `<!doctype html><meta charset="utf-8">
<a id="schedule" href="#">Property Owners MTA Accept Schedule</a>
<script>
document.getElementById('schedule').addEventListener('click', (e) => {
  e.preventDefault();
  const blob = new Blob(['%PDF-1.4 schedule 183499934'], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'P6837602300.pdf';
  document.body.appendChild(a);
  a.click();
});
</script>`);

  // The failure mode the step must NAME rather than hide: a link that opens a viewer.
  viewerPage = join(dir, 'viewer.html');
  writeFileSync(viewerPage, `<!doctype html><meta charset="utf-8">
<a id="schedule" href="#">Open schedule</a>
<script>
document.getElementById('schedule').addEventListener('click', (e) => {
  e.preventDefault();
  document.body.insertAdjacentHTML('beforeend', '<div id="viewer">viewer, no file</div>');
});
</script>`);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENT_DOWNLOAD_DIR;
  delete process.env.AGENT_UPLOAD_DIR;
});

const describeIf = chromium ? describe : describe.skip;

describeIf('a native confirm box and a script-driven download', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { if (browser) await browser.close(); });

  async function withPage(file, fn) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto('file://' + file);
    try { return await fn(page); } finally { await ctx.close(); }
  }

  it('answers a confirm() box when the step says accept', async () => {
    await withPage(confirmPage, async (page) => {
      const r = await mod.runSteps(page, [{ do: 'click', selector: '#disable', dialog: 'accept' }], false, null);
      expect(await page.textContent('#state')).toBe('Disabled');
      expect(r.done[0].dialog).toMatchObject({ type: 'confirm', answered: 'accept' });
      expect(r.done[0].dialog.message).toContain('Disable this account');
    });
  });

  it('leaves the default alone: a plain click still dismisses, which is what blocked Fintable', async () => {
    await withPage(confirmPage, async (page) => {
      await mod.runSteps(page, [{ do: 'click', selector: '#disable' }], false, null);
      expect(await page.textContent('#state')).toBe('Enabled');
    });
  });

  it('refuses a dialog answer it does not understand', async () => {
    await withPage(confirmPage, async (page) => {
      await expect(mod.runSteps(page, [{ do: 'click', selector: '#disable', dialog: 'maybe' }], false, null))
        .rejects.toThrow(/"accept" or "dismiss"/);
    });
  });

  it('says so when the click raises no dialog at all, instead of reporting a clean click', async () => {
    await withPage(downloadPage, async (page) => {
      await expect(mod.runSteps(page, [{ do: 'click', selector: '#schedule', dialog: 'accept', dialogWaitMs: 1000 }], false, null))
        .rejects.toThrow(/raised no dialog/);
    });
  });

  it('saves a script-driven download under DOWNLOAD_DIR and reports the path', async () => {
    await withPage(downloadPage, async (page) => {
      const r = await mod.runSteps(page, [{ do: 'download', selector: '#schedule', as: 'P6837602300.pdf' }], false, null);
      const saved = r.done[0].saved;
      // mod.DOWNLOAD_DIR, not the raw temp path: macOS resolves /var to /private/var.
      expect(saved.startsWith(mod.DOWNLOAD_DIR)).toBe(true);
      expect(existsSync(saved)).toBe(true);
      expect(readFileSync(saved, 'utf8')).toContain('183499934');
      expect(r.done[0].bytes).toBeGreaterThan(0);
    });
  });

  it('refuses an "as" that is a path, so a plan cannot write outside the folder', async () => {
    await withPage(downloadPage, async (page) => {
      await expect(mod.runSteps(page, [{ do: 'download', selector: '#schedule', as: '../escape.pdf' }], false, null))
        .rejects.toThrow(/is a file name, not a path/);
    });
  });

  it('refuses a file type the robot may not handle', async () => {
    await withPage(downloadPage, async (page) => {
      await expect(mod.runSteps(page, [{ do: 'download', selector: '#schedule', as: 'payload.exe' }], false, null))
        .rejects.toThrow(/ends in/);
    });
  });

  it('names a link that opens a viewer rather than saving a file', async () => {
    await withPage(viewerPage, async (page) => {
      await expect(mod.runSteps(page, [{ do: 'download', selector: '#schedule', as: 'schedule.pdf', timeoutMs: 2000 }], false, null))
        .rejects.toThrow(/saved no file/);
    });
  });
});
