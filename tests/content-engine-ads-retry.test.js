import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { legacy, REMINT_AFTER, ROUNDS } = require(resolve(ROOT, 'scripts/content-engine/youtube_ads.js'));

// The retry loop of the bulk ad backfill, driven without a browser.
//
// It needs to be drivable. On 20 Sep 2026 the 923-video legacy backfill reported 34 videos still on
// legacy ad settings, and not one of them had ever been minted — so the retry rounds had not reached
// them. With no way to exercise the loop, that could only be guessed at, and re-running the identical
// command converted all 34 (32 replays, 1 UI save, 1 already modern). The loop had no test at all,
// which is exactly why a silent miss survived a result that looked complete.
//
// Two things are guarded here. The re-mint budget has to be low enough that a whole channel converts
// without relying on the retry (an attestation stops taking effect silently — the write still answers
// 200). And a read-back that does not return an id must be counted as UNKNOWN and named, because a
// short read is otherwise indistinguishable from a batch that refuses to convert.

const ids = (n) => Array.from({ length: n }, (_, i) => 'v' + i);

// One attestation that silently stops working after `staleAfter` replays, and a read-back that can be
// made to return only part of what it was asked about.
function fakeStudio({ staleAfter = 96, readFraction = 1 } = {}) {
  const converted = new Set();
  let used = 0, mints = 0;
  return {
    get mints() { return mints; },
    ops: {
      mint: async (_p, id) => { mints++; converted.add(id); used = 0; return { tok: mints }; },
      replay: async (_p, _upd, id, what) => {
        if (what.adFormats) { used++; if (used <= staleAfter) converted.add(id); }
      },
      read: async (_p, todo) => {
        const out = {};
        for (const id of todo.slice(0, Math.ceil(todo.length * readFraction))) {
          out[id] = converted.has(id) ? { adFormats: { hasSkippableVideoAds: true } } : { adFormats: {} };
        }
        return out;
      },
    },
  };
}

describe('the bulk ad backfill retry', () => {
  it('re-mints often enough to convert a whole channel in one round', async () => {
    // 923 is the real size of the pre-2024 back catalogue
    const s = fakeStudio();
    const r = await legacy(null, ids(923), false, s.ops);
    expect(r.stillLegacy).toEqual([]);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]).toMatchObject({ round: 1, tried: 923, converted: 923, left: 0, unread: 0 });
    expect(REMINT_AFTER).toBeLessThan(96);   // the point: never lean on the retry for the common case
  });

  it('would have failed at the old budget, which is what produced the 34 stragglers', async () => {
    // an attestation that goes stale after 96 replays, trusted for 120, leaves the tail of every window
    const s = fakeStudio({ staleAfter: 40 });   // a harsher stale point stands in for REMINT_AFTER=120
    const r = await legacy(null, ids(400), false, s.ops);
    expect(r.rounds.length).toBeGreaterThan(1);       // the retry has to carry it
    expect(r.rounds[0].left).toBeGreaterThan(0);
  });

  it('mints a straggler on the next round rather than replaying at it for ever', async () => {
    const s = fakeStudio({ staleAfter: 10 });
    const r = await legacy(null, ids(60), false, s.ops);
    const minted = Object.entries(r.done).filter(([, v]) => v === 'ui-save').map(([k]) => k);
    expect(minted.length).toBeGreaterThan(1);
    expect(r.rounds.length).toBeGreaterThan(1);
    // every round that ran reports what it actually achieved
    for (const round of r.rounds) expect(round).toHaveProperty('converted');
  });

  it('counts and names ids the read-back never returned, instead of calling them unconverted', async () => {
    // This is the half that was missing. A short read leaves ids in `todo` looking exactly like a video
    // that will not convert, and the result gives no way to tell the two apart.
    const s = fakeStudio({ readFraction: 0.5 });
    const r = await legacy(null, ids(100), false, s.ops);
    expect(r.rounds[0].unread).toBeGreaterThan(0);
    expect(r.rounds[0].unreadSample.length).toBeGreaterThan(0);
    // and an unread id is never counted as converted
    expect(r.rounds[0].converted).toBeLessThanOrEqual(r.rounds[0].tried - r.rounds[0].unread);
  });

  it('gives up after a fixed number of rounds rather than looping for ever', async () => {
    const s = fakeStudio({ staleAfter: 0 });     // nothing a replay does ever lands
    const r = await legacy(null, ids(50), false, s.ops);
    expect(r.rounds).toHaveLength(ROUNDS);
    expect(r.stillLegacy.length).toBeGreaterThan(0);   // reported honestly, not hidden
  });

  it('does nothing at all on a dry run', async () => {
    const s = fakeStudio();
    const r = await legacy(null, ids(10), true, s.ops);
    expect(r.dry).toBe(true);
    expect(r.would).toBe(10);
    expect(s.mints).toBe(0);
  });
});
