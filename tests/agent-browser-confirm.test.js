// Guards the submit-confirmation gate (1 Sep 2026).
//
// WHAT THIS EXISTS FOR
// On 28 Aug 2026 four Adobe e-sign sends logged every plan step executed:true,
// ending with a click on "Send" — and all four agreements sat in Adobe as
// DRAFTS for four days. Ciara was never emailed, nothing errored, and the
// tasks were completed. `executed: true` records that Playwright clicked an
// element, never that the site accepted the action. Two rules came out:
//   1. A commit plan that submits must DECLARE its proof of landing
//      (plan.confirm.selector) — refused before the browser launches otherwise.
//   2. After the submit, the proof must APPEAR — the run throws
//      "SUBMIT NOT CONFIRMED" if it does not, so a stranded draft can never
//      read as a sent agreement.
// These tests drive real Playwright against pages reproducing both outcomes,
// exactly like tests/agent-browser-upload.test.js does for the upload trap.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported below */ }

let dir, mod, confirmingPage, silentPage;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-confirm-'));
  mod = require_(join(ROOT, 'scripts/agent-browser.js'));

  // A site that behaves: the submit reveals a confirmation the plan can name.
  confirmingPage = join(dir, 'confirming.html');
  writeFileSync(confirmingPage, `<!doctype html><meta charset="utf-8">
<button id="send">Send</button><div id="out"></div>
<script>document.getElementById('send').addEventListener('click', () => {
  setTimeout(() => {
    const d = document.createElement('div');
    d.id = 'sent'; d.textContent = 'Successfully sent';
    document.getElementById('out').appendChild(d);
  }, 300);
});</script>`);

  // Adobe's REAL 28 Aug behaviour: the Send click lands, the page stays
  // quiet, and the agreement is silently a draft. No error, no confirmation.
  silentPage = join(dir, 'silent.html');
  writeFileSync(silentPage, `<!doctype html><meta charset="utf-8">
<button id="send">Send</button>
<script>document.getElementById('send').addEventListener('click', () => {});</script>`);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('assertConfirmable — no declared proof, no run', () => {
  it('refuses a commit plan that submits without a confirm selector', () => {
    expect(() => mod.assertConfirmable({ steps: [{ do: 'submit', selector: '#send' }] }))
      .toThrow(/BROWSER REFUSED:.*no proof of landing/s);
    expect(() => mod.assertConfirmable({ steps: [{ do: 'submit', selector: '#send' }],
                                         confirm: { selector: '   ' } }))
      .toThrow(/no proof of landing/);
  });

  it('accepts a submitting plan WITH a confirm selector, and any plan that never submits', () => {
    expect(() => mod.assertConfirmable({
      steps: [{ do: 'submit', selector: '#send' }],
      confirm: { selector: '#sent' },
    })).not.toThrow();
    expect(() => mod.assertConfirmable({ steps: [{ do: 'click', selector: '#x' }] }))
      .not.toThrow();
  });

  it('main() checks it for commit before the approval read (source contract)', () => {
    const src = require_('fs').readFileSync(join(ROOT, 'scripts/agent-browser.js'), 'utf8');
    const gate = src.indexOf("assertConfirmable(plan)");
    const approval = src.indexOf("assertApproved(arg(rest, 'task'))");
    expect(gate).toBeGreaterThan(-1);
    expect(approval).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(approval);
  });
});

describe.skipIf(!chromium)('the confirm check against real pages', () => {
  const run = async (pagePath, confirm) => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto('file://' + pagePath);
      return await mod.runSteps(page, [{ do: 'submit', selector: '#send' }], true, confirm);
    } finally { await browser.close(); }
  };

  it('passes when the page shows the declared proof, and records the confirm step', async () => {
    const r = await run(confirmingPage, { selector: '#sent', timeoutMs: 5000 });
    expect(r.stoppedBeforeSubmit).toBe(false);
    const confirmStep = r.done.find((s) => s.do === 'confirm');
    expect(confirmStep).toBeTruthy();
    expect(confirmStep.executed).toBe(true);
  }, 30000);

  it('THROWS on the 28 Aug pattern: submit pressed, page silent, action not done', async () => {
    await expect(run(silentPage, { selector: '#sent', timeoutMs: 2000 }))
      .rejects.toThrow(/SUBMIT NOT CONFIRMED.*NOT DONE/s);
  }, 30000);

  it('prepare mode still stops before the submit and never reaches the confirm', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto('file://' + silentPage);
      const r = await mod.runSteps(page, [{ do: 'submit', selector: '#send' }],
                                   false, { selector: '#sent', timeoutMs: 1000 });
      expect(r.stoppedBeforeSubmit).toBe(true);
      expect(r.done.find((s) => s.do === 'confirm')).toBeUndefined();
    } finally { await browser.close(); }
  }, 30000);
});
