#!/usr/bin/env node
/**
 * adobe-drafts.js — see the unsent agreements sitting in Adobe, and remove
 * named ones.
 *
 * WHY (Kevin, 10 Sep 2026): building the multi-signer assignment left a dozen
 * test agreements in the account, and 48 drafts with the real tenancy pack
 * about to join them is a list nobody can send from with confidence. Kevin
 * asked for the duplicates gone.
 *
 * DELETING IS THE DANGEROUS HALF, SO IT IS THE NARROW ONE.
 * There is no "delete everything". A delete names exactly what it may remove
 * and refuses anything else, because the same list holds real agreements that
 * predate today (ciara-hmrc-loa, british-gas-loa-ciara and others). The run
 * prints what it deleted and what it left.
 *
 * USAGE
 *   node scripts/adobe-drafts.js --list
 *   node scripts/adobe-drafts.js --delete "AST_Tristram_Guthrie" --dry
 *   node scripts/adobe-drafts.js --delete "AST_Tristram_Guthrie,ZZ_TagProbe"
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const PROFILE = path.join(os.homedir(), '.config', 'od', 'agent-browser', 'default');
// The side-panel filters are an invisible mirror of a dropdown, so clicking them
// does nothing (two runs on 11 Sep 2026 read signed agreements). Adobe filters by
// ADDRESS, the same way signature-watch reaches Completed.
const DRAFTS_URL = 'https://acrobat.adobe.com/link/documents/agreements/#agreement_type=agreement&agreement_state=draft';
const WAIT = { load: 25000, menu: 2500, act: 4000, settle: 2000 };

let THROW_ON_REFUSE = require.main !== module;
function die(msg) {
  if (THROW_ON_REFUSE) throw new Error('DRAFTS REFUSED: ' + msg);
  console.error('DRAFTS REFUSED: ' + msg);
  process.exit(1);
}

/**
 * A delete pattern has to be specific enough that it cannot take a real
 * agreement with it. Two characters would match half the list.
 */
function parsePatterns(raw) {
  const list = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) die('--delete needs at least one name to match');
  for (const p of list) {
    if (p.length < 6) {
      die(`"${p}" is too short to delete safely. Give at least 6 characters of ` +
          'the agreement name, so a real agreement cannot match by accident.');
    }
    if (p === '*' || p === '.*') die('there is no delete-everything here, on purpose');
  }
  return list;
}

function matches(title, patterns) {
  const t = String(title || '');
  return patterns.some((p) => t.includes(p));
}

async function withPage(fn) {
  const { chromium } = require('playwright');
  const chrome = fs.existsSync('/Applications/Google Chrome.app');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1400, height: 900 },
    channel: chrome ? 'chrome' : undefined,
    ignoreDefaultArgs: chrome ? ['--enable-automation'] : undefined,
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(DRAFTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(WAIT.load);
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

/**
 * Row titles come off the FILE NAME cell. The row's own innerText is unusable:
 * the list paints a rotated duplicate of every title for its narrow layout, so
 * reading the row gives each name twice, once forwards and once a letter per
 * line.
 */
/**
 * Read one screenful of rows. Each row paints its title twice, once forwards
 * and once rotated a letter per line, so the title is the forwards line that
 * looks like a document name, not simply the longest line: a recipient list
 * can be longer.
 */
const readVisible = (page) => page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[role="row"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const lines = (el.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const doc = lines.find((l) => l.length > 8 && /(AST_|Authority_|Proof_of_Residency_|ProofofResidency|ZZ_|-agreement|\.pdf)/.test(l));
    const title = doc || lines.filter((l) => l.length > 3 && l !== 'RECIPIENTS').sort((a, b) => b.length - a.length)[0] || '';
    if (!title || /^(RECIPIENTS|SENDER|TITLE|STATUS|MODIFIED)$/.test(title)) return;
    const date = lines.find((l) => /\d{1,2}\/\d{1,2}\/\d{2,4}|Today|Yesterday|\d{1,2}:\d{2}/.test(l)) || '';
    const status = lines.find((l) => /^(Draft|Signed|Out for signature|Waiting|Cancelled|Expired|Completed|In progress)/i.test(l)) || '';
    out.push({ title, date, status, raw: lines.slice(0, 12) });
  });
  return out;
});

/**
 * THE LIST IS VIRTUALISED AND SCROLLS INSIDE ITS OWN PANEL. Only the rows on
 * screen exist in the page, and scrolling the WINDOW (or wheeling wherever the
 * pointer happens to sit) moves nothing, which is how a read returned 11 of 48
 * and looked complete. Find the rows' own scrolling panel and step it down,
 * collecting rows in Adobe's order, until three steps in a row add nothing.
 */
const readRows = async (page) => {
  const seen = new Map();
  const steps = [];
  let idle = 0;
  for (let i = 0; i < 80 && idle < 4; i++) {
    const rows = await readVisible(page);
    const before = seen.size;
    rows.forEach((r) => { if (!seen.has(r.title)) seen.set(r.title, { ...r, order: seen.size }); });
    idle = seen.size === before ? idle + 1 : 0;
    // Scroll the way a person does: pointer over the last visible row, then
    // the wheel. Whatever element Adobe scrolls, a wheel over the rows reaches
    // it. The panel is also stepped directly, and each step is logged, so a
    // short read says WHY instead of looking complete.
    const last = page.locator('[role="row"]').last();
    const lb = await last.boundingBox().catch(() => null);
    if (lb) {
      await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
      await page.mouse.wheel(0, 700);
    }
    const moved = await page.evaluate(() => {
      const row = document.querySelector('[role="row"]');
      let el = row && row.parentElement;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) break;
        el = el.parentElement;
      }
      if (!el || el === document.body) { window.scrollBy(0, 600); return 'window'; }
      const top = el.scrollTop;
      el.scrollTop = top + Math.max(200, el.clientHeight * 0.8);
      return el.scrollTop === top ? 'bottom' : 'panel';
    });
    await page.waitForTimeout(1200);
    steps.push({ step: i, rowsSeen: seen.size, moved });
  }
  readRows.steps = steps;
  return [...seen.values()].sort((a, b) => a.order - b.order);
};

async function list() {
  return withPage(async (page) => {
    // Filter to drafts from the side panel; the ?agreement_type=draft address
    // alone showed the ALL view, signed agreements included.
    // Measured 11 Sep 2026: the side panel's Drafts item carries data-testid
    // "draft"; the text selectors tried first matched nothing and the run read
    // the ALL view, signed agreements included.
    const drafts = page.locator('[data-testid="draft"]').or(page.getByText(/^Drafts \(\d+\)$/)).first();
    const filtered = await drafts.click({ timeout: 15000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(9000);
    const sort = await page.evaluate(() => {
      const h = [...document.querySelectorAll('[role="columnheader"]')].find((x) => /modified/i.test(x.innerText || ''));
      return h ? (h.getAttribute('aria-sort') || 'unstated') : 'no MODIFIED column found';
    });
    const header = await page.evaluate(() => {
      const t = document.body.innerText.match(/Drafts\s*\((\d+)\)/);
      return t ? Number(t[1]) : null;
    });
    const rows = await readRows(page);
    const nonDraft = rows.filter((r) => r.status && !/^Draft/i.test(r.status)).length;
    if (rows.length && nonDraft) {
      die(`${nonDraft} of ${rows.length} rows are not drafts, so the list is not filtered to ` +
          'drafts and any keep-or-delete call made from it would be wrong.');
    }
    return { filteredToDrafts: rows.length > 0 && nonDraft === 0, clicked: filtered,
             adobeSaysDrafts: header, modifiedSort: sort,
             count: rows.length, steps: readRows.steps, drafts: rows };
  });
}

async function remove(patterns, dry) {
  return withPage(async (page) => {
    const deleted = [];
    const kept = [];
    // Re-read every pass: removing a row reflows the list, so an index taken
    // once goes stale and the next delete hits the wrong agreement.
    for (let pass = 0; pass < 60; pass++) {
      const rows = await readRows(page);
      const target = rows.find((r) => matches(r.title, patterns) && !deleted.includes(r.title));
      if (!target) {
        rows.forEach((r) => { if (!kept.includes(r.title)) kept.push(r.title); });
        break;
      }
      if (dry) { deleted.push(target.title); continue; }
      const row = page.locator('[role="row"]', { hasText: target.title.slice(0, 30) }).first();
      await row.hover().catch(() => {});
      await page.waitForTimeout(WAIT.settle);
      const menu = row.locator('button').last();
      await menu.click({ timeout: 15000 });
      await page.waitForTimeout(WAIT.menu);
      const del = page.locator('[role="menuitem"]:has-text("Delete"), [data-testid*="delete" i]').first();
      if (!(await del.count())) die(`no Delete option on "${target.title}"`);
      await del.click();
      await page.waitForTimeout(WAIT.menu);
      const confirm = page.locator('button:has-text("Delete"), button:has-text("Yes")').last();
      if (await confirm.count()) { await confirm.click(); await page.waitForTimeout(WAIT.act); }
      deleted.push(target.title);
      console.error(`deleted ${target.title}`);
      await page.waitForTimeout(WAIT.settle);
    }
    return { deleted, deletedCount: deleted.length, remaining: kept.length, dry: !!dry };
  });
}

function arg(list, name, dflt) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : dflt;
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  if (rest.includes('--list')) return console.log(JSON.stringify(await list(), null, 2));
  const pat = arg(rest, 'delete');
  if (!pat) die('use --list, or --delete "name,name"');
  const res = await remove(parsePatterns(pat), rest.includes('--dry'));
  console.log(JSON.stringify(res, null, 2));
}

function selftest() {
  THROW_ON_REFUSE = true;
  const cases = [];
  const check = (n, f) => { try { cases.push([n, !!f()]); } catch { cases.push([n, false]); } };
  const refuses = (f) => { try { f(); return false; } catch { return true; } };

  check('a name of six characters or more is accepted',
    () => parsePatterns('ZZ_TagProbe').length === 1);
  check('several names are accepted', () => parsePatterns('AST_Tristram,ZZ_TagProbe').length === 2);
  check('a short name is refused, or it would take real agreements too',
    () => refuses(() => parsePatterns('AST')));
  check('a wildcard is refused', () => refuses(() => parsePatterns('*')));
  check('nothing at all is refused', () => refuses(() => parsePatterns('')));
  check('matching is a plain substring, not a regex',
    () => matches('AST_Tristram_Guthrie-agreement (3).pdf', ['AST_Tristram']));
  check('a real agreement is left alone by a test-name pattern',
    () => !matches('ciara-hmrc-loa', ['AST_Tristram', 'ZZ_TagProbe']));
  check('british-gas-loa-ciara is left alone too',
    () => !matches('british-gas-loa-ciara', ['AST_Tristram', 'ZZ_TagProbe']));

  cases.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  const bad = cases.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) { console.error(`selftest FAILED: ${bad.join(', ')}`); process.exit(1); }
  console.log(`\n${cases.length} checks passed.`);
}

if (require.main === module) main().catch((e) => die(e.message));
module.exports = { parsePatterns, matches };
