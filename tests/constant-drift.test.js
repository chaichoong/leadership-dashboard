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

  // ── Tier-1 labelling (Kevin's call, 6 Aug 2026) ──────────────────────────
  // Tier 1 is his private legal and financial matter. It used to be dropped
  // out of the worklist entirely; now agents PREPARE it and it stops at his
  // approval like everything else, because the guardrail sits before the
  // action, not before the reading. The whole safety of that decision rests on
  // ONE thing: he can tell a tier-1 card apart from ordinary admin at a
  // glance. Two independent labels do that, and each covers the other's blind
  // spot — the worker's banner cannot see a connection an agent only found
  // mid-work, and the engine's banner cannot fire on a task no agent touched.
  //
  // This is a text contract, not a behavioural test, and it is honest about
  // that: it cannot prove the banner renders, only that neither half has been
  // quietly deleted. Deleting either one restores the pre-6-Aug failure mode
  // in the worst possible shape — tier-1 work prepared and posted looking like
  // a routine utility bill.
  describe('tier 1 is labelled on both sides, never silently prepared', () => {
    it('control — both files parsed and both still classify tier 1', () => {
      expect(PY.length, 'agent-dispatch.py read went blind').toBeGreaterThan(2000);
      expect(APPROVALS.length, 'approvals.js read went blind').toBeGreaterThan(2000);
      expect(PY).toMatch(/TIER1_PATTERNS\s*=/);
      expect(APPROVALS).toMatch(/KEVIN_ONLY_PATTERNS\s*=/);
    });

    it('the two pattern lists still agree', () => {
      const pyPats = [...(PY.match(/TIER1_PATTERNS = \[(.*?)\n\]/s)?.[1] ?? '')
        .matchAll(/r"([^"]+)"/g)].map((m) => m[1].toLowerCase());
      const jsPats = [...(APPROVALS.match(/KEVIN_ONLY_PATTERNS = \[(.*?)\n\];/s)?.[1] ?? '')
        .matchAll(/\/([^/]+)\/i/g)].map((m) => m[1].toLowerCase());
      expect(pyPats.length, 'python tier-1 pattern parse went blind').toBeGreaterThan(3);
      expect(jsPats.length, 'worker tier-1 pattern parse went blind').toBeGreaterThan(3);
      expect(new Set(pyPats)).toEqual(new Set(jsPats));
    });

    it('the engine stamps a banner and verify checks the live field for it', () => {
      // The banner is DEFINED once, in the shared email-format module, and
      // imported here. send-email.py strips exactly what this prepends; when
      // they were two separate string literals the banner made every tier-1
      // Correspondence task unsendable (finding 20260811-agent-dispatch-084).
      const FORMAT = read('scripts/agent_email_format.py');
      expect(FORMAT, 'TIER1_BANNER constant is gone').toMatch(/TIER1_BANNER\s*=/);
      expect(PY, 'agent-dispatch no longer imports the shared banner')
        .toMatch(/from agent_email_format import[\s\S]{0,200}TIER1_BANNER/);
      expect(PY, 'agent-dispatch redefines the banner instead of importing it')
        .not.toMatch(/^TIER1_BANNER\s*=/m);
      expect(PY, 'submit no longer accepts --tier1').toContain('"--tier1"');
      // Stamped on submit...
      expect(PY).toMatch(/args\.tier1 and TIER1_BANNER not in output/);
      // ...and re-read from Airtable in verify, not trusted from the report.
      expect(PY).toMatch(/TIER1_BANNER not in live\["agentOutput"\]/);
    });

    it('tier 1 is no longer dropped out of the worklist', () => {
      const loop = PY.match(/for t in agent_linked:(.*?)\n\n/s)?.[1] ?? '';
      expect(loop.length, 'classification-loop parse went blind').toBeGreaterThan(100);
      // The regression: a `continue` straight after the tier-1 match, which
      // silently removes the task from everything downstream.
      expect(loop).not.toMatch(/if hit1:[\s\S]{0,120}continue/);
      expect(loop, 'tier-1 tasks must be marked, not skipped').toMatch(/t\["tier1"\]/);
    });

    it('the worker still renders its own banner on the post', () => {
      expect(APPROVALS).toMatch(/const warn = isKevinOnlyMatter\(/);
      expect(APPROVALS).toMatch(/buildApprovalBlocks\(t, agent, warn\)/);
      expect(APPROVALS).toMatch(/if \(warn\) \{/);
      // The old wording told him an agent should not be preparing this at all.
      // That is now false and would read as a system fault every time.
      expect(APPROVALS).not.toContain('An agent should not be preparing this');
    });
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

// The auto-bump trigger list and the auto-bump mapping are two hand-maintained copies
// of the same set, in two different file formats, and both carried a "keep in sync"
// comment. They were not in sync: 21 of 34 mapped files were missing from the workflow
// filter, so a push touching any of them never started the workflow and pageVer never
// moved.
//
// It fails silently in the worst direction. Nothing errors — the workflow simply does
// not run, so the page keeps whatever pageVer it last had and every staleness signal
// built on pageVer reads it as current. The CRM page gained a 14-step interactive
// walkthrough on 2026-08-04 (319b438) and the drift monitor reported it two days later
// as "in sync" with its guide, because 1.0 == 1.0.
//
// Note the trap in the earlier attempt: CRM was added to FILE_TO_PAGE on 2026-08-01 to
// fix exactly this, and it changed nothing, because the missing half was the `paths:`
// filter. Adding a file to one list looks like a fix and is not one.
describe('auto-bump trigger list does not drift from the auto-bump mapping', () => {
  const SCRIPT = read('scripts/pre-commit-action.py');
  const WORKFLOW = read('.github/workflows/auto-bump-pagever.yml');

  // FILE_TO_PAGE keys: the files the bump script knows how to attribute to a page.
  const mappedBlock = SCRIPT.match(/FILE_TO_PAGE = \{(.*?)\n\}/s);
  const mapped = mappedBlock
    ? [...mappedBlock[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
    : [];

  // `paths:` entries: the files that actually start the workflow. Read only the
  // trigger block — `permissions:` ends it, and the job body below contains other
  // quoted paths that would otherwise be scooped up as phantom triggers.
  const triggerBlock = WORKFLOW.split('permissions:')[0];
  const triggers = [...triggerBlock.matchAll(/^\s*-\s*'([^']+)'/gm)].map((m) => m[1]);

  // CONTROL — a regex that matches nothing makes both lists empty, and "the two lists
  // are equal" then passes forever while the real lists diverge. Assert the haystack.
  it('parses both lists (control — guards against a vacuous pass)', () => {
    expect(mapped.length, 'FILE_TO_PAGE parsed empty').toBeGreaterThan(25);
    expect(triggers.length, 'workflow paths parsed empty').toBeGreaterThan(25);
    // The file whose absence caused the CRM miss. If this stops matching, the block is blind.
    expect(mapped).toContain('crm-supabase.html');
    expect(triggers).toContain('crm-supabase.html');
  });

  it('every mapped file is in the workflow paths filter', () => {
    const notTriggered = mapped.filter((f) => !triggers.includes(f)).sort();
    expect(
      notTriggered,
      'Mapped in scripts/pre-commit-action.py but missing from the workflow `paths:` filter.\n' +
        'These files never auto-bump — the workflow does not run at all for them:\n' +
        notTriggered.map((f) => `  ${f}`).join('\n'),
    ).toEqual([]);
  });

  it('every workflow path is mapped to a page', () => {
    const unmapped = triggers.filter((f) => !mapped.includes(f)).sort();
    expect(
      unmapped,
      'Listed in the workflow `paths:` filter but absent from FILE_TO_PAGE.\n' +
        'These start a workflow run that can do nothing:\n' +
        unmapped.map((f) => `  ${f}`).join('\n'),
    ).toEqual([]);
  });

  it('every mapped page id exists in PAGE_REGISTRY', () => {
    const registryIds = new Set(
      [...CONFIG.matchAll(/\{\s*id:\s*'([^']+)'[^}]*pageVer:/g)].map((m) => m[1]),
    );
    expect(registryIds.size, 'PAGE_REGISTRY parsed empty').toBeGreaterThan(20);

    const targets = mappedBlock
      ? [...mappedBlock[1].matchAll(/^\s*'[^']+':\s*(\[[^\]]*\]|'[^']*')/gm)].flatMap((m) =>
          [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
        )
      : [];
    const missing = [...new Set(targets.filter((id) => !registryIds.has(id)))].sort();
    expect(
      missing,
      `Auto-bump targets a page id that PAGE_REGISTRY does not define: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
