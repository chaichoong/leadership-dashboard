// The browser lane must present itself as a person's browser (2 Sep 2026).
//
// Evernote's login refused Kevin's own valid credentials in Playwright's
// bundled Chromium (navigator.webdriver = true, "controlled by automated test
// software" banner) while the same credentials worked in his real Chrome.
// withPage() now launches the installed Google Chrome with the automation
// switch off and hides the webdriver flag, falling back to the bundled build
// when Chrome is absent so unattended runs never die on a missing app.
//
// withPage is not exported, so this reads the source: the three properties
// that matter must all be present, and the fallback must stay conditional.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'scripts', 'agent-browser.js'), 'utf8');
const withPage = src.slice(src.indexOf('async function withPage'), src.indexOf('async function withPage') + 2500);

describe('agent-browser launches like a real browser', () => {
  it('prefers the installed Google Chrome, guarded by an existence check', () => {
    expect(withPage).toMatch(/existsSync\('\/Applications\/Google Chrome\.app'\)/);
    expect(withPage).toMatch(/channel = 'chrome'/);
  });
  it('turns the automation switch off', () => {
    expect(withPage).toMatch(/ignoreDefaultArgs = \['--enable-automation'\]/);
  });
  it('hides navigator.webdriver on every page', () => {
    expect(withPage).toMatch(/addInitScript/);
    expect(withPage).toMatch(/navigator, 'webdriver'/);
  });
  it('keeps the bundled build as the fallback (channel is not unconditional)', () => {
    const launchBlock = withPage.slice(withPage.indexOf('const launch = {'), withPage.indexOf('launchPersistentContext'));
    expect(launchBlock).toMatch(/if \(fs\.existsSync/);
    expect(launchBlock).not.toMatch(/const launch = \{[^}]*channel/s);
  });
});
