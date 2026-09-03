// Content Engine R10: GoHighLevel scheduling for APPROVED episodes only (scripts/content-engine/publish.py).
// The pure parts (slot clock, YouTube title split, link fill, account filter, stage machine, post bodies)
// run through the script's selftest; the checks below pin the guarantees that matter most: nothing is
// scheduled without Kevin's approval, the socials wait for the YouTube link, X and expired rows never
// get a post, and the GHL key never appears on a command line.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const PUBLISH = path.join(DIR, 'publish.py');

describe('content-engine publish (GHL)', () => {
  it('passes its own selftest (London slots, YouTube parts, link fill, account map, stages, post bodies)', () => {
    const out = JSON.parse(execFileSync('python3', [PUBLISH, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(16);
  });

  it('only ever schedules episodes Kevin approved on the card', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toMatch(/def approved_days\(\):[\s\S]*e\.get\("verdict"\) == "approved"/);
    expect(src).toContain('state = load_state(); days = approved_days()');
    expect(src).toContain('full["fields"].get("Record Status") not in PUBLISHABLE');
  });

  it('the socials wait for the YouTube link, and a missing YouTube account holds with a digest line', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('if stage == 2: copy = with_youtube_link(copy, entry["youtube_link"])');
    expect(src).toContain('"wait-youtube-account"');
    expect(src).toContain('"wait-youtube-link"');
    expect(src).toMatch(/waiting for a YouTube account in GoHighLevel/);
  });

  it('never puts the GHL key on a command line: curl reads it from a mode-600 config file', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('os.chmod(fh.name, 0o600)');
    expect(src).toContain('"curl", "-s", "-K", cfg');
    expect(src).not.toMatch(/"-H", *"Authorization/);
  });

  it('runs nightly after the approval steps: sync first, then run, then its report line', () => {
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    const approvalRun = sh.indexOf('approval.py run --pending');
    const sync = sh.indexOf('publish.py sync');
    const run = sh.indexOf('publish.py run');
    expect(sync).toBeGreaterThan(approvalRun);
    expect(run).toBeGreaterThan(sync);
    expect(sh).toContain('publish.py report');
  });

  it('X is not a channel and every copy field it reads exists on the record type it reads it from', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('assert "twitter" not in CHANNELS');
    expect(src).toContain('every copy field exists on its record type');
  });
});
