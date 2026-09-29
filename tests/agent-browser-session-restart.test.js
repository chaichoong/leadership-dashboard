// A session cookie a site sets during the ROBOT's own browser step must survive
// the robot's next launch (29 Sep 2026). Chrome deletes session-only cookies at
// startup; Kevin's sign-in window gave them an hour, the robot's runs did not.
// WebFiling was signed in on the pickup's first two looks after Kevin's 00:30
// sign-in, a cookie was rewritten during the second, and the third look, three
// minutes later, was signed out. Drives the real withPage twice on a throwaway
// profile folder with real headless Chrome; no network, no real robot profile.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'od-browser-restart-'));
// Before the module loads: PROFILE_ROOT and SITES_FILE are read once, at load.
process.env.AGENT_BROWSER_PROFILE_ROOT = root;
process.env.AGENT_BROWSER_SITES_FILE = join(root, 'no-sites.json');   // builtins only
const b = createRequire(import.meta.url)(join(ROOT, 'scripts', 'agent-browser.js'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the robot keeps a session across its own browser restarts', () => {
  it('a session-only cookie on an allowlisted site outlives the next launch; one elsewhere does not', async () => {
    await b.withPage('restart-test', false, async (page, ctx) => {
      // No expires: session-only, exactly what WebFiling sets.
      await ctx.addCookies([
        { name: 'ch_session', value: 'kept', domain: 'ewf.companieshouse.gov.uk', path: '/' },
        { name: 'sid', value: 'dropped', domain: 'www.example.org', path: '/' },
      ]);
    });
    // The count the fallback `login` logs (review, 29 Sep 2026: it re-counted after withPage and logged 0).
    expect(b.lastKeptCount()).toBe(1);
    const names = await b.withPage('restart-test', false, async (page, ctx) =>
      (await ctx.cookies(['https://ewf.companieshouse.gov.uk/', 'https://www.example.org/'])).map(c => `${c.domain} ${c.name}`));
    expect(names).toContain('ewf.companieshouse.gov.uk ch_session');
    expect(names).not.toContain('www.example.org sid');   // not on the allowlist: Chrome's own rule stands
  }, 60000);
  // Review, 29 Sep 2026: a refusal mid-step called process.exit, which skipped withPage's finally,
  // and Playwright then killed Chrome before it wrote the cookies. From the command line, a
  // refused step must now unwind through the page: the failure screenshot proves it did (the
  // old exit never reached it), and the refusal still prints with its exit code.
  it('a refusal inside a step still closes the browser cleanly and exits 1 with the refusal', () => {
    const { writeFileSync } = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const plan = join(root, 'plan.json');
    writeFileSync(plan, JSON.stringify({ steps: [{ do: 'no-such-step' }] }));   // refused inside the open page
    const r = spawnSync('node', [join(ROOT, 'scripts', 'agent-browser.js'), 'prepare', '--profile', 'refusal-test',
      '--plan', plan, '--shot', join(root, 'shot.png')], { encoding: 'utf8', env: process.env, timeout: 60000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^BROWSER REFUSED: unknown step "no-such-step" Failure screenshot: /m);
    expect(r.stderr).not.toMatch(/BROWSER ERROR/);
  }, 60000);
});
