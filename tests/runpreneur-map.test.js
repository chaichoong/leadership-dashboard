// The Runpreneur map page and its nightly data (scripts/content-engine/runpreneur_map.py). The pure parts
// (route scaling, point along the lap, point-in-polygon with holes, the equivalence and milestone rules,
// pre-streak runs excluded) run through the script's selftest; the checks below pin the privacy rule and
// the publish route.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const MAP = path.join(DIR, 'runpreneur_map.py');

describe('runpreneur map', () => {
  it('passes its own selftest', () => {
    const out = JSON.parse(execFileSync('python3', [MAP, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(12);
  });

  it('publishes only countries and totals: no run start point ever reaches the JSON', () => {
    const src = readFileSync(MAP, 'utf8');
    expect(src).not.toMatch(/"latlng":\s*r\[/);
    expect(src).toContain('"countries": [{"name": c, "runs": n} for c, n in countries]');
    expect(src).toContain('branch": "main"');
  });

  it('the page reads the nightly JSON and the outlines, uses the Runpreneur colours, and is on the nightly run', () => {
    const html = readFileSync(path.join(ROOT, 'runpreneur-map', 'index.html'), 'utf8');
    expect(html).toContain("fetch('data/progress.json");
    expect(html).toContain("fetch('data/countries.geojson')");
    expect(html).toContain('--orange:#EC7B27');
    expect(existsSync(path.join(ROOT, 'runpreneur-map', 'data', 'countries.geojson'))).toBe(true);
    expect(readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8')).toContain('runpreneur_map.py run');
  });
});
