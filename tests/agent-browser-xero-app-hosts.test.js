// Finding 20261005-agent-dispatch-750: the robot was signed in to Xero and still refused its own
// Settings page. hostAllowed matches a host or a SUFFIX of one, and the list held only the sign-in
// door login.xero.com, so go.xero.com (where every signed-in page lives) matched nothing. The task
// that needed the subscription page waited 50 days behind a SITE wall nobody could add a site for.
//
// HERMETIC on purpose: it points AGENT_BROWSER_SITES_FILE at an empty file, so what it reads is the
// BUILTIN list in the repo and never whatever ~/.config/od holds on the Mac it runs on. The first
// draft of this test read the live profile and passed on two thirds of its cases without the fix,
// because a host Kevin had added by hand was already there — a test that reads the machine's own
// state cannot say whether the code is right.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOD = join(ROOT, 'scripts', 'agent-browser.js');
const { mkdtempSync, writeFileSync, rmSync } = require_('node:fs');
const { tmpdir } = require_('node:os');

let dir, prev, browser;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'od-xero-sites-'));
  writeFileSync(join(dir, 'sites.json'), '{}');
  prev = process.env.AGENT_BROWSER_SITES_FILE;
  process.env.AGENT_BROWSER_SITES_FILE = join(dir, 'sites.json');
  delete require_.cache[require_.resolve(MOD)];
  browser = require_(MOD);
});
afterAll(() => {
  if (prev === undefined) delete process.env.AGENT_BROWSER_SITES_FILE;
  else process.env.AGENT_BROWSER_SITES_FILE = prev;
  delete require_.cache[require_.resolve(MOD)];
  rmSync(dir, { recursive: true, force: true });
});

describe('the Xero pages a signed-in robot actually lands on are on the allowlist', () => {
  it.each([
    'https://go.xero.com/app',
    'https://go.xero.com/Settings/Subscription',
    'https://my.xero.com/',
    'https://central.xero.com/s/',
  ])('%s is allowed', (url) => {
    expect(browser.hostAllowed(url)).toBe(true);
  });

  it.each(['go.xero.com', 'my.xero.com', 'central.xero.com'])(
    '%s carries the same sign-in page as the door, so a SITE wall on it can clear', (host) => {
      const sites = browser.loadSites();
      expect(sites[host] && sites[host].login).toBe(true);
      // site_reachable (agent-dispatch.py) only counts a login entry that has a page to open.
      expect(sites[host].loginUrl).toBe(sites['login.xero.com'].loginUrl);
    });

  it('a different Xero host nobody decided on is still refused', () => {
    // The fix is three named hosts, never a wildcard on xero.com.
    expect(browser.hostAllowed('https://apps.xero.com/')).toBe(false);
  });
});
