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
    expect(out.checks).toBeGreaterThanOrEqual(22);
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

  it('starts in TEST mode and can only go live when Kevin writes the mode file: unlisted YouTube, drafts for the socials', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('MODE_FILE = os.path.expanduser("~/.config/od/content_engine_mode")');
    expect(src).toContain('return "live" if m == "live" else "test"');
    expect(src).toContain('status = "scheduled" if (not test or platform == "youtube") else "draft"');
    expect(src).toContain('privacy="unlisted" if test else "public"');
  });

  it("writes the link fields Ericamae's QC and Ready pages read, on the Full record and the clip's own record", () => {
    const src = readFileSync(PUBLISH, 'utf8');
    for (const f of ['"YouTube Link"', '"TikTok Link"', '"Facebook Post Link"', '"Instagram Post Link"', '"LinkedIn Link"', '"Threads Link"']) expect(src).toContain(f);
    expect(src).toContain('clip_links.setdefault(p["clip"], {})');
    expect(src).toContain('fields["Video Title"] = yt_title; fields["Target Publish Date"]');
  });

  it('publishes the blog article through the GHL Blog API at stage 2 (draft in test mode) and passes its selftest', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('pid, url = blog.publish_blog(day, full, entry, media.get("thumb"), entry["youtube_link"], test)');
    expect(src).toContain('fields["Blog Link"] = url');
    const out = JSON.parse(execFileSync('python3', [path.join(DIR, 'blog.py'), 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    const blog = readFileSync(path.join(DIR, 'blog.py'), 'utf8');
    expect(blog).toContain('"DRAFT" if test else "PUBLISHED"');
    expect(blog).toContain('BLOG_ID = "YvavGIzJ2jDX8gs9CjYZ"');
  });

  it('skips a clip that was never made (no diary section that day) instead of failing the whole stage', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('if spec["clip"] != "full" and not os.path.exists(episode_files(day)[spec["clip"]])');
  });

  it('posts the Learnings clip to YouTube as a Short with the socials, title from the first copy line', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('"youtube-short": {"platform": "youtube"');
    expect(src).toContain('"yt_type": "short"');
    expect(src).toContain('("youtube", "lfmd"): ("Link of Youtube Shorts",)');
  });

  it('X is not a channel and every copy field it reads exists on the record type it reads it from', () => {
    const src = readFileSync(PUBLISH, 'utf8');
    expect(src).toContain('assert "twitter" not in CHANNELS');
    expect(src).toContain('every copy field exists on its record type');
  });
});
