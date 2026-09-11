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
    // A TALL WINDOW DRAWS THE WHOLE LIST. Adobe's list only draws the rows that
    // fit on screen and stopped advancing on scroll at 30 of 66 (11 Sep 2026).
    // Given room for every row, it has nothing to hide.
    headless: true, viewport: { width: 1400, height: Number(process.env.DRAFTS_VIEWPORT_H) || 8000 },
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
    // THE FULL NAME IS IN THE TITLE ATTRIBUTE. The drawn column is truncated:
    // "Authority_Daniel_Gathercole_55" loses the "(2)" that tells copies apart.
    // Measured 11 Sep 2026: title="AST- Jason Smith-agreement (1).pdf".
    const t = [...el.querySelectorAll('[title]')].map((x) => x.getAttribute('title'))
      .find((v) => v && /\.pdf$|-agreement/i.test(v));
    const lines = (el.innerText || '').split('\n').map((x) => x.trim()).filter((l) => l.length > 1);
    const title = t || lines.find((l) => /\.pdf$/i.test(l)) || '';
    if (!title) return;
    // The fullest date line: the drawn copy is cut ("22 De", "Today,").
    const dates = lines.filter((l) => /(\d{1,2} [A-Z][a-z]{2} \d{4})|(Today|Yesterday)|(\d{1,2}:\d{2})/.test(l));
    const date = dates.sort((a, b) => b.length - a.length)[0] || '';
    // "Agreement Draft", not "Draft": the old anchored match read every one blank.
    const status = lines.find((l) => /draft|signed|out for signature|cancelled|expired|completed/i.test(l)) || '';
    out.push({ title, date, status });
  });
  return out;
});

const readRows = async (page) => {
  const seen = new Map();
  const steps = [];
  let idle = 0;
  for (let i = 0; i < 120 && idle < 6; i++) {
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
      // The scroller is not always an ancestor of the rows: search every
      // element that can scroll and holds a row.
      const row = document.querySelector('[role="row"]');
      const cands = [...document.querySelectorAll('*')].filter((el) => {
        const cs = getComputedStyle(el);
        return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40 &&
               row && el.contains(row);
      });
      const el = cands.sort((a, b) => a.clientHeight - b.clientHeight)[0];
      if (!el) { window.scrollBy(0, 700); return 'window'; }
      const top = el.scrollTop;
      el.scrollTop = top + Math.max(250, el.clientHeight * 0.8);
      return el.scrollTop === top ? 'bottom' : 'panel';
    });
    await page.waitForTimeout(2500);
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
    const nonDraft = rows.filter((r) => !/draft/i.test(r.status || '')).length;
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

/**
 * When was this draft last modified, as a sortable number? "Today, 17:30" and
 * "Yesterday, 09:05" carry a time; "22 Dec 2025" carries only a day, so two
 * copies from the same day cannot be told apart and are flagged, never guessed.
 */
function whenModified(txt, now = new Date()) {
  const s = String(txt || '');
  const tm = s.match(/(\d{1,2}):(\d{2})/);
  const at = (d) => { if (tm) d.setHours(Number(tm[1]), Number(tm[2]), 0, 0); return d.getTime(); };
  if (/today/i.test(s)) return { t: at(new Date(now)), exact: !!tm };
  if (/yesterday/i.test(s)) { const d = new Date(now); d.setDate(d.getDate() - 1); return { t: at(d), exact: !!tm }; }
  const m = s.match(/(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})/);
  if (m) return { t: at(new Date(`${m[2]} ${m[1]}, ${m[3]}`)), exact: !!tm };
  return { t: 0, exact: false };
}

/** "Authority_X-agreement (2).pdf" and "Authority_X-agreement.pdf" are copies of one document. */
function baseName(title) {
  return String(title || '').replace(/\.pdf$/i, '').replace(/ \(\d+\)$/, '').replace(/-agreement$/i, '').trim();
}

/**
 * For each document with more than one draft, keep the most recently modified
 * and mark the rest to delete. A bracket number is NOT recency: the first upload
 * has none and later ones count up, so where an early attempt failed and a later
 * one passed, the good copy is the numbered one (Adam Bishop-Bridges' authority
 * is "(2)").
 */
function planDuplicates(rows, now) {
  const groups = new Map();
  for (const r of rows) {
    const k = baseName(r.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...r, when: whenModified(r.date, now) });
  }
  const plan = [];
  for (const [doc, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.when.t - a.when.t);
    const tie = list.length > 1 && list[0].when.t === list[1].when.t && !list[0].when.exact;
    plan.push({ doc, keep: tie ? null : list[0].title,
                delete: tie ? [] : list.slice(1).map((x) => x.title),
                unsure: tie ? list.map((x) => `${x.title} (${x.date})`) : [] });
  }
  return plan.sort((a, b) => a.doc.localeCompare(b.doc));
}

function arg(list, name, dflt) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : dflt;
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  if (rest.includes('--list')) return console.log(JSON.stringify(await list(), null, 2));
  if (rest.includes('--dupes')) {
    const l = await list();
    return console.log(JSON.stringify({ read: l.count, adobeSays: l.adobeSaysDrafts,
                                        plan: planDuplicates(l.drafts) }, null, 2));
  }
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

  const NOW = new Date('2026-09-11T03:00:00');
  check('copies with and without a bracket number are one document',
    () => baseName('Authority_Adam-agreement (2).pdf') === baseName('Authority_Adam-agreement.pdf'));
  // The rule Kevin nearly used: "the bracketed ones are the duplicates". It is
  // wrong whenever an early attempt failed and a later one passed.
  check('the newest copy is kept even when it is the bracketed one',
    () => { const p = planDuplicates([
      { title: 'Auth_A-agreement.pdf', date: 'Today, 01:10' },
      { title: 'Auth_A-agreement (2).pdf', date: 'Today, 02:40' }], NOW);
      return p[0].keep === 'Auth_A-agreement (2).pdf' && p[0].delete[0] === 'Auth_A-agreement.pdf'; });
  check('same-day copies with no time are flagged, never guessed',
    () => { const p = planDuplicates([
      { title: 'X-agreement.pdf', date: '22 Dec 2025' },
      { title: 'X-agreement (1).pdf', date: '22 Dec 2025' }], NOW);
      return p[0].keep === null && p[0].unsure.length === 2 && p[0].delete.length === 0; });
  check('a document with one draft is not touched',
    () => planDuplicates([{ title: 'Solo-agreement.pdf', date: 'Today, 01:00' }], NOW).length === 0);
  check('Today and Yesterday are ordered by their times',
    () => whenModified('Today, 01:00', NOW).t > whenModified('Yesterday, 23:00', NOW).t);
  cases.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  const bad = cases.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) { console.error(`selftest FAILED: ${bad.join(', ')}`); process.exit(1); }
  console.log(`\n${cases.length} checks passed.`);
}

if (require.main === module) main().catch((e) => die(e.message));
module.exports = { parsePatterns, matches, whenModified, baseName, planDuplicates };
