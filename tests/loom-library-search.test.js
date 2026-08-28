import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = resolve(ROOT, 'scripts/agent-browser.js');
const SRC = readFileSync(BROWSER, 'utf8');
const mod = createRequire(import.meta.url)(BROWSER);

// ── SEARCHING KEVIN'S LOOM LIBRARY (29 Aug 2026) ───────────────────────────
//
// He asked for Claude to be connected to his video archive. There is no Loom
// MCP — the registry returns nothing, and Atlassian's own MCP covers Jira and
// Confluence, not Loom, despite owning it. An MCP would not have helped anyway:
// agents reach 0 of 21 connectors from a scheduled run.
//
// So the route is the agent browser, which already runs against a profile he
// signs into by hand.
//
// TWO DIFFERENT THINGS, and keeping them apart is the design:
//   * ONE VIDEO's transcript comes from a PUBLIC GraphQL endpoint. No login, no
//     allowlist entry. That is what approval feedback uses.
//   * THE LIBRARY is his account, so it needs the session and the one-time
//     human sign-in.

describe('loom.com is on the allowlist, as a login site', () => {
  it('the library is reachable', () => {
    expect(mod.hostAllowed('https://www.loom.com/looms/videos')).toBe(true);
    expect(mod.hostAllowed('https://loom.com/share/abc')).toBe(true);
  });

  it('is marked as needing Kevin’s session', () => {
    // login:false would say "this needs no account", which is true of a single
    // shared video and false of his library.
    expect(SRC).toMatch(/'loom\.com':\s*\{ label: '[^']*',\s*login: true/);
  });

  it('does not open the door to the rest of the web', () => {
    // The allowlist is the whole safety of a browser holding live sessions.
    expect(mod.hostAllowed('https://loom.com.evil.example')).toBe(false);
    expect(mod.hostAllowed('https://notloom.com/share/abc')).toBe(false);
    expect(mod.hostAllowed('https://example.com')).toBe(false);
  });
});

describe('the search itself', () => {
  it('exists and is documented in the usage', () => {
    expect(SRC).toMatch(/cmd === 'loom-search'/);
    expect(SRC).toMatch(/agent-browser\.js loom-search --query/);
  });

  it('refuses without a query rather than listing the whole library', () => {
    expect(SRC).toMatch(/if \(!query\) die\('--query is required'\)/);
  });

  it('returns share URLs, so a transcript can then be pulled', () => {
    // The two halves join here: the search gives the id, the public endpoint
    // gives what he actually said in it.
    expect(SRC).toMatch(/https:\/\/www\.loom\.com\/share\/' \+ m\[1\]/);
    expect(SRC).toMatch(/\[0-9a-f\]\{32\}/);
  });

  it('waits for the client-rendered list instead of racing it', () => {
    // Loom renders the library after load. A fixed sleep would be a race, and
    // a race here reads as "no videos" — the same shape as a real empty result.
    expect(SRC).toMatch(/waitForSelector\('a\[href\*="\/share\/"\]'/);
  });

  it('is READ-ONLY — it navigates and reads, nothing else', () => {
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).toMatch(/page\.goto/);
    expect(fn).not.toMatch(/page\.click|page\.fill|setInputFiles|page\.press/);
  });
});

describe('not signed in must never look like an empty library', () => {
  // The failure that would waste Kevin's time: an agent reports "nothing in
  // your Loom about that" when the truth is the session expired. One is an
  // answer, the other is a broken tool, and they are indistinguishable unless
  // the code says which.
  it('detects the signed-out page', () => {
    expect(SRC).toMatch(/signedOut/);
    expect(SRC).toMatch(/log \?in\|sign \?in/);
  });

  it('says so explicitly, and gives the exact one-time command', () => {
    expect(SRC).toMatch(/NOT SIGNED IN to Loom/);
    expect(SRC).toMatch(/agent-browser\.js login --url https:\/\/www\.loom\.com/);
  });

  it('makes clear no password ever reaches an agent', () => {
    expect(SRC).toMatch(/no password ever reaches an agent/);
  });

  it('records the failed attempt in the ledger like any other run', () => {
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).toMatch(/ledger\(\{ cmd: 'loom-search'[^}]*error: 'not signed in'/);
  });
});
