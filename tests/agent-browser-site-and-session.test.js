// Two walls that had no door (19 Nov 2026).
//
// Finding 20261005-agent-dispatch-750: the robot was signed in to Xero, and every read of
// go.xero.com was refused "not on the allowlist" because only login.xero.com was listed, while the
// SITE-wall check called the same address listed and refused the wall. Task recW01dJGmEpNmdpZ sat
// 45 days with neither a read nor a wall. The fix puts the Xero app hosts under the login.xero.com
// entry and gives both paths ONE function to ask.
//
// Finding 20261117-agent-dispatch-1340: the Gas Care portal shows an email box and a "Email me a
// login code" button, with no password input and an ordinary address, so the session check read it
// as signed in and BLOCKER CLEARED was written on rechq1EFCIurfoeaa at 17 Nov 07:31 against a login
// screen. The fix reads the page text: the site's own wording, and a generic sign-in form for a
// portal nobody has annotated.
//
// AGENT_BROWSER_UNDER_TEST points this file at a different copy of the script, which is how the
// pre-change back-test is run (see the fix report).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = process.env.AGENT_BROWSER_UNDER_TEST || join(ROOT, 'scripts', 'agent-browser.js');

// An EMPTY sites.json, set before the script loads: the allowlist under test is the builtin list in
// the code, never whatever this Mac's ~/.config holds. Kevin's own file already carries go.xero.com
// (added by hand on 12 Oct), so a test that read it would pass with the bug still in the code.
const SITES_FILE = join(mkdtempSync(join(tmpdir(), 'ab-sites-')), 'sites.json');
writeFileSync(SITES_FILE, '{}');
process.env.AGENT_BROWSER_SITES_FILE = SITES_FILE;
const b = createRequire(import.meta.url)(SCRIPT);

// The Gas Care portal door as it stood on 17 Nov 2026: an email field, a button, no password box.
const GASCARE_DOOR = [
  'Gas Care Solutions', 'Customer portal',
  'Sign in to view your documents',
  'Email address', 'Email me a login code',
  'We will send you a code to sign in. No password needed.',
].join('\n');
const GASCARE_IN = [
  'Gas Care Solutions', 'Your documents',
  'Landlord Gas Safety Record - 12 Duckworth Street - issued 4 Nov 2026',
  'Download', 'Sign out',
].join('\n');
// A portal nobody has annotated: no signedOutText on its entry, same shape of door.
const UNANNOTATED = { label: 'Some certificate portal', login: true, loginUrl: 'https://portal.example.com/' };
const gascare = () => (b.loadSites() || {})['portal.gascaresolutions.co.uk'];
const walk = (entry, start) => ({ entry, start: start || entry.checkUrl || entry.loginUrl });

describe('finding 750: the Xero app hosts, and one answer for the read path and the SITE wall', () => {
  it('go.xero.com, my.xero.com and central.xero.com are allowed under the login.xero.com entry', () => {
    // The exact read that was refused on task recW01dJGmEpNmdpZ.
    expect(b.hostAllowed('https://go.xero.com/Settings/Subscription')).toBe(true);
    expect(b.hostAllowed('https://my.xero.com/')).toBe(true);
    expect(b.hostAllowed('https://central.xero.com/s/')).toBe(true);
    expect(b.hostAllowed('https://reporting.xero.com/')).toBe(true);
    // Still the one entry, with one sign-in page: not four sites that each ask Kevin to sign in.
    const sites = b.loadSites();
    expect(Object.keys(sites).filter(h => h.endsWith('xero.com'))).toEqual(['login.xero.com']);
    expect(sites['login.xero.com'].loginUrl).toBe('https://login.xero.com/identity/user/login');
    // The door itself is unchanged.
    expect(b.hostAllowed('https://login.xero.com/identity/user/login')).toBe(true);
  });

  it('a host on no entry is still refused', () => {
    expect(b.hostAllowed('https://notxero.example.com/')).toBe(false);
    expect(b.hostAllowed('https://xero.com.evil.example/')).toBe(false);
    // The bare domain was never listed, and an alias host does not widen the list to its parent.
    expect(b.hostAllowed('https://xero.com/')).toBe(false);
    expect(b.hostAllowed('not a web address')).toBe(false);
  });

  it("the SITE-wall check and the read path give the SAME answer for go.xero.com", () => {
    // The divergence WAS the bug: two copies of the rule, one in the read path and one in the wall
    // check. Both go through allowedOwner/hostAllowed now, so they cannot disagree.
    const sites = b.loadSites();
    expect(b.allowedOwner('https://go.xero.com/Settings/Subscription', sites)).toBe('login.xero.com');
    expect(b.allowedOwner('https://go.xero.com/Settings/Subscription', sites) !== '')
      .toBe(b.hostAllowed('https://go.xero.com/Settings/Subscription', sites));
    expect(b.allowedOwner('https://notxero.example.com/', sites)).toBe('');
    // And the command the SITE-wall check calls answers the same, out of process.
    const r = spawnSync(process.execPath, [SCRIPT, 'host-allowed', '--url', 'https://go.xero.com/Settings/Subscription'],
      { encoding: 'utf8', env: { ...process.env, AGENT_BROWSER_SITES_FILE: SITES_FILE } });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.allowed).toBe(true);
    expect(out.owner).toBe('login.xero.com');
    expect(out.entry.loginUrl).toBe('https://login.xero.com/identity/user/login');
  });
});

describe('finding 1340: a sign-in page with no password box is signed OUT', () => {
  it("the Gas Care portal's own door text reads signedIn false", () => {
    const entry = gascare();
    expect(entry && entry.login).toBe(true);
    expect(entry.signedOutText).toContain('Email me a login code');
    const v = b.sessionVerdict('https://portal.gascaresolutions.co.uk/', 0, GASCARE_DOOR,
                               'Gas Care Solutions', walk(entry));
    expect(v.signedIn).toBe(false);
    expect(v.signedOut).toMatch(/Email me a login code|Sign in to view your documents/);
    // It is a real sign-in page, so the Robot sign-in app is right to open it.
    expect(b.onSigninPage('https://portal.gascaresolutions.co.uk/', 0, GASCARE_DOOR,
                          'Gas Care Solutions', walk(entry))).toBe(true);
  });

  it('a genuinely signed-in page on that site still reads true', () => {
    const v = b.sessionVerdict('https://portal.gascaresolutions.co.uk/documents', 0, GASCARE_IN,
                               'Your documents', walk(gascare()));
    expect(v.signedIn).toBe(true);
    expect(v.signedOut).toBe(undefined);
  });

  it('a site with no signed-out marker configured still fails safe on the form text', () => {
    const v = b.sessionVerdict('https://portal.example.com/', 0, GASCARE_DOOR, 'Portal', walk(UNANNOTATED));
    expect(v.signedIn).toBe(false);
    expect(v.signedOut).toMatch(/sign-in form/);
    // With no entry at all either: the generic shape is enough.
    expect(b.sessionVerdict('https://portal.example.com/', 0, 'Enter the login code we emailed you').signedIn).toBe(false);
    expect(b.sessionVerdict('https://portal.example.com/', 0, 'Send me a sign-in link').signedIn).toBe(false);
    // And an ordinary signed-in page is untouched.
    expect(b.sessionVerdict('https://portal.example.com/documents', 0, GASCARE_IN, 'Your documents').signedIn).toBe(true);
  });

  it('login closing with the form still showing does not report the wall cleared', () => {
    const entry = gascare();
    const stillOut = b.sessionVerdict('https://portal.gascaresolutions.co.uk/', 0, GASCARE_DOOR,
                                      'Gas Care Solutions', walk(entry));
    const out = b.loginOutcome(stillOut);
    expect(out.signedIn).toBe(false);
    expect(out.stillSignedOut).toBeTruthy();
    // A sign-in that DID complete says so, with nothing to hold the wall up.
    const done = b.loginOutcome(b.sessionVerdict('https://portal.gascaresolutions.co.uk/documents', 0,
                                                 GASCARE_IN, 'Your documents', walk(entry)));
    expect(done).toEqual({ signedIn: true });
    // A read that could not run claims nothing either way.
    expect(b.loginOutcome(null)).toEqual({});
  });
});
