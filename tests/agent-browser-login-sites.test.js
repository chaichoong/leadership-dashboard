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
           'www.linkedin.com', 'www.edfenergy.com', 'ewf.companieshouse.gov.uk', 'acrobat.adobe.com'])
    ('%s is a login site with a sign-in URL on its own host family', (host) => {
      expect(sites[host] && sites[host].login).toBe(true);
      const u = new URL(sites[host].loginUrl);
      const family = host.split('.').slice(-2).join('.');
      expect(u.hostname.endsWith(family)).toBe(true);
    });
  // Kevin PERMITTED American Express on 18 Sep 2026, so both of its hosts are
  // named here rather than deleted from the pattern: the guard still has to say out
  // loud which bank or credit site is allowed and who allowed it. A site that
  // is simply dropped from the list below reads identically to one nobody ever
  // considered, and that is the state this test exists to prevent. Anything not
  // on PERMITTED still fails.
  const PERMITTED = new Set([                                  // Kevin, 18 Sep 2026
    'global.americanexpress.com',
    'www.americanexpress.com',
  ]);
  it('no bank or credit file is held in the robot profile without Kevin deciding so', () => {
    for (const h of Object.keys(sites)) {
      if (PERMITTED.has(h)) continue;
      expect(h).not.toMatch(/starling|americanexpress|hl\.co\.uk|equifax/);
    }
  });
  it('every permitted bank or credit site is actually in the profile', () => {
    // A permission left behind after the site is removed would silently widen
    // the guard for the next site that matches the pattern.
    for (const h of PERMITTED) expect(Object.keys(sites)).toContain(h);
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

// 21 Sep 2026: the content engine reads the Runpreneur podcast's public show page for each episode's link.
describe('the public Spotify show page', () => {
  const { pickLinks, hostAllowed } = require_(join(ROOT, 'scripts', 'agent-browser.js'));
  it('is allowed, and holds no login', () => {
    expect(hostAllowed('https://open.spotify.com/show/6hL5SLvsU1VDMHVaWZZ3tO')).toBe(true);
    expect(loadSites()['open.spotify.com'].login).toBe(false);
  });
  it('read --links returns each matching link once, with its words, and nothing else', () => {
    const got = pickLinks([
      { href: 'https://open.spotify.com/episode/5XRmBZhlJptMDKnyW1tRNi', text: '  Episode 2064 - Regaining Fitness  ' },
      { href: 'https://open.spotify.com/episode/5XRmBZhlJptMDKnyW1tRNi', text: 'play button' },
      { href: 'https://open.spotify.com/show/6hL5SLvsU1VDMHVaWZZ3tO', text: 'Runpreneur' },
      { href: null, text: 'broken' },
    ], '/episode/');
    expect(got).toEqual([{ href: 'https://open.spotify.com/episode/5XRmBZhlJptMDKnyW1tRNi', text: 'Episode 2064 - Regaining Fitness' }]);
    expect(pickLinks([{ href: 'https://x/episode/a', text: 'a' }], '')).toEqual([]);
    expect(pickLinks([{ href: 'https://x/episode/a', text: ' ' }, { href: 'https://x/episode/a', text: 'Episode 2064 - T' }], '/episode/'))
      .toEqual([{ href: 'https://x/episode/a', text: 'Episode 2064 - T' }]);   // review: a wordless cover link ahead of the title
    expect(pickLinks([...Array(9)].map((_, i) => ({ href: `https://x/episode/${i}`, text: String(i) })), '/episode/', 3)).toHaveLength(3);
  });
});

// 25 Sep 2026. Kevin asked how to add a site for the robots and how to sign the two Duckworth
// Utilita flats back in. Two gaps answered here: `login` wrote a new site with no sign-in page,
// so it never showed in the Robot sign-in app again; and the app only knew the main profile,
// so it could not open either flat, each of which is a separate Utilita login in its own profile.
describe('signin-list and login: every sign-in the Robot sign-in app can open', () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } = require_('node:fs');
  const { tmpdir } = require_('node:os');
  const { execFileSync, spawnSync } = require_('node:child_process');
  const modPath = join(ROOT, 'scripts', 'agent-browser.js');

  // Hermetic: our own sites file, never the one on this Mac.
  function withSites(content, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'od-signin-list-'));
    const file = join(dir, 'sites.json');
    if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    const prev = process.env.AGENT_BROWSER_SITES_FILE;
    process.env.AGENT_BROWSER_SITES_FILE = file;
    delete require_.cache[require_.resolve(modPath)];
    try { return fn(require_(modPath), file); } finally {
      if (prev === undefined) delete process.env.AGENT_BROWSER_SITES_FILE; else process.env.AGENT_BROWSER_SITES_FILE = prev;
      delete require_.cache[require_.resolve(modPath)];
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const FLATS = {
    'my.utilita.co.uk': { label: 'Utilita (Duckworth PAYG)', login: true, profiles: [
      { profile: 'utilita-apt1', label: 'Utilita Apartment 1', loginUrl: 'https://my.utilita.co.uk/energy' },
      { profile: 'utilita-apt2', label: 'Utilita Apartment 2', loginUrl: 'https://my.utilita.co.uk/energy' },
    ] },
  };

  it('lists one line per flat on its own profile, and never a main-profile line for Utilita (driven)', () => {
    withSites({ ...FLATS, 'www.topcashback.co.uk': { label: 'TopCashback', login: true } }, (_m, file) => {
      const out = execFileSync('node', [modPath, 'signin-list'],
        { encoding: 'utf8', env: { ...process.env, AGENT_BROWSER_SITES_FILE: file } }).trim().split('\n');
      expect(out).toContain('Utilita Apartment 1 | my.utilita.co.uk | https://my.utilita.co.uk/energy | utilita-apt1');
      expect(out).toContain('Utilita Apartment 2 | my.utilita.co.uk | https://my.utilita.co.uk/energy | utilita-apt2');
      // The keep-alive tests a top-level loginUrl on the MAIN profile, so Utilita must have none.
      expect(out.filter(l => l.includes('my.utilita.co.uk | ') && l.endsWith('| default'))).toEqual([]);
      // Builtins still come through on the main profile; a login site with no page cannot be opened.
      expect(out).toContain('Pingen (letters) | app.pingen.com | https://app.pingen.com/ | default');
      expect(out.some(l => l.includes('topcashback'))).toBe(false);
      for (const l of out) expect(l.split(' | ')).toHaveLength(4);
    });
  });

  it('an unusable profile entry is reported by name, never dropped in silence', () => {
    withSites({ 'my.utilita.co.uk': { label: 'U', login: true, profiles: [
      { profile: '../escape', loginUrl: 'https://my.utilita.co.uk/energy' },
      { profile: 'elsewhere', loginUrl: 'https://evil.example.com/login' },
      { profile: 'nopage' },
      { profile: 'fine', label: 'A | B', loginUrl: 'https://my.utilita.co.uk/energy' },
    ] } }, (m, file) => {
      const problems = [];
      const got = m.signinTargets(m.loadSites(), problems).filter(t => t.host === 'my.utilita.co.uk');
      expect(got).toEqual([{ label: 'A - B', host: 'my.utilita.co.uk', url: 'https://my.utilita.co.uk/energy', profile: 'fine' }]);
      expect(problems).toHaveLength(3);
      expect(problems.join('\n')).toMatch(/\.\.\/escape/);
      expect(problems.join('\n')).toMatch(/elsewhere/);
      expect(problems.join('\n')).toMatch(/nopage/);
      const r = spawnSync('node', [modPath, 'signin-list'], { encoding: 'utf8', env: { ...process.env, AGENT_BROWSER_SITES_FILE: file } });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/SKIPPED: my\.utilita\.co\.uk: profile elsewhere/);
    });
  });

  it('a new site signed in on the main profile keeps its sign-in page, so the app lists it next time', () => {
    withSites({ 'www.topcashback.co.uk': { label: 'TopCashback', login: true } }, (m, file) => {
      expect(m.recordLoginSite('https://portal.example.co.uk/login', { label: 'Example portal' }))
        .toEqual({ host: 'portal.example.co.uk', changed: true });
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved['portal.example.co.uk']).toEqual({ label: 'Example portal', login: true, loginUrl: 'https://portal.example.co.uk/login' });
      // Only what the file held plus the new entry: the builtins are never copied in, where
      // the copies used to outrank every later change to a builtin.
      expect(Object.keys(saved).sort()).toEqual(['portal.example.co.uk', 'www.topcashback.co.uk']);
      expect(m.signinTargets().map(t => t.host)).toContain('portal.example.co.uk');
      // A site already on the list with no page gets its page, and keeps its own name.
      m.recordLoginSite('https://www.topcashback.co.uk/account', { label: 'ignored' });
      expect(JSON.parse(readFileSync(file, 'utf8'))['www.topcashback.co.uk'])
        .toEqual({ label: 'TopCashback', login: true, loginUrl: 'https://www.topcashback.co.uk/account' });
    });
  });

  it('a sign-in on a flat\'s own profile never gives the site a main-profile page', () => {
    withSites(FLATS, (m, file) => {
      const before = statSync(file).mtimeMs;
      expect(m.recordLoginSite('https://my.utilita.co.uk/energy', { profile: 'utilita-apt1' }).changed).toBe(false);
      expect(statSync(file).mtimeMs).toBe(before);
      // Even on the main profile: the entry has flats, so its page stays theirs.
      expect(m.recordLoginSite('https://my.utilita.co.uk/energy', {}).changed).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8'))['my.utilita.co.uk'].loginUrl).toBeUndefined();
      // A brand-new site on its own profile joins the allowlist without a main-profile page.
      m.recordLoginSite('https://app.newthing.co.uk/', { profile: 'newthing', label: 'New thing' });
      expect(JSON.parse(readFileSync(file, 'utf8'))['app.newthing.co.uk']).toEqual({ label: 'New thing', login: true });
    });
  });

  it('a site that already has its page is left alone, and nothing but https is ever recorded', () => {
    withSites({}, (m, file) => {
      expect(m.recordLoginSite('https://app.pingen.com/', {}).changed).toBe(false);
      expect(() => m.recordLoginSite('http://plain.example.com/login', {})).toThrow(/not an https address/);
      expect(() => m.recordLoginSite('not a url', {})).toThrow(/not a web address/);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({});
    });
  });

  it('a sites file that will not parse is refused, never rewritten from one entry', () => {
    withSites('{ "www.loom.com": { "label": "Loom", ', (m, file) => {
      expect(() => m.recordLoginSite('https://portal.example.co.uk/login', {})).toThrow();
      expect(readFileSync(file, 'utf8')).toBe('{ "www.loom.com": { "label": "Loom", ');
    });
    // A missing file is a first run: the site is written.
    withSites(undefined, (m, file) => {
      m.recordLoginSite('https://portal.example.co.uk/login', {});
      expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['portal.example.co.uk']);
    });
  });
});
