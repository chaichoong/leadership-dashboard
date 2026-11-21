// The developer.ebay.com session check judges the ACCOUNT page, not the marketing one
// (approved build recDPkv36UXe8QDD9, finding 20261116-agent-dispatch-1331).
//
// 13, 16, 17 and 18 Nov 2026: `session --site developer.ebay.com` answered signedIn TRUE off the
// public home page, whose own text shows "Join" and no account name, while a read of
// developer.ebay.com/my/keys at the same moment redirected to /signin with a password box. Kevin
// tapped Sign in six times for nothing, and the 14 Nov keep-alive cleared a SIGN-IN wall on the
// strength of that false true. The cause is in the shape of the check: every test asked "is this a
// door?", so a page that is neither a door nor the account read as signed in.
//
// The fix is proof: the entry carries `signedInText`, and the verdict is signed in only when the
// page shows it. Back-test: on the code before this build the home-page case below reads
// signedIn true, which is the bug.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Only the entries this REPO ships: the private sites.json on the Mac mini carries its own
// developer.ebay.com row (label and loginUrl), and a test that read it would pass or fail on what
// happens to be on one machine. The repo is where the need belongs, so the repo is what is tested.
const empty = join(mkdtempSync(join(tmpdir(), 'sites-')), 'sites.json');
writeFileSync(empty, '{}');
process.env.AGENT_BROWSER_SITES_FILE = empty;
const b = require_(join(ROOT, 'scripts', 'agent-browser.js'));

const sites = b.loadSites();
const EBAY = sites['developer.ebay.com'];
const walk = (entry, start) => ({ entry, start: start || entry.checkUrl || entry.loginUrl });

// The first words of each page, as the robot read them. Trimmed, their own wording.
const HOME = 'eBay Developers Program Join Sign in Build with eBay APIs Get started Pricing Support '
  + 'Buy APIs Sell APIs Commerce APIs Developer tools Documentation';
const KEYS_PAGE = 'eBay Developers Program My Account Hi, brittain Application Keys '
  + 'Sandbox Production Brittain listings App ID (Client ID) Cert ID (Client Secret) Rotate (Reset) Cert ID';
// 20000 characters of header, nav and cookie notice before the account is named: the window the
// proof is looked for in has to be wider than the door window, and this is the test of that.
const KEYS_BURIED = 'eBay Developers Program '.repeat(300) + 'Application Keys Production';

describe('the entry says where to look', () => {
  it('developer.ebay.com is a login site whose check begins on the keys page, not the home page', () => {
    expect(EBAY && EBAY.login).toBe(true);
    expect(EBAY.checkUrl).toBe('https://developer.ebay.com/my/keys');
    expect(new URL(EBAY.loginUrl).hostname).toBe('developer.ebay.com');
    expect(EBAY.login).toBe(true);                     // so the keep-alive and the sign-in app see it
    expect(EBAY.signedInText).toContain('Application Keys');
  });
});

describe('the verdict on each page the robot really landed on', () => {
  it('the public home page is NOT signed in, and says what it looked for', () => {
    const v = b.sessionVerdict('https://developer.ebay.com/', 0, HOME, 'eBay Developers Program', walk(EBAY));
    expect(v.signedIn).toBe(false);
    expect(v.unproven).toContain('Application Keys');
    // It is not a door, so nothing records a sign-in as having happened on it.
    expect(v.atDoor).toBe(false);
    expect(b.onSigninPage('https://developer.ebay.com/', 0, HOME, '', walk(EBAY))).toBe(false);
  });

  it('the keys page with the account on it IS signed in', () => {
    const v = b.sessionVerdict('https://developer.ebay.com/my/keys', 0, KEYS_PAGE, 'Application Keys', walk(EBAY));
    expect(v.signedIn).toBe(true);
    expect(v.unproven).toBeUndefined();
  });

  it('the proof is found below the header, the nav and the cookie notice', () => {
    expect(KEYS_BURIED.indexOf('Application Keys')).toBeGreaterThan(2000);   // past the door window
    expect(KEYS_BURIED.length).toBeLessThanOrEqual(b.PROOF_TEXT_WINDOW);     // inside the proof window
    expect(b.sessionVerdict('https://developer.ebay.com/my/keys', 0, KEYS_BURIED, '', walk(EBAY)).signedIn).toBe(true);
  });

  it('the /signin redirect is signed out and IS the sign-in page, so the tap has somewhere to go', () => {
    const url = 'https://developer.ebay.com/signin?return_to=%2Fmy%2Fkeys';
    const v = b.sessionVerdict(url, 1, 'Sign in to your eBay account Password', 'Sign in', walk(EBAY));
    expect(v.signedIn).toBe(false);
    expect(v.atDoor).toBe(true);
    expect(b.onSigninPage(url, 1, 'Sign in to your eBay account Password', 'Sign in', walk(EBAY))).toBe(true);
  });

  it('a bot check is still a bot check, never "the page did not show the account"', () => {
    const v = b.sessionVerdict('https://developer.ebay.com/my/keys', 0,
      'Checking if the site connection is secure', 'Just a moment...', walk(EBAY));
    expect(v.botCheck).toBe(true);
    expect(v.signedIn).toBe(false);
    expect(v.unproven).toBeUndefined();          // a sign-in would not clear it, so it is not named as unproven
  });
});

describe('the control: a site that asks for no proof is unchanged', () => {
  it('an ordinary signed-in landing with no signedInText still reads signed in', () => {
    const plain = { label: 'Xero', login: true, loginUrl: 'https://login.xero.com/identity/user/login' };
    expect(b.sessionVerdict('https://go.xero.com/Dashboard', 0, 'Dashboard Business Accounting', '', walk(plain)).signedIn).toBe(true);
    expect(b.signedInProof(plain, 'anything at all')).toBe('');
    expect(b.signedInProof(undefined, '')).toBe('');
  });

  it('every login site that asks for proof also says where to look for it', () => {
    for (const [host, e] of Object.entries(sites)) {
      if (!Array.isArray(e.signedInText) || !e.signedInText.length) continue;
      expect(e.checkUrl || e.loginUrl, `${host} asks for proof but has no page to read it on`).toBeTruthy();
    }
  });
});
