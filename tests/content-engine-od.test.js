// Content Engine, Operations Director lane (scripts/content-engine/od_lane.py + od_prompts.py + od_card.py, plan
// approved by Kevin 3 Sep 2026). The pure parts (classifier gate, slot fill, rules check, card text, verdict
// minutes) run through each script's selftest; the checks below pin the wiring and the two rulings that
// would fail silently if they drifted: the brand guard (an OD post can only ever reach the OD page) and the
// playbook's locked facts (pricing, hot-buttons) that the prompt copies.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const selftest = (file, min) => {
  const out = JSON.parse(execFileSync('python3', [path.join(DIR, file), 'selftest'], { encoding: 'utf8', cwd: DIR }));
  expect(out.failed).toEqual([]);
  expect(out.checks).toBeGreaterThanOrEqual(min);
};

describe('content-engine OD lane', () => {
  it('od_lane selftest: gate, sources, rules check, usefulness, cards, newsletter, topics', () => selftest('od_lane.py', 62));
  it('od_prompts selftest: the brief in every prompt, shapes, visual split, voice profile loader', () => selftest('od_prompts.py', 12));
  it('od_infographic selftest: five templates, escaping, a real render', () => selftest('od_infographic.py', 9), 120000);
  it('od_illustrate selftest: Gemini prompt, required lines, the text check, no-key fallback', () => selftest('od_illustrate.py', 13));
  it('od_board selftest: five boards from the lead magnet components, one hero each, no name, a real render', () => selftest('od_board.py', 10), 180000);
  it('od_compose selftest: the vendored Epic Infographics method, the OD design language, the preflight checker runs', () => selftest('od_compose.py', 18), 180000);
  // 10s, not the 5s default: the selftest genuinely needs ~3.1s, and it went red once
  // on the 25 Sep fixer run with 203 test files sharing 8 cores while passing in
  // isolation (finding 20260925-queue-fixer-612). A flaky red on the pre-push gate is
  // what teaches people to reach for SKIP_SYNC_TESTS=1.
  it('publish selftest including the brand guard (cross-brand refused by name)', () => selftest('publish.py', 32), 10000);

  // A selftest that reaches the network is not a selftest, it is a flaky gate. publish.py's
  // stubbed blog left the article PUBLISHED with no read_time, which is exactly the state that
  // sent the REAL blog.ensure_reading_time to GHL over the wire; finish_extras swallowed the
  // 404 so it passed anyway, spending ~3.5s on live HTTP and failing the fixer gate whenever
  // the network or GHL misbehaved (finding 20260919-queue-fixer-555).
  // Blocked is a BaseException on purpose: an ordinary Exception is caught by the very
  // `except Exception` that hid this for weeks. Back-tested — restoring the live call makes
  // this exit 1.
  it('the publish selftest makes no network call at all', () => {
    const guard = [
      'import socket, sys, runpy',
      'class Blocked(BaseException): pass',
      'def _no(*a, **k): raise Blocked("a selftest must not touch the network")',
      'socket.socket.connect = _no',
      'socket.socket.connect_ex = _no',
      'socket.create_connection = _no',
      'socket.getaddrinfo = _no',
      'sys.argv = ["publish.py", "selftest"]',
      'runpy.run_path("publish.py", run_name="__main__")',
    ].join('\n');
    const out = execFileSync('python3', ['-c', guard], { encoding: 'utf8', cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    const last = out.trim().split('\n').pop();
    expect(JSON.parse(last).failed).toEqual([]);
  });

  it('the prompt copies the playbook exactly: locked pricing and the five hot-buttons in the customers\' words', () => {
    const playbook = readFileSync(path.join(ROOT, 'docs', 'content-engine-playbook.md'), 'utf8');
    const prompts = readFileSync(path.join(DIR, 'od_prompts.py'), 'utf8');
    expect(playbook).toMatch(/£1,500 setup, £350\/mo, 30-day/);
    expect(prompts).toContain('£1,500 setup, £350 a month, 30-day trial');
    for (const words of ['My business is me.', 'Not enough hours in my day.', "I can't tell you my profit.", "Worst thing I've done."]) {
      expect(playbook).toContain(words);
      expect(prompts).toContain(words);
    }
    expect(prompts).toMatch(/Never mention running/);
    expect(prompts).toMatch(/AI agents to do 90% of the everyday work/);
    expect(prompts).toMatch(/===VISUAL===/);
    expect(prompts).not.toMatch(/linkedin history as (a )?voice/i);
  });

  it('brand map: OD may reach only pages named Operations Director, never a profile, TikTok or a Runpreneur page; keys differ', () => {
    const src = readFileSync(path.join(DIR, 'publish.py'), 'utf8');
    const od = src.slice(src.indexOf('"Operations Director": {"key"'), src.indexOf('}\n\n\ndef brand_of'));
    expect(od).toContain('ghl_social_key_od');
    expect(od).toMatch(/\("linkedin", "page", "Operations Director"\)/);
    expect(od).toMatch(/\("facebook", "page", "Operations Director"\)/);
    expect(od).not.toMatch(/"profile"/);
    expect(od).not.toMatch(/tiktok/);
    expect(od).not.toMatch(/"Runpreneur"\)/);
  });

  it('the nightly job runs the OD lane after the Runpreneur lane and never lets it stop the Runpreneur lane', () => {
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    for (const step of [' mine --limit', ' sync', ' draft', ' cards', ' publish-sync', ' publish ', ' newsletter-publish', ' topics', ' report']) {
      expect(sh).toContain('od_lane.py' + step);
    }
    const odLines = sh.split('\n').filter(l => l.includes('od_lane.py') && !l.includes('report') && !l.trim().startsWith('#'));
    for (const l of odLines) expect(l).toMatch(/\|\| echo/);
    expect(sh.indexOf('od_lane.py mine')).toBeGreaterThan(sh.indexOf('publish.py run'));
  });

  it('the OD card lands under the Operations Director business, the Runpreneur card under Personal', () => {
    const lane = readFileSync(path.join(DIR, 'od_lane.py'), 'utf8');
    const appr = readFileSync(path.join(DIR, 'approval.py'), 'utf8');
    expect(lane).toContain('BUSINESS_OD = "reca9ofzhuw13ZzGE"');
    expect(appr).toContain('BUSINESS_PERSONAL = "reclAPC2vMx2Umuzb"');
    expect(lane).toMatch(/CONTENT \(OD\):/);
  });

  it('v2 rulings hold in code: threshold 6 with the agent-only rule, no bridge posts, no blank quote card, newsletter on the personal profile via the browser lane', () => {
    const lane = readFileSync(path.join(DIR, 'od_lane.py'), 'utf8');
    expect(lane).toMatch(/AI_THRESHOLD, BANK_DAYS, MAX_MOMENTS, TOPIC_DAYS, TOPIC_COUNT = 3\.0, 6,/);
    expect(lane).not.toMatch(/bridge_text/);
    expect(lane).not.toMatch(/od_card/);
    expect(lane).toMatch(/"profile": "linkedin"/);
    expect(lane).toMatch(/agent-browser\.js/);
    expect(readFileSync(path.join(DIR, 'od_infographic.py'), 'utf8')).toMatch(/tokens\.css/);
  });
});
