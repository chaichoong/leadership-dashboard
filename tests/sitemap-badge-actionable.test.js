import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/sitemap.js'), 'utf8');
const configSrc = readFileSync(resolve(root, 'js/config.js'), 'utf8');

function extract(text, name, file) {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  let i = text.indexOf('{', start), depth = 0, end = -1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return text.slice(start, end);
}

// The real PAGE_REGISTRY, so this test moves with the product rather than a fixture.
const liveRegistry = new Function(
  `${configSrc.match(/const PAGE_REGISTRY\s*=\s*\[[\s\S]*?\n\s*\];/)[0]} return PAGE_REGISTRY;`
)();

// A minimal fake badge element and document, so the shipped updateSitemapBadge runs
// unchanged.
function runBadge(registry, gitSyncData = null) {
  const badge = { textContent: '', title: '', style: {} };
  const document = { getElementById: (id) => (id === 'sitemapBadge' ? badge : null) };
  const fn = new Function('document', 'PAGE_REGISTRY', 'gitSyncData', 'getGitStatus',
    `${extract(src, 'updateSitemapBadge', 'js/sitemap.js')}; updateSitemapBadge();`);
  fn(document, registry, gitSyncData, () => null);
  return badge;
}

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-157 — a red 24 when only 13 items could be acted on
// ─────────────────────────────────────────────────────────────────────────────
// Before any git-sync check has run, the badge fell back to counting every page whose
// declared pageVer !== sopVer. Eleven of those have no SOP file at all, so their sopVer
// is a placeholder that can never match and no button on the page regenerates them. The
// badge therefore demanded action on eleven items that had none available.
describe('Site Map sidebar badge counts only what can be acted on', () => {
  const registry = [
    { id: 'a', pageVer: '2.0', sopVer: '1.0', sopFile: 'sop-a.html' },   // actionable
    { id: 'b', pageVer: '3.1', sopVer: '2.9', sopFile: 'sop-b.html' },   // actionable
    { id: 'c', pageVer: '1.4', sopVer: '0.0', sopFile: '' },             // no SOP to update
    { id: 'd', pageVer: '1.4', sopVer: '0.0' },                          // no SOP field at all
    { id: 'e', pageVer: '5.0', sopVer: '5.0', sopFile: 'sop-e.html' },   // in sync
  ];

  it('shows the count of SOPs that are actually behind their page', () => {
    expect(runBadge(registry).textContent).toBe(2);
  });

  it('mentions the SOP-less pages in the tooltip rather than counting them red', () => {
    const badge = runBadge(registry);
    expect(badge.style.background).toBe('var(--danger)');
    expect(badge.title).toContain('2 SOPs behind its page');
    expect(badge.title).toContain('2 pages with no SOP yet (not counted)');
  });

  it('hides the badge when every page with an SOP is in sync', () => {
    const allGood = registry.map(p => ({ ...p, sopVer: p.pageVer }));
    expect(runBadge(allGood).style.display).toBe('none');
  });

  // Back-test against the live registry: the old rule counted mismatches regardless of
  // sopFile. The two numbers must differ, or this test is asserting nothing.
  it('is a smaller number than the old rule on the real registry', () => {
    const oldRule = liveRegistry.filter(p => p.pageVer !== p.sopVer).length;
    const newRule = liveRegistry.filter(p => p.pageVer !== p.sopVer && p.sopFile).length;
    expect(oldRule).toBeGreaterThan(newRule);
    expect(Number(runBadge(liveRegistry).textContent)).toBe(newRule);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-158 — the button said work was "Processing" when nothing runs
// ─────────────────────────────────────────────────────────────────────────────
// "Update All Out-of-Sync SOPs" writes Pending rows to the SOP Update Queue table in
// Airtable and then reported them as being processed. The SOP phase was absorbed into
// daily-ops and never wired back, so nothing consumes that table. A green tick over an
// empty pipeline is worse than no button at all.
describe('SOP update requests do not claim to be processing', () => {
  it('no surface tells Kevin the queue is being processed automatically', () => {
    expect(src).not.toContain('will be processed automatically');
    expect(src).not.toContain('Update Requested — Processing');
  });

  it('says plainly that a person has to pick the request up', () => {
    expect(src).toContain('waiting for a writer');
    expect(src).toContain('waiting for someone to write it');
  });

  it('a stale queue is caught by a LIVE invariant, not a fixture test', () => {
    // The rows live in Airtable and the bug is their AGE, which page.route fixtures
    // cannot see. Guard is scripts/check-data-invariants.py.
    const invariants = readFileSync(resolve(root, 'scripts/check-data-invariants.py'), 'utf8');
    expect(invariants).toContain('sop-queue-not-abandoned');
    expect(invariants).toContain('tbltuZz5Omrpo7t1x');
    expect(invariants).toContain("DATEADD(NOW(), -48, 'hours')");
  });
});
