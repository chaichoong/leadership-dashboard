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

  it('names WHY each not-moving row is stalled, from the lane the writer carries (15 Sep 2026)', () => {
    // The writer copies loop-health's lane into the payload; the tab renders it.
    expect(read('scripts/estate-status.py')).toMatch(/"lane": s\.get\("lane"\)/);
    expect(page).toMatch(/estateLaneChip\(s\.lane\)/);
    for (const lane of ['withKevin', 'deferred', 'signInNeeded', 'withRoy', 'invisible', 'withAgent']) {
      expect(page, `lane ${lane} has a label`).toMatch(new RegExp(`${lane}:\\s*'[^']+'`));
    }
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

// Kevin, 25 Sep 2026: the Robot sign-ins panel on the AI Agents page. Driven end
// to end on files in a temp folder: the real `agent-browser.js signin-list` and
// `sites` read our own sites file, and the writer reads our own keep-alive,
// ledger and meter logs. Nothing on this Mac is read or written.
describe('the robot-signins row', () => {
  it('reads every source and ranks the newest look, per sign-in, from the real list', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const dir = mkdtempSync(resolve(tmpdir(), 'od-signins-'));
    try {
      const f = (name, body) => { const p = resolve(dir, name); writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body)); return p; };
      const sites = f('sites.json', {
        'my.utilita.co.uk': { label: 'Utilita', login: true, profiles: [
          { profile: 'utilita-apt1', label: 'Flat 1', loginUrl: 'https://my.utilita.co.uk/energy' },
          { profile: 'utilita-apt2', label: 'Flat 2', loginUrl: 'https://my.utilita.co.uk/energy' }] },
        'www.strava.com': { label: 'Strava', login: true },
      });
      const keep = f('status.json', { at: '2026-09-25T06:40:05+01:00', sites: {
        'app.pingen.com': { state: 'signed-in' }, 'www.edfenergy.com': { state: 'signed-out' } } });
      const ledger = f('runs.jsonl', [
        '{"at":"2026-09-25T06:56:28Z","cmd":"session","site":"app.pingen.com","signedIn":false,"profile":"default"}',
        'not json at all',
        '{"at":"2026-09-25T06:59:37Z","cmd":"login","host":"www.edfenergy.com","profile":"default"}',
      ].join('\n'));
      const readings = f('readings.jsonl', [
        '{"at":"2026-09-25T10:05:25","label":"Apartment 1","ok":true,"problem":null}',
        '{"at":"2026-09-25T10:05:25","label":"Apartment 2","ok":false,"problem":"SIGN-IN NEEDED"}',
      ].join('\n'));
      const accounts = f('accounts.json', { accounts: [{ label: 'Apartment 1', profile: 'utilita-apt1' }, { label: 'Apartment 2', profile: 'utilita-apt2' }] });
      const py = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location('es', ${JSON.stringify(WRITER)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.KEEPALIVE_STATUS, m.BROWSER_LEDGER, m.UTILITA_READINGS, m.UTILITA_ACCOUNTS = sys.argv[1:5]
row = m.robot_signins_row(datetime(2026, 9, 25, 10, 10, tzinfo=timezone.utc))
print(json.dumps(row))`;
      const row = JSON.parse(execFileSync('python3', ['-c', py, keep, ledger, readings, accounts],
        { encoding: 'utf8', env: { ...process.env, AGENT_BROWSER_SITES_FILE: sites } }));
      expect(row.status, row.detail).toBe('Worked');
      expect(row.key).toBe('robot-signins');
      const p = JSON.parse(row.payload);
      const by = Object.fromEntries(p.lines.map((l) => [l.label, l]));
      // The builtins come through the real list (control: Pingen and HMRC are builtins).
      expect(by['Pingen (letters)'].state).toBe('signed-out');          // 06:56 robot check beats 06:40 keep-alive
      expect(by['EDF Energy'].state).toBe('you-signed-in');             // his sign-in came after the last look
      expect(by.HMRC.state).toBe('on-demand');
      expect(by['Flat 1']).toMatchObject({ profile: 'utilita-apt1', state: 'signed-in', how: 'hourly read', at: '2026-09-25T09:05:25.000Z' });
      expect(by['Flat 2']).toMatchObject({ profile: 'utilita-apt2', state: 'signed-out' });
      expect(p.lines.some((l) => l.host === 'my.utilita.co.uk' && l.profile === 'default')).toBe(false);
      expect(p.unlisted).toContain('Strava');
      expect(row.detail).toMatch(/signed out \(/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is written every ten minutes with the rest of the board, and on its own after a sign-in', () => {
    const src = read('scripts/estate-status.py');
    const build = src.slice(src.indexOf('def build_rows('), src.indexOf('def cmd_refresh('));
    expect(build).toMatch(/rows\.append\(robot_signins_row\(now\)\)/);
    // The single-row command never goes through upsert(), which would mark every other row "No longer scheduled".
    const one = src.slice(src.indexOf('def cmd_signins('), src.indexOf('def selftest('));
    expect(one).not.toMatch(/upsert\(/);
    expect(read('scripts/robot-signin.applescript')).toMatch(/scripts\/estate-status\.py signins/);
  });
});
