// Content Engine R7 + R8: platform copy (scripts/content-engine/copy.py) with the rules check.
// The prompts are the Content Machine app's own, lifted verbatim into cm_prompts.py; these tests
// pin that the lift is intact (Kevin's voice rules, fixed hashtags, section labels) and that the
// rules check still fixes em dashes and reports, never rewrites, everything else.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const COPY = path.join(DIR, 'copy.py');
const PROMPTS = path.join(DIR, 'cm_prompts.py');

describe('content-engine copy', () => {
  it('passes its own selftest (prompt fill, section split, rules check)', () => {
    const out = JSON.parse(execFileSync('python3', [COPY, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(12);
  });

  it("keeps the Content Machine's system prompt intact: Kevin's voice rules and the fixed hashtags", () => {
    // read through Python so the repr escapes in cm_prompts.py do not matter
    const p = execFileSync('python3', ['-c', 'import cm_prompts as p, json; print(json.dumps({"s": p.KEVIN_SYSTEM, "u": p.USER_PROMPTS}))'],
      { encoding: 'utf8', cwd: DIR });
    const { s, u } = JSON.parse(p);
    expect(s).toContain('You are Kevin Brittain. Write entirely in first person.');
    expect(s).toContain('#ukrunnerscommunity #runnerslifestyle #ultrarunninglife #runformentalhealth #strava #stravarun #Insta360 #vibramfivefingers');
    expect(s).toMatch(/amazing, incredible journey, crushing it, smashing goals/);
    expect(Object.keys(u).sort()).toEqual(['Learnings From My Diary', 'Long Form Video', 'Short Form Video']);
    for (const label of ['FACEBOOK REELS POST', 'INSTAGRAM REELS POST', 'YOUTUBE FULL POST', 'PODCAST POST', 'BLOG META DESCRIPTION']) {
      expect(JSON.stringify(u), label).toContain(label);
    }
  });

  it('writes to the same fields the team\'s Copywriting page reads, per content type', () => {
    const src = readFileSync(COPY, 'utf8');
    for (const f of ['Blog Copy', 'Blog Post Description', 'YouTube Copy', 'Podcast Copy', 'Facebook Post Copy', 'Instagram Post Copy',
      'LinkedIn Copy', 'Threads Copy', 'X / Twitter Copy', 'TikTok Copy', 'YouTube Reels Copy', 'Facebook Reels Copy', 'Instagram Reels Copy']) {
      expect(src, f).toContain(`"${f}"`);
    }
    expect(src).toMatch(/STATUS_COPIES = "Copies in Progress"/);
  });

  it('calls Claude the way the other headless agents do: claude -p, OAuth token from the config file, standard tier, no tools', () => {
    const src = readFileSync(COPY, 'utf8');
    expect(src).toContain('TOKEN_FILE = os.path.expanduser("~/.config/od/claude_oauth_token")');
    expect(src).toContain('"--tools", ""');
    expect(src).toMatch(/MODEL = "sonnet"/);
    expect(src).not.toMatch(/x-api-key/);
  });

  it('rules check: em dashes fixed in place, everything else reported for review (never silently rewritten)', () => {
    const src = readFileSync(COPY, 'utf8');
    expect(src).toContain('em dash replaced');
    expect(src).toContain('LIMITS = {"Threads Copy": 500, "X / Twitter Copy": 300}');
    expect(src).toContain('REVIEW: ');
  });
});
