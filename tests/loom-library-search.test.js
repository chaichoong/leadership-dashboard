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

  it('does NOT use ?search= in the URL', () => {
    // Attempt one. Loom ignores it: two unrelated queries returned
    // byte-identical ids. "Here are your matches" that is really "here are
    // your newest videos" is worse than an error, because it reads as an
    // answer.
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).not.toMatch(/\?search=/);
  });

  it('does NOT scrape the library grid', () => {
    // Attempt two. Typing DOES search, but results render in a typeahead
    // listbox with no links and no video id in the DOM, while the grid behind
    // never changes — so scraping the page reproduces attempt one's bug.
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).not.toMatch(/querySelectorAll\('a\[href\*="\/share\/"\]'\)[\s\S]{0,200}aria-label/);
  });

  it('reads the search RESPONSE, which is the only place the ids exist', () => {
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).toMatch(/page\.on\('response'/);
    expect(fn).toMatch(/videos\?\.videoResults\?\.nodes|data\?\.videos/);
  });

  it('reports whether the hit was in the TRANSCRIPT or just the title', () => {
    // The reason this is worth having: Loom indexes what Kevin SAID, so a
    // video whose title never mentions the subject still surfaces.
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).toMatch(/matchedTranscript/);
    expect(fn).toMatch(/transcriptText/);
  });

  it('returns share URLs, so a transcript can then be pulled', () => {
    // The two halves join on the id: the search needs Kevin's session, the
    // transcript does not.
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).toMatch(/sharePageUri/);
  });

  it('is READ-ONLY apart from typing the query itself', () => {
    const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                         SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));
    expect(fn).not.toMatch(/setInputFiles|page\.selectOption/);
    // The only writes are into the search box.
    expect(fn).toMatch(/box\.fill\(query\)/);
  });
});

describe('a search that never ran must not read as "no matches"', () => {
  const fn = SRC.slice(SRC.indexOf("cmd === 'loom-search'"),
                       SRC.indexOf("cmd === 'prepare' || cmd === 'commit'"));

  it('waits for the response rather than a fixed time', () => {
    // A sleep a shade too short falls back to whatever is on screen, which is
    // the unfiltered library — the exact failure this command had twice.
    expect(fn).toMatch(/while \(!hits\.length && Date\.now\(\) < deadline\)/);
  });

  it('says so explicitly when no response arrived', () => {
    expect(SRC).toMatch(/This is NOT[\s\S]{0,40}"no matches"/);
    expect(fn).toMatch(/noResponse/);
  });
});

describe('not signed in must never look like an empty library', () => {
  // The failure that would waste Kevin's time: an agent reports "nothing in
  // your Loom about that" when the truth is the session expired. One is an
  // answer, the other is a broken tool, and they are indistinguishable unless
  // the code says which.
  it('decides signed-out by whether the LIBRARY rendered, not by text', () => {
    // The text test was wrong and dangerously so: Loom's marketing and login
    // pages carry /share/ links, so "does the page say log in" can read the
    // login page as a full library and return marketing videos as Kevin's.
    expect(SRC).toMatch(/signedOut/);
    expect(SRC).toMatch(/\/\\\/login\/\.test\(location\.pathname\)/);
    expect(SRC).not.toMatch(/get started free/i);
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
