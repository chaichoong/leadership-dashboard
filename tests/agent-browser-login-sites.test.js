// The Robot sign-in app lists every allowlisted site that holds Kevin's login
// and knows where its sign-in page is (4 Sep 2026). A login site without a
// loginUrl is invisible to the picker, and the hand-back line agents use
// ("SIGN-IN NEEDED: <site>") then has no tap behind it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { loadSites } = require_(join(ROOT, 'scripts', 'agent-browser.js'));

describe('login sites on the allowlist', () => {
  const sites = loadSites();
  it.each(['app.pingen.com', 'dashboard.stripe.com', 'manage.gocardless.com', 'studio.youtube.com',
           'www.linkedin.com', 'my.edfenergy.com', 'ewf.companieshouse.gov.uk', 'acrobat.adobe.com'])
    ('%s is a login site with a sign-in URL on its own host family', (host) => {
      expect(sites[host] && sites[host].login).toBe(true);
      const u = new URL(sites[host].loginUrl);
      const family = host.split('.').slice(-2).join('.');
      expect(u.hostname.endsWith(family)).toBe(true);
    });
  it('no bank or credit file is held in the robot profile without Kevin deciding so', () => {
    for (const h of Object.keys(sites)) expect(h).not.toMatch(/starling|americanexpress|hl\.co\.uk|equifax/);
  });
});

describe('loadSites merges sites.json per host', () => {
  it('a sites.json entry written by `login` does not erase the builtin loginUrl', () => {
    // Hermetic: our own sites file, not whatever ~/.config holds on this Mac.
    const { mkdtempSync, writeFileSync, rmSync } = require_('node:fs');
    const { tmpdir } = require_('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'od-sites-'));
    const file = join(dir, 'sites.json');
    writeFileSync(file, JSON.stringify({ 'acrobat.adobe.com': { label: 'Adobe Acrobat Sign', login: true } }));
    const modPath = join(ROOT, 'scripts', 'agent-browser.js');
    const prev = process.env.AGENT_BROWSER_SITES_FILE;
    process.env.AGENT_BROWSER_SITES_FILE = file;
    delete require_.cache[require_.resolve(modPath)];
    try {
      const fresh = require_(modPath).loadSites();
      expect(fresh['acrobat.adobe.com'].login).toBe(true);
      expect(fresh['acrobat.adobe.com'].loginUrl).toMatch(/^https:\/\/acrobat\.adobe\.com\//);
    } finally {
      if (prev === undefined) delete process.env.AGENT_BROWSER_SITES_FILE; else process.env.AGENT_BROWSER_SITES_FILE = prev;
      delete require_.cache[require_.resolve(modPath)];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
