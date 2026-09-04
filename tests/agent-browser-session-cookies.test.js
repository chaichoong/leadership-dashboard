// `login` must keep session-only cookies alive across the browser restart
// (4 Sep 2026). Chrome deletes them at startup, and GOV.UK One Login binds a
// sign-in to two of them, so Kevin's three sign-ins in the plain window all
// reached the agent launch as "please sign in". Runs the real function against
// a throwaway Cookies database with Chrome's column names.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { persistSessionCookies } = require_(join(ROOT, 'scripts', 'agent-browser.js'));

let dir, db;
const q = (sql) => spawnSync('sqlite3', [db, sql], { encoding: 'utf8' }).stdout.trim();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'od-cookies-'));
  mkdirSync(join(dir, 'Default'));
  db = join(dir, 'Default', 'Cookies');
  q(`CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_persistent INTEGER NOT NULL);
     INSERT INTO cookies VALUES ('.account.gov.uk', 'di-device-intelligence', 0, 0);
     INSERT INTO cookies VALUES ('ewf.companieshouse.gov.uk', 'ch_session', 0, 0);
     INSERT INTO cookies VALUES ('.account.gov.uk', 'gs', 13433000000000000, 1);
     INSERT INTO cookies VALUES ('www.example.org', 'sid', 0, 0);`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('persistSessionCookies', () => {
  it('gives session-only cookies on allowlisted hosts a one-hour expiry and leaves everything else alone', () => {
    const before = Date.now();
    const n = persistSessionCookies(dir, 60 * 60 * 1000);
    expect(n).toBe(2);
    const rows = q(`SELECT host_key, name, is_persistent, expires_utc FROM cookies ORDER BY name`).split('\n');
    const byName = Object.fromEntries(rows.map(r => { const [h, name, p, e] = r.split('|'); return [name, { h, p: Number(p), e: Number(e) }]; }));
    expect(byName['ch_session'].p).toBe(1);
    expect(byName['di-device-intelligence'].p).toBe(1);
    // Chrome epoch microseconds -> unix ms, within a minute of now + 1h
    const toUnixMs = (e) => (e / 1000000 - 11644473600) * 1000;
    expect(Math.abs(toUnixMs(byName['ch_session'].e) - (before + 3600000))).toBeLessThan(60000);
    expect(byName['gs'].e).toBe(13433000000000000);   // already persistent: untouched
    expect(byName['sid'].p).toBe(0);                   // not on the allowlist: untouched
  });
  it('returns 0 when the profile has no cookie database yet', () => {
    expect(persistSessionCookies(join(dir, 'nowhere'))).toBe(0);
  });
});
