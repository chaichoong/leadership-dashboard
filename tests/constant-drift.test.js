import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
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

// ── Agent autonomy threshold: browser vs the CEO huddle's report script ──────
//
// The bar that decides whether an agent gets RECOMMENDED for autonomy exists in
// two places, because a Python script cannot import a browser file:
//   js/agent-accuracy.js         — what the dashboard and the Task OS score with
//   scripts/agent-accuracy-report.py — what the 07:40 CEO huddle reads out
//
// If those drift, Kevin gets told in the huddle that an agent has earned its
// autonomy while the app still says it has not — or worse, the reverse. The
// numbers are small and easy to "tidy" in one file without touching the other,
// which is exactly how the AI-model constant drifted before.
describe('agent autonomy threshold does not drift between the app and the huddle', () => {
  const JS = read('js/agent-accuracy.js');
  const PY = read('scripts/agent-accuracy-report.py');

  const jsThreshold = (key) => {
    const m = JS.match(new RegExp(`${key}\\s*:\\s*([0-9.]+)`));
    return m ? Number(m[1]) : undefined;
  };
  const pyConst = (name) => {
    const m = PY.match(new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, 'm'));
    return m ? Number(m[1]) : undefined;
  };

  // CONTROL — if either parse returns undefined, every comparison below would be
  // undefined === undefined and pass while testing nothing.
  it('parses both sources (control — guards against a vacuous pass)', () => {
    expect(jsThreshold('minSample')).toBeTypeOf('number');
    expect(jsThreshold('minRate')).toBeTypeOf('number');
    expect(jsThreshold('recentN')).toBeTypeOf('number');
    expect(pyConst('MIN_SAMPLE')).toBeTypeOf('number');
    expect(pyConst('MIN_RATE')).toBeTypeOf('number');
    expect(pyConst('RECENT_N')).toBeTypeOf('number');
  });

  it('minimum sample matches', () => {
    expect(pyConst('MIN_SAMPLE')).toBe(jsThreshold('minSample'));
  });

  it('minimum accuracy rate matches', () => {
    expect(pyConst('MIN_RATE')).toBe(jsThreshold('minRate'));
  });

  it('recent-rejections window matches', () => {
    expect(pyConst('RECENT_N')).toBe(jsThreshold('recentN'));
  });

  it('both count the same two outcomes as accurate', () => {
    const jsAccurate = JS.match(/APPROVAL_ACCURATE\s*=\s*\[([^\]]+)\]/)[1];
    const pyAccurate = PY.match(/ACCURATE\s*=\s*\(([^)]+)\)/)[1];
    ['Approved as-is', 'Approved with minor edits'].forEach((outcome) => {
      expect(jsAccurate).toContain(outcome);
      expect(pyAccurate).toContain(outcome);
    });
    // And neither may quietly count a rejection as accurate.
    expect(jsAccurate).not.toContain('Rejected');
    expect(pyAccurate).not.toContain('Rejected');
  });
});

// ── Agent dispatch engine: field IDs vs config.js and the Slack worker ──────
//
// scripts/agent-dispatch.py is stage 2 of the approval loop (the scheduled task
// `agent-dispatch` on Kevin's Mac). Python cannot import js/config.js, so it
// re-declares the Tasks field IDs — the same stranded-copy shape as the money
// worker above. If its `submit` writes Agent Output or Status through a drifted
// field ID, agents' work lands in the wrong field and every Slack approval post
// says "the agent left its work empty".
describe('agent-dispatch.py does not drift from config.js or approvals.js', () => {
  const PY = read('scripts/agent-dispatch.py');
  const APPROVALS = read('scripts/slack-automation/approvals.js');

  // Python dict literal: "key": "fldXXX",
  const pyAF = Object.fromEntries(
    [...(PY.match(/AF = \{(.*?)\n\}/s)?.[1] ?? '').matchAll(/"(\w+)":\s*"(fld\w+)"/g)]
      .map((m) => [m[1], m[2]]),
  );
  const cfTasks = objectLiteral(CONFIG, 'TASK_FIELDS');
  const jsAF = objectLiteral(APPROVALS, 'AF');

  it('parses all three sources (control — guards against a vacuous pass)', () => {
    expect(Object.keys(pyAF).length).toBeGreaterThan(10);
    expect(Object.keys(cfTasks).length).toBeGreaterThan(10);
    expect(Object.keys(jsAF).length).toBeGreaterThan(10);
  });

  it('every shared field ID matches config.js TASK_FIELDS', () => {
    let overlap = 0;
    for (const [key, id] of Object.entries(pyAF)) {
      if (!(key in cfTasks)) continue;
      overlap += 1;
      expect(id, `agent-dispatch.py AF.${key} drifted from config.js`).toBe(cfTasks[key]);
    }
    expect(overlap, 'too little overlap — a renamed key would hide drift').toBeGreaterThan(10);
  });

  it('every shared field ID matches the Slack worker (approvals.js)', () => {
    let overlap = 0;
    for (const [key, id] of Object.entries(pyAF)) {
      if (!(key in jsAF)) continue;
      overlap += 1;
      expect(id, `agent-dispatch.py AF.${key} drifted from approvals.js`).toBe(jsAF[key]);
    }
    expect(overlap).toBeGreaterThan(10);
  });

  it('counts the same approved outcomes and hands back to the same Kevin', () => {
    const pyApproved = PY.match(/APPROVED = \(([^)]+)\)/)[1];
    // Read the approved-outcome strings out of the worker's own reaction map
    // rather than hardcoding them — if the worker renames an outcome, a
    // literal here would stay green while the two sources drift.
    const workerApproved = [
      ...new Set([...APPROVALS.matchAll(/:\s*'(Approved [^']+)'/g)].map((m) => m[1])),
    ];
    expect(workerApproved.length, 'worker approved-outcome parse went blind').toBeGreaterThan(0);
    workerApproved.forEach((o) => expect(pyApproved).toContain(o));
    expect(pyApproved).not.toContain('Rejected');
    const workerEmail = APPROVALS.match(/KEVIN_AIRTABLE_EMAIL = '([^']+)'/)[1];
    expect(PY).toContain(`KEVIN_AIRTABLE_EMAIL = "${workerEmail}"`);
  });
});

// ── Cache-bust drift across pages ────────────────────────────────────────────
// Shared assets are versioned by hand with a `?v=N` query string, and NOTHING
// automates it — not scripts/pre-commit-action.py, not the auto-bump workflow
// (those manage PAGE_REGISTRY pageVer, which is a different thing entirely).
//
// So a commit that edits a shared asset bumps only the page its author had open
// and strands every other consumer on the old string. Found by the E2E sweep on
// 2026-08-01: commit 1a60a56 (21 Jul) changed css/sync-bar.css and js/sync-bar.js
// and bumped only index.html. Sixteen pages were left asking for sync-bar.css?v=2
// — including the OS pages the shell loads in iframes, compliance.html and
// follow-up.html — so any returning browser with a cache warmed before 21 Jul kept
// serving the pre-21-Jul stylesheet inside those frames. Four other assets had
// drifted the same way and nobody had noticed: quick-task.js, sync-bar.js,
// skills-data.js and skills.js.
//
// It is invisible in every other check we run. The file on disk is correct, the
// markup is valid, the console is clean, and it only misbehaves for a visitor
// whose cache predates the change — never on a fresh browser, which is exactly
// what CI and a first-time load use. That is what makes it worth a test.
//
// The rule: one asset, one version, everywhere. Bump every reference or none.
describe('no cache-bust drift across pages', () => {
  // Enumerate via git rather than walking the tree. A plain walk also picks up
  // generated output — test-results/.playwright-artifacts-*/traces/resources/*.html
  // are saved copies of pages captured mid-run, so they carry whatever version was
  // live when the trace was taken and show up as permanent phantom drift against
  // whatever is on disk now. Tracked files are exactly the ones that ship, which is
  // what this guard is about, and the list stays correct as .gitignore changes.
  const pages = execFileSync('git', ['ls-files', '-z', '*.html'], { cwd: ROOT })
    .toString()
    .split('\0')
    .filter(Boolean);

  // asset path (relative-prefix stripped) -> version -> the pages asking for it
  const refs = new Map();
  for (const page of pages) {
    const src = read(page);
    // Charset is deliberately permissive: a name this misses is a file that never
    // gets checked, and the miss is silent.
    for (const m of src.matchAll(/(?:\.\.\/)*((?:css|js)\/[\w.-]+\.(?:css|js))\?v=(\d+)/g)) {
      const [, asset, version] = m;
      if (!refs.has(asset)) refs.set(asset, new Map());
      const byVersion = refs.get(asset);
      if (!byVersion.has(version)) byVersion.set(version, []);
      byVersion.get(version).push(page);
    }
  }

  // CONTROL — a typo in the walker or the regex yields an empty map, and "no asset
  // has two versions" is then trivially true forever. Same trap the money-worker
  // block above documents: assert the haystack before searching it.
  it('finds the versioned references (control — guards against a vacuous pass)', () => {
    expect(pages.length, 'no HTML pages scanned').toBeGreaterThan(15);
    expect(refs.size, 'no versioned assets found').toBeGreaterThan(20);
    // sync-bar.css is the asset that drifted; if it stops matching, this block is blind.
    expect([...refs.keys()]).toContain('css/sync-bar.css');
  });

  it('every shared asset is referenced at exactly one version', () => {
    const drifted = [...refs.entries()]
      .filter(([, byVersion]) => byVersion.size > 1)
      .map(([asset, byVersion]) => {
        const detail = [...byVersion.entries()]
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([v, pages]) => `    v=${v}: ${pages.sort().join(', ')}`)
          .join('\n');
        return `  ${asset} is referenced at ${byVersion.size} versions:\n${detail}`;
      });

    expect(
      drifted,
      `Cache-bust drift — bump every page that loads the asset, not just the one you edited:\n${drifted.join('\n')}`,
    ).toEqual([]);
  });
});
