import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const FETCHER = join(process.env.HOME, '.claude/skills/transcript-to-brain/scripts/fetch_loom_transcript.py');

// ── SAYING IT IS EASIER THAN TYPING IT (28 Aug 2026) ───────────────────────
//
// Kevin asked whether he could attach a Loom to his approval feedback and have
// the agent actually understand it — not just receive a link.
//
// Loom serves an auto-generated transcript from a PUBLIC GraphQL endpoint, so
// this works from a headless run with no login and no browser allowlist entry.
// The fetcher already existed for transcript-to-brain and was BROKEN: Loom had
// removed the `id` field from VideoTranscriptDetails, so the query failed
// GRAPHQL_VALIDATION_FAILED for EVERY video, not just a missing one.

function py(code) {
  return JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
${code}`], { encoding: 'utf8' }));
}

const expand = (t) => py(`print(json.dumps({"out": ad.expand_looms(${JSON.stringify(t)})}))`).out;

describe('the Loom fetcher asks for fields that still exist', () => {
  it('does not request `id`, which Loom removed', () => {
    // THE BUG. With `id` in the selection set the endpoint answers
    // "Cannot query field \"id\" on type \"VideoTranscriptDetails\"" and the
    // whole fetcher returns nothing — for every video, silently, for as long
    // as nobody tried it.
    expect(existsSync(FETCHER), 'the Loom fetcher is missing').toBe(true);
    const src = readFileSync(FETCHER, 'utf8');
    const q = src.match(/on VideoTranscriptDetails \{([^}]+)\}/);
    expect(q, 'could not find the transcript selection set').toBeTruthy();
    expect(q[1]).not.toMatch(/\bid\b(?!eo)/);
    // CONTROL: the fields it does use must still be there, or this asserts
    // nothing by asserting on an empty set.
    expect(q[1]).toContain('source_url');
    expect(q[1]).toContain('captions_source_url');
  });
});

describe('feedback with no Loom link is untouched', () => {
  it('returns the exact same string, so the common case costs nothing', () => {
    const t = 'Send from kevinbrittain@gmail.com and sign as my name only.';
    expect(expand(t)).toBe(t);
  });

  it('a bare mention of loom is not a link', () => {
    const t = 'I explained this on a loom call last week.';
    expect(expand(t)).toBe(t);
  });

  it('handles empty and null feedback without reaching for the network', () => {
    expect(expand('')).toBe('');
  });
});

describe('a Loom that cannot be read is said OUT LOUD', () => {
  // The rule that decides whether this feature is safe. If a failed fetch
  // silently carried on as the typed words alone, Kevin would believe his
  // video was taken into account when it never was, and he would have no way
  // to tell. That is worse than not offering the feature at all.
  const out = expand('Watch this: https://www.loom.com/share/00000000000000000000000000000000 and redo it.');

  it('keeps what he typed', () => {
    expect(out).toContain('and redo it.');
  });

  it('states plainly that the video was not read', () => {
    expect(out).toMatch(/LOOM COULD NOT BE READ/);
  });

  it('gives the reason, so the failure is diagnosable', () => {
    expect(out).toMatch(/Reason: .+/);
  });

  it('tells the agent NOT to guess what the video said', () => {
    expect(out).toMatch(/Do NOT guess/);
    expect(out).toMatch(/say plainly in your output/);
  });
});

describe('the feedback the agent reads is the expanded version', () => {
  it('the queue view expands before handing feedback to an agent', () => {
    // A redo is the case that matters most: the agent is being told what to
    // change, and a bare URL tells it nothing.
    const src = readFileSync(DISPATCH, 'utf8');
    expect(src).toMatch(/"feedback": expand_looms\(/);
  });

  it('Kevin is told the option exists', () => {
    // A capability nobody is told about is a capability nobody uses — the same
    // lesson as the Slack reason words.
    const page = readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
    expect(page).toMatch(/Paste a Loom link/);
  });
});
