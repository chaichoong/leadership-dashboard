// A corrected distance must say WHICH figure it is, because the copy carries two of them.
//
// Regression origin: 24 Oct 2026 (finding 20261024-phase-3-1060). check_km corrects a wrong
// distance either to the mission total covered so far or to the km left of the 40,075km lap,
// whichever the sentence's direction word asks for — and reported both with one wording,
// "is not the day's Strava figure; corrected to X". So every episode's report carried two
// "corrected" distances that cannot both be one distance: 2132 said 16,383km and 23,692km,
// 2121 said 16,304km and 23,771km (each pair sums to exactly 40,075). The km-remaining one read
// as a verified distance about 5,800km past the whole lifetime Runpreneur total (17,879.93km on
// 23 Oct 2026) for an episode recorded seven months earlier, in philanthropy copy sitting in a
// card awaiting approval, where the standing rule is accuracy over hype. The figures were right;
// the sentence describing them was not, and "corrected" made the wrong reading look verified.
//
// Driven against the real platform_copy.rules_check.
//
// Back-tested: restoring the single "is not the day's Strava figure" wording turns both tests red.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CE = resolve(__dirname, '../scripts/content-engine');

function issues(copy, km) {
  const out = execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(CE)})
import platform_copy as pc
fixed, issues = pc.rules_check({"LinkedIn Copy": ${JSON.stringify(copy)}}, "", km=${km})
print(json.dumps({"text": fixed["LinkedIn Copy"], "issues": issues}))`], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out);
}

describe('the copy checker names the figure it corrected', () => {
  it('reports the covered figure and the remaining figure as different things', () => {
    // Episode 2121's real pair: 16,304km covered, 23,771km of the lap left.
    const got = issues('Day 2121. 20,690km in, 19,385km still to go.', 16304.0);
    expect(got.issues).toHaveLength(2);
    expect(got.text).toContain('16,304km in');
    expect(got.text).toContain('23,771km still to go');

    const covered = got.issues.find((i) => i.includes('16,304km'));
    const remaining = got.issues.find((i) => i.includes('23,771km'));
    expect(covered).toMatch(/km covered so far/);
    expect(remaining).toMatch(/km left of the 40,075km lap/);
    expect(covered).not.toBe(remaining);

    // Neither may call a figure "the day's Strava figure": the copy states no single-day distance here,
    // and that wording is what made 23,771km read as one.
    for (const i of got.issues) expect(i).not.toMatch(/the day's Strava figure/);
  });

  it('a figure with no direction word is reported as the covered total', () => {
    const got = issues('I have run 20,690km.', 16304.0);
    expect(got.issues).toHaveLength(1);
    expect(got.issues[0]).toMatch(/km covered so far/);
    expect(got.issues[0]).toContain('16,304km');
  });
});
