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
const DRAFTS_URL = 'https://acrobat.adobe.com/link/documents/agreements/?agreement_type=draft';
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
const readVisible = (page) => page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[role="row"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const raw = el.innerText || '';
    // Collapse the rotated duplicate: the list paints every title twice, once
    // forwards and once a letter per line for its narrow layout, so the row's
    // own text holds each name in both forms. The longest single line is the
    // readable one.
    const lines = raw.split('\n').map((x) => x.trim()).filter((x) => x.length > 3);
    const title = lines.sort((a, b) => b.length - a.length)[0] || '';
    if (!title || title === 'RECIPIENTS') return;
    out.push({ title, y: Math.round(r.y) });
  });
  return out.sort((a, b) => a.y - b.y);
});

/**
 * THE LIST IS VIRTUALISED. Only the rows on screen exist in the page, so a
 * single read returned 11 of 48 and looked complete. Scroll and accumulate
 * until nothing new appears.
 */
const readRows = async (page) => {
  const byTitle = new Map();
  let idle = 0;
  for (let i = 0; i < 40 && idle < 3; i++) {
    const seen = await readVisible(page);
    const before = byTitle.size;
    seen.forEach((r) => { if (!byTitle.has(r.title)) byTitle.set(r.title, r); });
    idle = byTitle.size === before ? idle + 1 : 0;
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(900);
  }
  return [...byTitle.values()];
};

async function list() {
  return withPage(async (page) => {
    const rows = await readRows(page);
    return { count: rows.length, drafts: rows.map((r) => r.title) };
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
