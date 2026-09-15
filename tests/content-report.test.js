// Content Engine: the daily publishing report (Kevin, 15 Sep 2026: "I need some kind of reporting protocol so I can
// see what's been published each day and what's scheduled to be published"). One Airtable row, two readers: the
// Publishing page and the 08:00 DM. These tests keep the writer, the row's guard and both readers pointing at one row.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const report = read('scripts/content-engine/content_report.py');

describe('content publishing report', () => {
  it('passes its selftest (seven days listed including empty ones, absence said in the headline, one-row write)', () => {
    const out = JSON.parse(execFileSync('python3', [path.join(DIR, 'content_report.py'), 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
  });

  it('writes the Estate Status field ids the status writer uses', () => {
    const estate = read('scripts/estate-status.py');
    for (const [k, id] of report.match(/"(\w+)": "(fld\w+)"/g).map(s => s.match(/"(\w+)": "(fld\w+)"/).slice(1))) {
      expect(estate, `${k} ${id}`).toContain(`"${k}":`);
      expect(estate).toContain(`"${id}"`);
    }
  });

  it('the 10-minute status writer never marks the report row Idle', () => {
    expect(read('scripts/estate-status.py')).toMatch(/REPORT_ROWS_OWNED_ELSEWHERE = \([^)]*"content-publishing"/);
    expect(report).toContain('KEY = "content-publishing"');
  });

  it('both jobs write it, and a failed write never stops a job', () => {
    for (const sh of ['scripts/content-engine-publish.sh', 'scripts/content-engine-run.sh']) {
      expect(read(sh)).toMatch(/content_report\.py write \|\| echo/);
    }
  });

  it('the Publishing page and the 08:00 DM read the same row', () => {
    expect(read('publishing.html')).toContain("const REPORT_KEY = 'content-publishing'");
    expect(read('scripts/slack-automation/approvals.js')).toContain("'content-publishing'");
  });
});
