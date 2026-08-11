import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const CFV = read('js/cfv.js');
const DASH = read('js/dashboard.js');
const RECON = read('js/reconciliation.js');

// Two findings from the 11 Aug 2026 drift run, both on the sidebar CFV badge —
// the first alarm Kevin looks at, and the one place where "empty" and "nothing
// wrong" look identical.
//
// 20260811-drift-079: the badge was only updated after the full 9-table Airtable
// refresh. The cache render path set the globals, drew the dashboard, hid the
// loading overlay and said "showing data from 1 min ago" — and left the badge
// blank. Measured live across three loads: #cfvSidebarBadges was still '' at
// 08:11:32 and only rendered at 08:13:30. detectCFVs() returned five entries the
// whole time, so the data was there from the first paint.
//
// 20260811-drift-080: FOUR copies of "does this CFV count", and three disagreed.
// dashboard.js and reconciliation.js dropped an entry when localStorage held
// cfv_dismissed_<id> and the status was 'cfv' OR 'potential', with no expiry.
// The render path and the auto-return path dismiss 'potential' only. So a
// tenancy dismissed while merely potential, which then escalated to a CONFIRMED
// CFV, kept its key: the sidebar hid genuinely overdue rent that the CFV page
// was still listing. Latent on the day only because none of the five live CFVs
// had a dismissal key.
//
// The rule is extracted from js/cfv.js and executed, not re-implemented — a JS
// copy of the rule would pass while the shipped rule stayed wrong.
function loadRule() {
  const m = CFV.match(/function cfvIsVisible\([\s\S]*?\n    \}/);
  if (!m) throw new Error('cfvIsVisible not found in js/cfv.js');
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('localStorage', 'CFV_TOLERANCE_DAYS',
    `${m[0]}; return cfvIsVisible;`)(localStorage, 2);
  return { cfvIsVisible: fn, store };
}

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();

describe('cfvIsVisible — one rule for the badge and the table', () => {
  let cfvIsVisible; let store;
  beforeEach(() => { ({ cfvIsVisible, store } = loadRule()); });

  it('a CONFIRMED cfv always counts, even with a stale dismissal key', () => {
    store.set('cfv_dismissed_ten1', iso(Date.now() - DAY));
    expect(cfvIsVisible({ status: 'cfv', tenancyId: 'ten1', dueDay: 1 }),
      'the sidebar hid a confirmed CFV the CFV page still shows').toBe(true);
  });

  it('a CFV Actioned item always counts', () => {
    store.set('cfv_dismissed_ten2', iso(Date.now() - DAY));
    expect(cfvIsVisible({ status: 'cfv actioned', tenancyId: 'ten2', dueDay: 1 })).toBe(true);
  });

  it('a freshly dismissed POTENTIAL is hidden', () => {
    store.set('cfv_dismissed_ten3', iso(Date.now()));
    expect(cfvIsVisible({ status: 'potential', tenancyId: 'ten3', dueDay: 1 })).toBe(false);
  });

  it('an undismissed potential counts', () => {
    expect(cfvIsVisible({ status: 'potential', tenancyId: 'ten4', dueDay: 1 })).toBe(true);
  });

  it('a dismissal expires once the next due day plus tolerance has passed', () => {
    // Dismissed 70 days ago: the next due day and the 2-day tolerance are long gone.
    store.set('cfv_dismissed_ten5', iso(Date.now() - 70 * DAY));
    expect(cfvIsVisible({ status: 'potential', tenancyId: 'ten5', dueDay: 1 })).toBe(true);
    expect(store.has('cfv_dismissed_ten5'), 'the expired key was left behind').toBe(false);
  });

  it('a corrupt dismissal date does not hide a CFV for ever', () => {
    store.set('cfv_dismissed_ten6', 'not a date');
    expect(cfvIsVisible({ status: 'potential', tenancyId: 'ten6', dueDay: 1 })).toBe(true);
  });
});

describe('the badge is drawn on every render path', () => {
  it('the cache render path updates the sidebar badges (079)', () => {
    const cachePath = DASH.match(/if \(cached\) \{[\s\S]*?renderedFromCache = true;/);
    expect(cachePath, 'cache render path not found in js/dashboard.js').toBeTruthy();
    expect(cachePath[0], 'a cached render still leaves the CFV badge blank')
      .toMatch(/updateSidebarBadges\(\)/);
  });

  it('the fresh-fetch path uses the same helper, not its own copy', () => {
    expect(DASH).toMatch(/function updateSidebarBadges\(\)/);
    // The old inline block is gone: no file outside js/cfv.js may re-derive the
    // dismissal rule.
    expect(DASH, 'js/dashboard.js still carries its own dismissal filter')
      .not.toMatch(/cfv_dismissed_' \+ e\.tenancyId/);
    expect(RECON, 'js/reconciliation.js still carries its own dismissal filter')
      .not.toMatch(/cfv_dismissed_' \+ e\.tenancyId/);
  });

  it('the health check grades against the shipped rule, not a copy of it', () => {
    expect(CFV).toMatch(/hcCfvList\.filter\(cfvIsVisible\)/);
  });

  it('the badge helper is shared, so the count cannot fork again', () => {
    expect(CFV).toMatch(/function refreshCFVSidebarBadges\(\)/);
    // Only js/cfv.js — which owns the rule — may set the badge. Every other
    // caller goes through refreshCFVSidebarBadges(). Four copies of the count is
    // what produced drift-080.
    expect(DASH, 'js/dashboard.js sets the CFV badge itself')
      .not.toMatch(/updateCFVSidebarBadges\(/);
    expect(RECON, 'js/reconciliation.js sets the CFV badge itself')
      .not.toMatch(/updateCFVSidebarBadges\(/);
  });
});
