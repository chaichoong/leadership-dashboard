// EVERY ffmpeg-DRIVEN SELFTEST WRAPPER CARRIES THE BUDGET, AND A LIST WOULD BE ONE DOOR SHORT
// (finding 20261121-queue-fixer-1405, round 2).
//
// A vitest case that shells out to a content-engine script's own `selftest` pays that script's wall
// time. The scripts that build real media with ffmpeg take seconds at rest and tens of seconds under
// the load a merge gate creates: measured on the Mac mini on 21 Nov 2026, qa.py went from 5.6s alone
// to 25.9s beside a full gate, and approval.py's case reached 33s against vitest.config.js's 30s
// default. So the budget held at rest and broke under exactly the load the gate creates, and on
// 21 Nov it turned the gate red on PRs 986, 987 and 1005 and left the whole fixer queue off main.
//
// Round 1 of that fix raised four cases by hand. The reviewer found three more (the overlays selftest
// here, and stab.py's and render.py's), which is the point: a hand-kept list of cases is always one
// door short. This guard finds them instead. It reads every test file, finds each `it()` case that
// runs a script's `selftest`, resolves which script that is from the file's own constants, and asks
// the SCRIPT whether it calls ffmpeg. A new ffmpeg-driven selftest wrapper fails this test the day it
// is written, and so does one whose budget is removed.
//
// The budget is raised per case and never in vitest.config.js: a long global default would hide a
// genuinely hung test everywhere else. The deeper cause is real media encoding inside a parallel
// suite, and cutting it is its own job.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const CE = path.join(ROOT, 'scripts', 'content-engine');
export const SELFTEST_BUDGET_MS = 120000;

/** Scripts in scripts/content-engine that really call ffmpeg, read off the scripts themselves. */
function ffmpegScripts() {
  const out = new Set();
  for (const f of readdirSync(CE)) {
    if (!f.endsWith('.py')) continue;
    if (readFileSync(path.join(CE, f), 'utf8').includes('ffmpeg')) out.add(f);
  }
  return out;
}

/** `const NAME = path.join(DIR, 'x.py')` and friends, as NAME -> x.py. */
function scriptConsts(src) {
  const map = new Map();
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\(([^;]*?)\)\s*;/g;
  for (const m of src.matchAll(re)) {
    const py = [...m[2].matchAll(/['"]([\w.-]+\.py)['"]/g)].pop();
    if (py) map.set(m[1], py[1]);
  }
  return map;
}

/**
 * Every `it()` case in SRC that runs a selftest: the .py files it names and the budget it declares
 * (null when it declares none).
 *
 * A case runs from its own `it(` to the next `it(`, `describe(` or the end of the file. That is
 * cruder than parsing the call, and deliberately so: the first draft walked the brackets and was
 * defeated by a regex literal holding a double quote (`not.toMatch(/"-H", *"Authorization/)` in
 * content-engine-publish.test.js), which it read as the start of a string, so one case swallowed the
 * next and the scan reported a case that runs no selftest at all. Telling a regex literal from a
 * division needs a real parser; block boundaries do not.
 */
function selftestCases(src, consts) {
  const marks = [...src.matchAll(/(^|\n)[ \t]*(?:it|describe)(?:\.each\((?:[^)]|\n)*?\))?\(/g)];
  const cases = [];
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k];
    if (!/\bit\b/.test(m[0])) continue;
    const from = m.index + m[0].length;
    const body = src.slice(from, k + 1 < marks.length ? marks[k + 1].index : src.length);
    const marksAt = [...body.matchAll(/['"`]selftest['"`]/g)];
    if (!marksAt.length) continue;
    // ONLY the scripts this case RUNS, never the ones it merely reads. content-engine-sync.test.js's
    // spotify case reads publish.py's source two assertions later, which costs no wall time at all;
    // counting it would raise a budget on work that is not done. So the scripts are taken from the
    // window around each `'selftest'` argument, which is where the command is built.
    const scripts = new Set();
    for (const sm of marksAt) {
      const win = body.slice(Math.max(0, sm.index - 300), sm.index + 200);
      for (const x of win.matchAll(/['"]([\w.-]+\.py)['"]/g)) scripts.add(x[1]);
      for (const [name, py] of consts) {
        if (new RegExp('\\b' + name + '\\b').test(win)) scripts.add(py);
      }
      // The loop header of `for (const s of ['a.py','b.py']) { it(s, ...) }` sits just above the case.
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const loop = [...before.matchAll(/for\s*\((?:const|let)\s+(\w+)\s+of\s+\[([^\]]*)\]/g)].pop();
      if (loop && new RegExp('\\b' + loop[1] + '\\b').test(win)) {
        for (const x of loop[2].matchAll(/['"]([\w.-]+\.py)['"]/g)) scripts.add(x[1]);
      }
    }
    // The budget is the last argument of the it(...) call: `it('x', () => { ... }, 120000);`
    const tail = [...body.matchAll(/\}\s*,\s*(\d+)\s*\)\s*;/g)].pop();
    cases.push({ line: src.slice(0, m.index).split('\n').length + 1, scripts,
                 timeout: tail ? Number(tail[1]) : null });
  }
  return cases;
}

describe('the selftest budget covers every case that pays for ffmpeg', () => {
  const ffmpeg = ffmpegScripts();
  const files = readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js')).sort();

  it('the scan finds the cases this bug was measured on', () => {
    // A guard that matches nothing reads as a pass for ever. These are the wrappers the incident and
    // its review named, so if the scan stops seeing them it is broken, not clean.
    expect(ffmpeg.has('qa.py') && ffmpeg.has('overlays.py') && ffmpeg.has('stab.py')).toBe(true);
    const seen = [];
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, 'tests', f), 'utf8');
      for (const c of selftestCases(src, scriptConsts(src))) {
        if ([...c.scripts].some((s) => ffmpeg.has(s))) seen.push(f);
      }
    }
    for (const f of ['content-engine.test.js', 'content-engine-stab-fps.test.js',
                     'content-engine-render.test.js', 'content-engine-approval.test.js']) {
      expect(seen).toContain(f);
    }
  });

  it('every case that runs an ffmpeg-driven selftest declares at least 120s', () => {
    const thin = [];
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, 'tests', f), 'utf8');
      for (const c of selftestCases(src, scriptConsts(src))) {
        const paid = [...c.scripts].filter((s) => ffmpeg.has(s) && existsSync(path.join(CE, s)));
        if (!paid.length) continue;
        if (c.timeout === null || c.timeout < SELFTEST_BUDGET_MS) {
          thin.push(`${f}:${c.line} runs ${paid.join(', ')} on ${c.timeout === null ? 'the 30s default' : c.timeout + 'ms'}`);
        }
      }
    }
    expect(thin).toEqual([]);
  });
});
