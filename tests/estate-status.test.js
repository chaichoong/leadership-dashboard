import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRITER = resolve(ROOT, 'scripts/estate-status.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// Kevin's audit, 14 Sep 2026. From 13:00 Friday to 19:00 Sunday the Claude
// allowance was out and nothing ran; every wrapper logged it and no surface
// Kevin looks at said so. scripts/estate-status.py mirrors the job logs into
// the Estate Status table every ten minutes; the Estate status tab on the AI
// Agents page reads it. These tests guard the mirror AND its wiring: a writer
// filling fields the page cannot see, or a page tab nobody can open, recreates
// the exact invisibility this was built to end.

describe('estate-status.py', () => {
  it('passes its own selftest (allowance -> Blocked with the reset time, Running, Skipped, Idle, plain-words failure)', () => {
    const out = JSON.parse(execFileSync('python3', [WRITER, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(16);
  });

  it('is registered in job-schedule.json as a lock-exempt ten-minute job and described in the automations list', () => {
    const sched = JSON.parse(read('scripts/job-schedule.json'));
    expect(sched['estate-status']).toBeTruthy();
    expect(sched['estate-status'].cron).toBe('*/10 * * * *');
    expect(sched['estate-status'].lockExempt).toBe(true);
    expect(sched['estate-status'].mode).toBe('wrapped');
    expect(read('js/automations-data.js')).toMatch(/key: 'estate-status'/);
  });

  it('never writes an empty board: a missing status log or an empty schedule refuses, loudly', () => {
    const src = read('scripts/estate-status.py');
    expect(src).toMatch(/refusing to write an empty board/);
    expect(src).toMatch(/is missing — the wrappers write it on every run/);
  });
});

describe('the Estate status tab', () => {
  const page = read('os/agents/index.html');

  it('field ids match the writer (drift guard)', () => {
    const pageBlock = page.match(/const ES = \{([\s\S]*?)\};/);
    const pyBlock = read('scripts/estate-status.py').match(/^ES = \{([\s\S]*?)\}/m);
    expect(pageBlock, 'ES block on the page (control)').not.toBeNull();
    expect(pyBlock, 'ES block in the writer (control)').not.toBeNull();
    const keys = ['key', 'kind', 'label', 'schedule', 'status', 'lastRun', 'lastWorked', 'detail', 'nextDue', 'runs24h', 'fails24h', 'payload', 'updated'];
    for (const k of keys) {
      const pageId = pageBlock[1].match(new RegExp(`${k}:\\s*'(fld[A-Za-z0-9]+)'`));
      const pyId = pyBlock[1].match(new RegExp(`"${k}":\\s*"(fld[A-Za-z0-9]+)"`));
      expect(pageId, `${k} on the page`).not.toBeNull();
      expect(pyId, `${k} in the writer`).not.toBeNull();
      expect(pyId[1]).toBe(pageId[1]);
    }
    expect(page).toMatch(/const ESTATE_TBL = 'tblZVrdzivyBueZVf'/);
    expect(read('scripts/estate-status.py')).toMatch(/TABLE = "tblZVrdzivyBueZVf"/);
  });

  it('is a page tab Kevin can open, deep-linkable as #tab=estate (and #tab=status)', () => {
    expect(page).toMatch(/id="ptab-estate"[^>]*onclick="switchAgentsView\('estate'\)"/);
    expect(page).toMatch(/<div class="page-view" id="view-estate">/);
    expect(page).toMatch(/const AGENT_VIEWS = \['dashboard','approvals','checks','estate'\];/);
    expect(page).toMatch(/'status': 'estate'/);
    expect(page).toMatch(/if\(view==='estate'\) loadEstateStatus\(\);/);
  });

  it('says when the mirror itself has stopped, instead of showing a calm old board', () => {
    expect(page).toMatch(/The status writer itself has stopped/);
    expect(page).toMatch(/const ESTATE_STALE_MIN = 30;/);
    // and the sync bar carries the same check, so the sidebar dot goes red too
    expect(page).toMatch(/name: 'Estate status fresh'/);
  });

  it('a read error is shown as an error, never as an empty list', () => {
    expect(page).toMatch(/Could not read the Estate Status table \(\$\{esc\(e\.message\|\|e\)\}\)\. This list is NOT empty/);
    expect(page).toMatch(/Could not read the content table \(\$\{esc\(e\.message\|\|e\)\}\)\. This list is NOT empty/);
  });

  it('escapes every Airtable-sourced string it renders', () => {
    const block = page.slice(page.indexOf('function renderEstateStatus('), page.indexOf('async function loadEstateContent('));
    // every gf(...) read that lands in HTML goes through esc()
    const raw = block.match(/\$\{gf\(r,'[a-zA-Z0-9]+'\)\}/g) || [];
    expect(raw, 'unescaped field interpolations').toEqual([]);
  });

  it('shows the channels the publisher actually writes (same field names as LINK_FIELDS)', () => {
    const pub = read('scripts/content-engine/publish.py');
    for (const name of ['YouTube Full Link', 'Link of Youtube Shorts', 'Link of Facebook Reels', 'Link of Instagram Reels', 'Link of Linkedin Post', 'Link of Tiktok Video', 'Link of Threads Post', 'Blog Link']) {
      expect(pub, `${name} written by publish.py (control)`).toContain(`"${name}"`);
      expect(page, `${name} read by the tab`).toContain(`'${name}'`);
    }
  });
});
