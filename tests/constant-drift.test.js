import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// Constant drift across files — the failure class behind the AI-model outage.
//
// scripts/slack-automation/money-daily-worker.js is a deliberate PORT of the browser
// engine (js/money.js). A Cloudflare Worker has no `window` and no shared bundle, so it
// cannot read js/config.js; it re-declares BASE_ID, WAGES_TARGET_GBP, the table IDs and
// the field IDs itself. Its own header says:
//
//     "If the formula changes in the app, change it here too or the Slack figure
//      will drift from the Money tab."
//
// That is a comment. Nothing enforces it. This test does.
//
// It matters because the worker DMs Kevin a "Safe to act today" figure every weekday
// morning and he makes money decisions on it. If config.js moves the wages budget off
// £1,500 and the worker keeps its own copy, the app and the Slack message disagree and
// neither says so. Same shape as the model IDs stranded in the workers, but the payload
// is a number Kevin spends against.
//
// Parsing by regex rather than importing: the browser code is loaded via global <script>
// tags, not ES modules, so there is nothing to import. See tests/shared.test.js, which
// copies functions for the same reason.

const CONFIG = read('js/config.js');
const WORKER = read('scripts/slack-automation/money-daily-worker.js');

/** Pull an object literal (`const NAME = { k: 'v', ... };`) into a plain map.
 *  Tolerates leading indentation — config.js nests its declarations inside an IIFE,
 *  and a regex anchored to a column-0 closing brace silently returns {} against it. */
function objectLiteral(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\{(.*?)\\n\\s*\\};`, 's'));
  if (!m) return {};
  return Object.fromEntries([...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
}

function scalar(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*('([^']*)'|([0-9._]+))`));
  return m ? (m[2] ?? m[3]) : undefined;
}

describe('money-daily-worker does not drift from js/config.js', () => {

  // CONTROL — every assertion below compares the worker against these maps. If a parse
  // silently returns {}, `worker key not in config` finds nothing and the whole suite
  // passes while testing nothing. That is not hypothetical: the first draft of this file
  // had a regex that missed config.js's indented `F` block and reported a clean pass
  // against an empty object. Assert the haystack exists before searching it.
  it('parses both sources (control — guards against a vacuous pass)', () => {
    expect(Object.keys(objectLiteral(CONFIG, 'F')).length).toBeGreaterThan(50);
    expect(Object.keys(objectLiteral(CONFIG, 'TABLES')).length).toBeGreaterThan(5);
    expect(Object.keys(objectLiteral(WORKER, 'F')).length).toBeGreaterThan(5);
    expect(Object.keys(objectLiteral(WORKER, 'TBL')).length).toBeGreaterThan(0);
    expect(scalar(CONFIG, 'WAGES_TARGET_GBP')).toBeDefined();
    expect(scalar(WORKER, 'WAGES_TARGET_GBP')).toBeDefined();
  });

  it('WAGES_TARGET_GBP matches — the figure Kevin spends against', () => {
    expect(scalar(WORKER, 'WAGES_TARGET_GBP')).toBe(scalar(CONFIG, 'WAGES_TARGET_GBP'));
  });

  it('BASE_ID matches', () => {
    expect(scalar(WORKER, 'BASE_ID')).toBe(scalar(CONFIG, 'BASE_ID'));
  });

  it('every table ID the worker uses matches config.js TABLES', () => {
    const tbl = objectLiteral(WORKER, 'TBL');
    const tables = objectLiteral(CONFIG, 'TABLES');
    for (const [key, id] of Object.entries(tbl)) {
      expect(tables, `worker TBL.${key} has no counterpart in config TABLES`).toHaveProperty(key);
      expect(id, `worker TBL.${key} drifted from config.js`).toBe(tables[key]);
    }
  });

  it('every field ID the worker uses matches config.js F', () => {
    const wf = objectLiteral(WORKER, 'F');
    const cf = objectLiteral(CONFIG, 'F');
    for (const [key, id] of Object.entries(wf)) {
      expect(cf, `worker F.${key} has no counterpart in config F`).toHaveProperty(key);
      expect(id, `worker F.${key} drifted from config.js`).toBe(cf[key]);
    }
  });
});

// ── Duplicate global declarations ────────────────────────────────────────────
// Every js/ file is a plain <script> sharing ONE global scope. Two files declaring
// the same top-level `const` throws "Identifier X has already been declared" and
// takes out EVERY tab, not just the two involved. It happened on 2026-07-20:
// CAT_NAME_FIELD was added to config.js while costs.js already had its own copy,
// and 14 sync tests went red across tabs that had nothing to do with the change.
//
// Rather than guess at top-level scope with a regex, this concatenates the files in
// the exact order index.html loads them and parses the result — which is precisely
// what the browser does, so a collision fails here for the same reason it fails live.
describe('no duplicate global declarations across js/ files', () => {
  it('parses every js/ file concatenated in index.html load order', () => {
    const html = read('index.html');
    const order = [...html.matchAll(/<script[^>]+src="(js\/[^"?]+)/g)].map((m) => m[1]);
    expect(order.length).toBeGreaterThan(5); // guard: a broken regex must not silently pass

    const combined = order
      .map((f) => {
        try { return read(f); } catch (e) { return ''; }
      })
      .join('\n;\n');

    let error = null;
    try { new Function(combined); } catch (e) { error = e.message; }
    expect(error).toBeNull();
  });
});
