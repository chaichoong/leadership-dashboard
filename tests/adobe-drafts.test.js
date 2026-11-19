// Guards adobe-drafts.js's delete step (19 Nov 2026).
//
// WHAT THIS EXISTS FOR
// On 19 Nov 2026 `adobe-drafts.js --delete` refused every draft with "no Delete
// option". Adobe had removed the menu from each row of the drafts list: a row
// now carries a Select box, "Request e-signatures" and a star, so the old
// "last button on the row" was the star. Delete moved to a side panel that
// opens when a row is ticked; the bin is data-test-id="delete-action-button".
//
// The old code also found the row by the first 30 characters of its name.
// That day two drafts of the same document shared those 30 characters, so it
// could delete one and record the other.
//
// These tests drive the real deleteDraft() against a page built to Adobe's
// measured layout. Names are invented.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Real Chrome launches in this file: 90s, as in adobe-assign.test.js (9 Oct 2026).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'adobe-drafts.js');
const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright-core');

let mod;
beforeAll(() => { mod = require_(SCRIPT); });

const FAST = { settle: 20, menu: 50, act: 100 };
const SHORT = 'Release_of_Lease_Jane_Testwood-agreement.pdf';
// Shares SHORT's first 30 characters, and is listed first, as on 19 Nov 2026.
const LONG = 'Release_of_Lease_Jane_Testwood_9_Fake_Road-agreement.pdf';

/**
 * A drafts list as Adobe drew it on 19 Nov 2026. A row is a title, or
 * { t, status, ticked }. Options: confirm (ask before deleting), yesLabel,
 * panelName (the panel names another file), stuck (the delete does nothing),
 * twoBins, panelDialog (the panel is itself a dialog, its bin labelled
 * "Delete", and it stays open after a delete), flicker (the list redraws empty
 * for a moment and the row comes back).
 */
function draftsPage(items, opt = {}) {
  const rows = items.map((it) => {
    const { t, status = 'Agreement Draft', ticked = false } = typeof it === 'string' ? { t: it } : it;
    return `
    <div role="row" aria-selected="${ticked}">
      <div role="gridcell"><input type="checkbox" aria-label="Select"${ticked ? ' checked' : ''}></div>
      <div role="gridcell"><div role="link" title="${t}">${t.slice(0, 24)}<span style="position:absolute;left:-9999px">${t}</span></div><div>${status}</div></div>
      <button aria-label="Request e-signatures">Request e-signatures</button>
      <button aria-label="Remove from starred" class="star">*</button>
      <div role="gridcell">Today, 10:14</div>
    </div>`;
  }).join('');
  const bin = `<button type="button" data-test-id="delete-action-button"${opt.panelDialog ? ' aria-label="Delete"' : ''}><svg width="18" height="18"></svg></button>`;
  const icons = ['rename', 'download', 'move', 'copy']
    .map((k) => `<button type="button" data-test-id="${k}-action-button"><svg width="18" height="18"></svg></button>`).join('') +
    bin + (opt.twoBins ? bin : '');
  const panel = `<div id="panel"${opt.panelDialog ? ' role="dialog"' : ''} style="display:none"><span id="pname"></span><div title="PDF">PDF</div><div>${icons}</div></div>`;
  const dlg = `<div id="dlg" role="dialog" style="display:none"><p>Delete this file?</p>
      <button id="no">Cancel</button><button id="yes">${opt.yesLabel || 'Delete'}</button></div>`;
  return `<!doctype html><meta charset="utf-8">
    <div id="list" style="width:900px">
      <div role="row"><div role="columnheader">NAME</div><div role="columnheader">MODIFIED</div></div>
      <div id="body">${rows}</div>
    </div>
    ${opt.panelDialog ? dlg + panel : panel + dlg}
    <script>
      const opt = ${JSON.stringify(opt)};
      window.__clicks = { star: 0, del: 0 };
      const panel = document.getElementById('panel'), dlg = document.getElementById('dlg');
      const list = document.getElementById('body');
      const ticked = () => [...document.querySelectorAll('[role="row"][aria-selected="true"]')];
      const drop = () => {
        dlg.style.display = 'none';
        if (opt.flicker) {
          const html = list.innerHTML; list.innerHTML = '';
          setTimeout(() => { list.innerHTML = html; }, 150);
          return;
        }
        if (!opt.stuck) ticked().forEach((r) => r.remove());
        if (!opt.panelDialog) panel.style.display = 'none';
      };
      document.querySelectorAll('.star').forEach((b) => b.onclick = () => window.__clicks.star++);
      document.querySelectorAll('input[aria-label="Select"]').forEach((b) => b.onchange = () => {
        b.closest('[role="row"]').setAttribute('aria-selected', String(b.checked));
        const on = ticked();
        const name = opt.panelName || (on[0] ? on[0].querySelector('[title]').getAttribute('title').replace(/\\.pdf$/, '') : '');
        document.getElementById('pname').setAttribute('title', name);
        document.getElementById('pname').textContent = name;
        panel.style.display = on.length ? 'block' : 'none';
      });
      document.querySelectorAll('[data-test-id="delete-action-button"]').forEach((b) => b.onclick = () => {
        window.__clicks.del++;
        if (opt.confirm) dlg.style.display = 'block'; else drop();
      });
      document.getElementById('yes').onclick = drop;
      document.getElementById('no').onclick = () => { dlg.style.display = 'none'; };
    </script>`;
}

async function onPage(html, fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const state = async () => ({
      titles: await page.locator('[role="row"] [title]').evaluateAll((els) => els.map((e) => e.getAttribute('title'))),
      clicks: await page.evaluate(() => window.__clicks),
      ticked: await page.locator('[role="row"][aria-selected="true"]').count(),
    });
    return await fn(page, state);
  } finally {
    await browser.close();
  }
}

describe('adobe-drafts.js delete step (19 Nov 2026 layout)', () => {
  it('passes its own selftest', () => {
    expect(execFileSync('node', [SCRIPT, '--selftest'], { encoding: 'utf8' })).toMatch(/checks passed/);
  });

  it('the row has no menu: its last button is the star the old code pressed', async () => {
    await onPage(draftsPage([LONG, SHORT]), async (page) => {
      const last = page.locator('[role="row"]', { hasText: SHORT.slice(0, 30) }).first().locator('button').last();
      expect(await last.getAttribute('aria-label')).toBe('Remove from starred');
      expect(await page.locator('[role="menuitem"]').count()).toBe(0);
    });
  });

  it('deletes only the named draft when another shares its first 30 characters', async () => {
    expect(LONG.slice(0, 30)).toBe(SHORT.slice(0, 30));
    await onPage(draftsPage([LONG, SHORT]), async (page, state) => {
      await mod.deleteDraft(page, SHORT, FAST);
      const s = await state();
      expect(s.titles).toEqual([LONG]);
      expect(s.clicks).toEqual({ star: 0, del: 1 });
    });
  });

  it('presses Delete in the confirm dialog when Adobe asks', async () => {
    await onPage(draftsPage([LONG, SHORT], { confirm: true }), async (page, state) => {
      await mod.deleteDraft(page, LONG, FAST);
      expect((await state()).titles).toEqual([SHORT]);
    });
  });

  it('refuses, and presses nothing, when the side panel names another file', async () => {
    await onPage(draftsPage([LONG, SHORT], { panelName: 'Some_Other_Lease-agreement' }), async (page, state) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/side panel names \[Some_Other_Lease-agreement\]/);
      const s = await state();
      expect(s.titles).toEqual([LONG, SHORT]);
      expect(s.clicks.del).toBe(0);
      expect(s.ticked).toBe(0);
    });
  });

  it('refuses, and presses nothing, when two rows carry the exact name', async () => {
    await onPage(draftsPage([SHORT, SHORT]), async (page, state) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/2 rows carry the exact name/);
      expect((await state()).clicks.del).toBe(0);
    });
  });

  it('refuses a confirm dialog that offers no Delete or Yes, and leaves the draft', async () => {
    await onPage(draftsPage([SHORT], { confirm: true, yesLabel: 'Move to bin' }), async (page, state) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/offers no Delete or Yes button/);
      expect((await state()).titles).toEqual([SHORT]);
    });
  });

  it('never reports a delete that did not happen: the row must leave the list', async () => {
    await onPage(draftsPage([SHORT], { stuck: true }), async (page) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/still in the list after Delete/);
    });
  });

  it('refuses, and presses nothing, when another row is already ticked', async () => {
    await onPage(draftsPage([{ t: LONG, ticked: true }, SHORT]), async (page, state) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/ticked rows are \[.*\], not just/);
      const s = await state();
      expect(s.titles).toEqual([LONG, SHORT]);
      expect(s.clicks.del).toBe(0);
    });
  });

  it('refuses, and presses nothing, when two Delete buttons are drawn', async () => {
    await onPage(draftsPage([LONG, SHORT], { twoBins: true }), async (page, state) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/2 Delete buttons are drawn/);
      expect((await state()).clicks.del).toBe(0);
    });
  });

  it('presses the bin once when the side panel is itself a dialog with a "Delete" bin', async () => {
    await onPage(draftsPage([LONG, SHORT], { panelDialog: true }), async (page, state) => {
      await mod.deleteDraft(page, SHORT, FAST);
      const s = await state();
      expect(s.titles).toEqual([LONG]);
      expect(s.clicks.del).toBe(1);
    });
  });

  it('a list that redraws empty under its header row for a moment is not a delete', async () => {
    await onPage(draftsPage([LONG, SHORT], { flicker: true }), async (page) => {
      await expect(mod.deleteDraft(page, SHORT, FAST)).rejects.toThrow(/still in the list after Delete/);
    });
  });

  it('clicks the visible Drafts item, not the hidden drop-down copy listed first', async () => {
    // As measured 19 Nov 2026: a hidden <option>Drafts (52)</option> for the
    // narrow layout comes before the side panel's item, and .first() took it.
    const html = `<!doctype html><meta charset="utf-8">
      <select style="display:none"><option value="0">All (60)</option><option value="1">Drafts (2)</option></select>
      <ul><li data-testid="draft" class="spectrum-SideNav-item"><a role="link" tabindex="0">Drafts (2)</a></li></ul>
      <script>window.__clicks = { drafts: 0 };
        document.querySelector('[data-testid="draft"]').onclick = () => window.__clicks.drafts++;</script>`;
    await onPage(html, async (page) => {
      expect(await mod.filterToDrafts(page, 0)).toBe(true);
      expect(await page.evaluate(() => window.__clicks.drafts)).toBe(1);
    });
  });

  it('a signed agreement with "Draft" in its name is not read as a draft', async () => {
    const SIGNED = 'Lease_Draft_Jane_Testwood-agreement.pdf';
    await onPage(draftsPage([{ t: SIGNED, status: 'Completed' }, SHORT]), async (page) => {
      const rows = await mod.readVisible(page);
      expect(rows.map((r) => [r.title, r.status])).toEqual([[SIGNED, 'Completed'], [SHORT, 'Agreement Draft']]);
      expect(() => mod.nextTarget(rows, ['Lease_Draft_Jane'], [])).toThrow(/not a draft/);
    });
  });
});
