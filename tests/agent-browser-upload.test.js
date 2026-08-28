import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The upload step exists because of a hard blocker found on 28 Aug 2026.
//
// Adobe Acrobat has NO <input type=file> anywhere in the DOM — not in the page,
// not in any shadow root (checked both). It creates one when you click "select
// a file", and that click opens a native OS dialog. So page.setInputFiles() has
// nothing to target, and the Chrome-extension lane cannot upload at all.
//
// That single step blocked the whole pipeline Kevin needs: an agent creates a
// PDF, gets it signed in Adobe, then posts or emails it. Playwright intercepts
// the chooser in-process, so the OS dialog never opens.
//
// These tests drive real Playwright against a page that reproduces Adobe's
// create-on-click pattern exactly. A source-level assertion would not prove it.
const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported below */ }

let dir, uploadDir, pagePath, adobeRealPath, mod;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-upload-'));
  uploadDir = join(dir, 'attachments');
  mkdirSync(uploadDir, { recursive: true });
  process.env.AGENT_UPLOAD_DIR = uploadDir;
  mod = require_(join(ROOT, 'scripts/agent-browser.js'));

  writeFileSync(join(uploadDir, 'ast.pdf'), '%PDF-1.4 pretend');
  writeFileSync(join(uploadDir, 'notes.txt'), 'not allowed');
  writeFileSync(join(dir, 'outside.pdf'), '%PDF-1.4 outside the fence');

  // Adobe's REAL behaviour, measured live: the click CREATES a hidden input
  // and leaves it alone. No filechooser event ever fires. Handling only the
  // native-dialog pattern is exactly how the step failed on its first live run.
  adobeRealPath = join(dir, 'adobe_real.html');
  writeFileSync(adobeRealPath, `<!doctype html><meta charset="utf-8">
<button id="pick">select a file</button><p id="out">nothing chosen</p>
<script>
document.getElementById('pick').addEventListener('click', () => {
  if (document.querySelector('input[type=file]')) return;
  const i = document.createElement('input');
  i.type = 'file'; i.multiple = true; i.style.display = 'none';
  i.addEventListener('change', () => {
    const f = i.files[0];
    document.getElementById('out').textContent = f ? 'CHOSEN: ' + f.name : 'nothing chosen';
  });
  document.body.appendChild(i);   // created, NEVER clicked — no OS dialog
});
</script>`);

  pagePath = join(dir, 'adobe_pattern.html');
  writeFileSync(pagePath, `<!doctype html><meta charset="utf-8">
<button id="pick">select a file</button><p id="out">nothing chosen</p>
<script>
document.getElementById('pick').addEventListener('click', () => {
  const i = document.createElement('input');
  i.type = 'file';
  i.addEventListener('change', () => {
    const f = i.files[0];
    document.getElementById('out').textContent = f ? 'CHOSEN: ' + f.name : 'nothing chosen';
  });
  i.click();
});
</script>`);
});

afterAll(() => {
  delete process.env.AGENT_UPLOAD_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('agent-browser upload guard', () => {
  it('accepts a PDF inside the attachments directory', () => {
    expect(mod.assertUploadable(join(uploadDir, 'ast.pdf'))[0]).toContain('ast.pdf');
  });

  // The exfiltration guard. The allowlist stops an agent reaching a bad site;
  // this stops it sending a bad file to a good one.
  it('refuses a file outside the attachments directory', () => {
    expect(() => mod.assertUploadable(join(dir, 'outside.pdf')))
      .toThrow(/outside the attachments directory/i);
  });

  it('refuses a path that escapes via ..', () => {
    expect(() => mod.assertUploadable(join(uploadDir, '..', 'outside.pdf')))
      .toThrow(/outside the attachments directory/i);
  });

  it('refuses a disallowed file type', () => {
    expect(() => mod.assertUploadable(join(uploadDir, 'notes.txt')))
      .toThrow(/not allowed/i);
  });

  it('refuses a file that does not exist', () => {
    expect(() => mod.assertUploadable(join(uploadDir, 'ghost.pdf')))
      .toThrow(/does not exist/i);
  });
});

describe('agent-browser upload step (real Playwright)', () => {
  it('uploads through a native file dialog on a page with no file input', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile'), { headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('file://' + pagePath);

      // Adobe's defining property, asserted rather than assumed.
      expect(await page.locator('input[type=file]').count(),
        'the fixture no longer reproduces Adobe create-on-click').toBe(0);

      const res = await mod.runSteps(page, [
        { do: 'upload', selector: '#pick', file: join(uploadDir, 'ast.pdf') },
      ], false);

      expect(res.stoppedBeforeSubmit).toBeFalsy();
      expect(await page.locator('#out').textContent()).toBe('CHOSEN: ast.pdf');
    } finally {
      await ctx.close();
    }
  }, 60000);

  // The live failure on 28 Aug 2026: Adobe fired no chooser in 30s, and the
  // step timed out even though a perfectly good input was sitting in the DOM.
  it('uploads when the click creates an input but fires no chooser (Adobe)', async () => {
    expect(chromium).toBeTruthy();
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile3'), { headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      let chooserFired = false;
      page.on('filechooser', () => { chooserFired = true; });
      await page.goto('file://' + adobeRealPath);
      expect(await page.locator('input[type=file]').count()).toBe(0);

      await mod.runSteps(page, [
        { do: 'upload', selector: '#pick', file: join(uploadDir, 'ast.pdf') },
      ], false);

      expect(chooserFired, 'fixture no longer reproduces the Adobe pattern').toBe(false);
      expect(await page.locator('#out').textContent()).toBe('CHOSEN: ast.pdf');
    } finally {
      await ctx.close();
    }
  }, 60000);

  it('refuses clearly when the selector matches nothing useful', async () => {
    expect(chromium).toBeTruthy();
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile4'), { headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.setContent('<button id="inert">does nothing</button>');
      await expect(mod.runSteps(page, [
        // Short timeout: the refusal is the point, not waiting 30s for it.
        { do: 'upload', selector: '#inert', file: join(uploadDir, 'ast.pdf'), timeoutMs: 1500 },
      ], false)).rejects.toThrow(/neither a file dialog nor a new/i);
    } finally {
      await ctx.close();
    }
  }, 60000);

  it('still cannot submit in prepare mode', async () => {
    expect(chromium).toBeTruthy();
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile2'), { headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('file://' + pagePath);
      const res = await mod.runSteps(page, [
        { do: 'upload', selector: '#pick', file: join(uploadDir, 'ast.pdf') },
        { do: 'submit', selector: '#pick' },
      ], false);
      expect(res.stoppedBeforeSubmit, 'prepare mode reached submit').toBe(true);
      expect(res.done.at(-1).executed).toBe(false);
    } finally {
      await ctx.close();
    }
  }, 60000);
});

// Adobe's recipient box turns typed text into a recipient CHIP only on Enter.
// Without that, the address is still loose text in a box when Send is pressed,
// and the agreement goes nowhere with no error.
describe('press step', () => {
  it('commits a value that only lands on Enter', async () => {
    expect(chromium).toBeTruthy();
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile5'), { headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.setContent(`<input id="who" placeholder="Enter email..."><ul id="chips"></ul>
        <script>
        document.getElementById('who').addEventListener('keydown', e => {
          if (e.key !== 'Enter') return;
          const li = document.createElement('li');
          li.textContent = e.target.value; document.getElementById('chips').appendChild(li);
          e.target.value = '';
        });
        </script>`);

      await mod.runSteps(page, [
        { do: 'fill', selector: '#who', value: 'kevin@example.com' },
      ], false);
      expect(await page.locator('#chips li').count(),
        'fill alone should NOT commit the recipient').toBe(0);

      await mod.runSteps(page, [
        { do: 'press', selector: '#who', key: 'Enter' },
      ], false);
      expect(await page.locator('#chips li').first().textContent()).toBe('kevin@example.com');
    } finally {
      await ctx.close();
    }
  }, 60000);

  it('will not press keys into a password field', async () => {
    expect(chromium).toBeTruthy();
    const ctx = await chromium.launchPersistentContext(join(dir, 'profile6'), { headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.setContent('<input id="pw" type="password">');
      await expect(mod.runSteps(page, [
        { do: 'press', selector: '#pw', key: 'Enter' },
      ], false)).rejects.toThrow(/password field/i);
    } finally {
      await ctx.close();
    }
  }, 60000);
});

describe('Adobe hosts on the allowlist', () => {
  it('allows the signing-link host and the app host', () => {
    expect(mod.hostAllowed('https://na1.documents.adobe.com/public/esign?tsid=x')).toBe(true);
    expect(mod.hostAllowed('https://acrobat.adobe.com/link/home/')).toBe(true);
  });

  it('does not open adobe.com in general', () => {
    expect(mod.hostAllowed('https://blog.adobe.com/anything')).toBe(false);
  });
});
