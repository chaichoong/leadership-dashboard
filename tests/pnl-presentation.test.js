import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// js/ files load as plain <script> tags, so there is nothing to import. Pull the real
// function text out of js/pnl.js and evaluate it, the way tests/recon-vendor-key.test.js
// does, so this suite always tests the shipped code rather than a copy that drifts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/pnl.js'), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/pnl.js`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

const load = (name) => new Function(`${extract(name)}; return ${name};`)();

const pnlComparisonWording = load('pnlComparisonWording');
const pnlSectionSign = load('pnlSectionSign');
const pnlCurrentMonthKey = load('pnlCurrentMonthKey');

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-174 — over-budget cards said "below budget"
// ─────────────────────────────────────────────────────────────────────────────
// The Avg Monthly Maintenance and Avg Monthly Wages cards pass invertComparison,
// because spending LESS than the budget is the good outcome. The direction word was
// derived from that goodness flag rather than from the number, so the two cards Kevin
// checks most printed the exact opposite of the truth: £500 over budget rendered as
// "▼ £500 below budget", and £500 under budget as "▲ £500 above budget".
describe('pnlComparisonWording — the word describes the number, not the verdict', () => {
  it('says OVER when an inverted (budget) card is over budget, and calls it bad', () => {
    const r = pnlComparisonWording(500, true);   // spent £500 more than budget
    expect(r.word).toBe('over');
    expect(r.arrow).toBe('▲');
    expect(r.good).toBe(false);                  // over budget is still bad news
  });

  it('says UNDER when an inverted card is under budget, and calls it good', () => {
    const r = pnlComparisonWording(-500, true);  // spent £500 less than budget
    expect(r.word).toBe('under');
    expect(r.arrow).toBe('▼');
    expect(r.good).toBe(true);
  });

  it('still says above/below on ordinary cards (revenue, net profit, margins)', () => {
    expect(pnlComparisonWording(2000, false)).toMatchObject({ word: 'above', arrow: '▲', good: true });
    expect(pnlComparisonWording(-2000, false)).toMatchObject({ word: 'below', arrow: '▼', good: false });
  });

  it('treats exactly on budget as under, not over', () => {
    expect(pnlComparisonWording(0, true)).toMatchObject({ word: 'under', good: true });
    expect(pnlComparisonWording(0, false)).toMatchObject({ word: 'above', good: true });
  });

  // Back-test of the original bug: the old code was `good ? 'above' : 'below'`.
  // If anyone re-derives the word from `good` on an inverted card, this fails.
  it('never derives the word from the good/bad verdict', () => {
    const overBudget = pnlComparisonWording(500, true);
    expect(overBudget.good).toBe(false);
    expect(overBudget.word).not.toBe('below');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-176 — the drill-down modal showed the opposite sign to the cell
// ─────────────────────────────────────────────────────────────────────────────
// buildPnL stores costs positive (P&L presentation). The modal read Report Amount raw,
// so a £2,500 maintenance cell opened a modal headed "Sum: -£2,500". One definition of
// the sign now serves both, so they cannot disagree again.
describe('pnlSectionSign — one sign rule for the grid and the modal', () => {
  it('leaves revenue as Airtable stores it', () => {
    expect(pnlSectionSign('Revenue')).toBe(1);
  });

  it('flips both cost sections so they present as positive magnitudes', () => {
    expect(pnlSectionSign('Cost of Goods Sold')).toBe(-1);
    expect(pnlSectionSign('Operating Expenses')).toBe(-1);
  });

  it('a £2,500 expense reads the same in the grid and in the modal', () => {
    const raw = -2500;                                  // as Airtable stores an outflow
    const gridCell = pnlSectionSign('Operating Expenses') * raw;
    const modalRunningTotal = pnlSectionSign('Operating Expenses') * raw;
    expect(gridCell).toBe(2500);
    expect(modalRunningTotal).toBe(gridCell);
  });

  it('the grid and the modal both call pnlSectionSign — neither inlines its own rule', () => {
    // The bug was two copies of one rule, so ban the inlined form outright.
    expect(src).not.toMatch(/===\s*'Revenue'\s*\?\s*amt\s*:\s*-amt/);
    expect(extract('pnlDrill')).toContain('pnlSectionSign(section)');
    expect(extract('buildPnL')).toContain('pnlSectionSign(sectionName)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-178 — the newest column is a part month and nothing said so
// ─────────────────────────────────────────────────────────────────────────────
describe('current-month column is labelled as month-to-date', () => {
  it('pnlCurrentMonthKey matches the newest key pnlMonthKeys produces', () => {
    const now = new Date(2026, 7, 16);                   // 16 Aug 2026
    expect(pnlCurrentMonthKey(now)).toBe('2026-08');
    expect(pnlCurrentMonthKey(new Date(2026, 0, 3))).toBe('2026-01');   // zero padding
    expect(pnlCurrentMonthKey(new Date(2026, 11, 31))).toBe('2026-12');
  });

  it('the grid header marks that column MTD', () => {
    const header = src.slice(src.indexOf('const headCells'), src.indexOf('function jsAttr'));
    expect(header).toContain('currentMonthKey');
    expect(header).toContain('MTD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-177 — a failed panel lookup jammed Generate Analysis for ever
// ─────────────────────────────────────────────────────────────────────────────
// _pnlAiLoading was claimed BEFORE the #pnlAiPanel lookup, so a missing panel returned
// early with the flag stuck true. Every later click hit `if (_pnlAiLoading) return` and
// did nothing — no error, no spinner, no way back short of reloading the page.
describe('pnlRunAIAnalysis — the in-flight flag is never claimed before the early return', () => {
  const body = extract('pnlRunAIAnalysis');
  const lookup = body.indexOf("getElementById('pnlAiPanel')");
  const earlyReturn = body.indexOf('if (!panel) return;');
  const claim = body.indexOf('_pnlAiLoading = true');

  it('looks the panel up and returns before claiming the flag', () => {
    expect(lookup).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(earlyReturn);
  });

  it('still releases the flag in a finally block, so a failed fetch does not jam it either', () => {
    expect(body).toMatch(/finally\s*{[^}]*_pnlAiLoading\s*=\s*false/s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-175 — the P&L never re-rendered when a refresh replaced its data
// ─────────────────────────────────────────────────────────────────────────────
describe('refreshPnLIfActive', () => {
  function run({ present = true, active = true } = {}) {
    const renderPnL = vi.fn();
    const doc = {
      getElementById: (id) => (present && id === 'tab-pnl'
        ? { classList: { contains: (c) => c === 'active' && active } }
        : null),
    };
    const fn = new Function('document', 'renderPnL', `${extract('refreshPnLIfActive')}; return refreshPnLIfActive();`);
    const result = fn(doc, renderPnL);
    return { result, renderPnL };
  }

  it('re-renders when the P&L is the tab on screen', () => {
    const { result, renderPnL } = run({ active: true });
    expect(result).toBe(true);
    expect(renderPnL).toHaveBeenCalledOnce();
  });

  it('does nothing when the P&L is not the visible tab', () => {
    const { result, renderPnL } = run({ active: false });
    expect(result).toBe(false);
    expect(renderPnL).not.toHaveBeenCalled();
  });

  it('does nothing when the tab panel is absent entirely', () => {
    const { result, renderPnL } = run({ present: false });
    expect(result).toBe(false);
    expect(renderPnL).not.toHaveBeenCalled();
  });

  it('is wired into BOTH loadDashboard render paths, not just the fresh fetch', () => {
    // The cache path paints first and is the one Kevin sees on every reload; wiring
    // only the fresh path would leave the original bug for the first two minutes.
    const dash = readFileSync(resolve(root, 'js/dashboard.js'), 'utf8');
    const calls = dash.match(/refreshPnLIfActive\(\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(dash).toContain('window.dashDataAsOf');
  });
});

describe('pnlDataAgeNote — old data is visibly old', () => {
  const pnlDataAgeNote = new Function(
    'window',
    `${extract('pnlDataAgeNote')}; return pnlDataAgeNote;`
  );

  it('says nothing useful when the stamp is missing rather than inventing freshness', () => {
    expect(pnlDataAgeNote({})('')).toBe('');
  });

  it('calls fresh data current', () => {
    const now = 1_000_000_000;
    expect(pnlDataAgeNote({ dashDataAsOf: now - 60_000 })(now)).toContain('current');
  });

  it('flags stale data in minutes and hours', () => {
    const now = 1_000_000_000;
    expect(pnlDataAgeNote({ dashDataAsOf: now - 20 * 60_000 })(now)).toContain('20 min old');
    expect(pnlDataAgeNote({ dashDataAsOf: now - 3 * 60 * 60_000 })(now)).toContain('3 hr old');
  });
});
