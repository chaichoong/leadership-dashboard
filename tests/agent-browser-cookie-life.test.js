// How long a kept session cookie lasts (7 Oct 2026). Until then persistSessionCookies gave every
// session-only cookie on every allowlisted site ONE HOUR after every robot run, One Login's own
// length: Xero died 1h06m and 57m after Kevin's sign-ins. A cookie now lasts its site's
// `sessionCookieHours` in sites.json, else 24 hours. Runs the real function against a throwaway
// Cookies database with Chrome's column names and a throwaway sites.json; values are never touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'od-cookie-life-'));
// Before the module loads: SITES_FILE is read once, at load.
process.env.AGENT_BROWSER_PROFILE_ROOT = root;
process.env.AGENT_BROWSER_SITES_FILE = join(root, 'sites.json');
writeFileSync(process.env.AGENT_BROWSER_SITES_FILE, JSON.stringify({
  'short.example.test': { label: 'Short', login: true, loginUrl: 'https://short.example.test/login', sessionCookieHours: 1 },
  'long.example.test': { label: 'Long', login: true, loginUrl: 'https://long.example.test/login' },
  'parent.example.test': { label: 'Parent', login: true, loginUrl: 'https://parent.example.test/', sessionCookieHours: 48 },
  'child.parent.example.test': { label: 'Child', login: true, loginUrl: 'https://child.parent.example.test/', sessionCookieHours: 2 },
  'bad.example.test': { label: 'Bad value', login: true, loginUrl: 'https://bad.example.test/', sessionCookieHours: 'soon' },
  // A login site whose cookies sit on its registrable parent (EDF, Amazon, Xero), and a reading-only site that does not.
  'www.shop.test': { label: 'Shop', login: true, loginUrl: 'https://www.shop.test/login', sessionCookieHours: 6 },
  'www.reader.test': { label: 'Reader', login: false },
}));
const b = createRequire(import.meta.url)(join(ROOT, 'scripts', 'agent-browser.js'));

let dir, db;
const q = (sql) => spawnSync('sqlite3', [db, sql], { encoding: 'utf8' }).stdout.trim();
const HOUR = 3600 * 1000;
// Chrome epoch microseconds -> unix ms.
const toUnixMs = (e) => (e / 1000000 - 11644473600) * 1000;

beforeAll(() => {
  dir = join(root, 'profile');
  mkdirSync(join(dir, 'Default'), { recursive: true });
  db = join(dir, 'Default', 'Cookies');
  q(`CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_persistent INTEGER NOT NULL);
     INSERT INTO cookies VALUES ('short.example.test', 'short', 'v1', 0, 0);
     INSERT INTO cookies VALUES ('.long.example.test', 'long', 'v2', 0, 0);
     INSERT INTO cookies VALUES ('ewf.companieshouse.gov.uk', 'ch_session', 'v3', 0, 0);
     INSERT INTO cookies VALUES ('.account.gov.uk', 'di-device-intelligence', 'v4', 0, 0);
     INSERT INTO cookies VALUES ('child.parent.example.test', 'child', 'v5', 0, 0);
     INSERT INTO cookies VALUES ('other.parent.example.test', 'sibling', 'v6', 0, 0);
     INSERT INTO cookies VALUES ('bad.example.test', 'bad', 'v7', 0, 0);
     INSERT INTO cookies VALUES ('.long.example.test', 'kept', 'v8', 13433000000000000, 1);
     INSERT INTO cookies VALUES ('www.example.org', 'stranger', 'v9', 0, 0);
     INSERT INTO cookies VALUES ('.shop.test', 'shop-parent', 'v10', 0, 0);
     INSERT INTO cookies VALUES ('shop.test', 'shop-bare', 'v11', 0, 0);
     INSERT INTO cookies VALUES ('other.shop.test', 'shop-sibling', 'v12', 0, 0);
     INSERT INTO cookies VALUES ('.reader.test', 'reader-parent', 'v13', 0, 0);`);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('persistSessionCookies gives each site its own cookie life', () => {
  it('a day by default, the hours a site entry names, the most specific entry winning, and nothing else touched', () => {
    const before = Date.now();
    const n = b.persistSessionCookies(dir);
    expect(n).toBe(9);
    const rows = Object.fromEntries(q('SELECT name, value, is_persistent, expires_utc FROM cookies').split('\n').map((r) => {
      const [name, value, p, e] = r.split('|');
      return [name, { value, p: Number(p), at: toUnixMs(Number(e)) }];
    }));
    const lasts = (name, hours) => {
      expect(rows[name].p, name).toBe(1);
      expect(Math.abs(rows[name].at - (before + hours * HOUR)), `${name} should last ${hours}h`).toBeLessThan(60000);
    };
    lasts('short', 1);                       // the entry says 1 hour
    lasts('long', 24);                       // no setting: a day, on a sub-domain cookie too
    lasts('ch_session', 24);                 // WebFiling and One Login: a day; their servers end the session sooner
    lasts('di-device-intelligence', 24);     // .account.gov.uk belongs to gov.uk
    lasts('child', 2);                       // its own entry, not the parent's 48
    lasts('sibling', 48);                    // the parent entry's hours
    lasts('bad', 24);                        // an unreadable setting falls back to the default, never to 0
    lasts('shop-parent', 6);                 // the login site's own registrable domain, at the site's hours
    lasts('shop-bare', 6);
    expect(rows['shop-sibling'].p).toBe(0);  // another sub-domain of that parent is another site: untouched
    expect(rows['reader-parent'].p).toBe(0); // a reading-only entry never reaches up to its parent
    expect(rows.kept.at).toBe(toUnixMs(13433000000000000));   // already persistent: untouched
    expect(rows.stranger.p).toBe(0);                          // not on the allowlist: untouched
    // Values are never read or changed.
    expect(['short', 'long', 'ch_session', 'child', 'sibling', 'bad', 'kept', 'stranger'].map((k) => rows[k].value))
      .toEqual(['v1', 'v2', 'v3', 'v5', 'v6', 'v7', 'v8', 'v9']);
  });
  it('the default is a day, and a site entry overrides it', () => {
    expect(b.SESSION_COOKIE_HOURS).toBe(24);
    expect(b.sessionCookieHours({ sessionCookieHours: 6 })).toBe(6);
    expect(b.sessionCookieHours({})).toBe(24);
    expect(b.sessionCookieHours({ sessionCookieHours: 0 })).toBe(24);
  });
});
