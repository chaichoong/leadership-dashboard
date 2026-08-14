// Guards the worklist selection in scripts/agent-dispatch.py.
//
// THE BUG THIS EXISTS FOR (14 Aug 2026)
// The cap applied to the whole worklist and hand-backs sorted to the head of it.
// All 5 slots went to carrying out already-approved work, so the 8 inbound
// messages picked up the day before were never drafted: empty Agent Output,
// never sent for approval. Nothing new reached the approval queue between
// 12 and 14 Aug, and Kevin reported "I'm not seeing anything new".
//
// It is self-sustaining, which is why it needs a test rather than vigilance:
// while there are CAP_PER_RUN hand-backs waiting, new work is never reached, so
// no new approvals are produced, so next run has nothing to do but more
// hand-backs. Back-tested — reverting select_worklist to `combined[:CAP]` makes
// "never starves new work" fail.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// Import the real module by path and call the real function. Copying the
// selection logic into the test would let the two drift apart, which is exactly
// how the recon-accuracy check ended up asserting nothing.
function select(handbacks, newWork, deferred, cap, floor) {
  const script = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("dispatch", ${JSON.stringify(DISPATCH)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
args = json.loads(sys.argv[1])
def mk(prefix, n):
    return [{"id": f"{prefix}{i}"} for i in range(n)]
out = mod.select_worklist(
    mk("hb", args["handbacks"]), mk("new", args["newWork"]), mk("def", args["deferred"]),
    cap=args.get("cap"), floor=args.get("floor"))
print(json.dumps({"ids": [t["id"] for t in out],
                  "cap": mod.CAP_PER_RUN, "floor": mod.NEW_WORK_FLOOR}))
`;
  const raw = execFileSync('python3', ['-c', script,
    JSON.stringify({ handbacks, newWork, deferred, cap, floor })], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const countOf = (ids, prefix) => ids.filter(id => id.startsWith(prefix)).length;

describe('agent-dispatch worklist selection', () => {
  it('never starves new work, however many hand-backs are queued', () => {
    // The exact 14 Aug shape, scaled up: far more hand-backs than the cap.
    const { ids } = select(100, 8, 0, 25, 10);
    expect(ids).toHaveLength(25);
    expect(countOf(ids, 'new')).toBe(8); // every new item got a slot
    expect(countOf(ids, 'hb')).toBe(17);
  });

  it('reproduces the original failure when the floor is removed', () => {
    // floor 0 is the old behaviour. If this ever passes with new work included,
    // the floor is not doing anything and the other tests are lying.
    const { ids } = select(100, 8, 0, 25, 0);
    expect(countOf(ids, 'new')).toBe(0);
  });

  it('caps new work at the floor when there is a lot of it', () => {
    const { ids } = select(100, 500, 0, 25, 10);
    expect(countOf(ids, 'new')).toBe(10);
    expect(countOf(ids, 'hb')).toBe(15);
  });

  it('gives unused new-work slots back to hand-backs', () => {
    // Only 2 new items, so 8 of the 10 held slots must not go to waste.
    const { ids } = select(100, 2, 0, 25, 10);
    expect(ids).toHaveLength(25);
    expect(countOf(ids, 'new')).toBe(2);
    expect(countOf(ids, 'hb')).toBe(23);
  });

  it('picks up deferred work only when nothing else fills the run', () => {
    expect(countOf(select(30, 30, 5, 25, 10).ids, 'def')).toBe(0);
    const quiet = select(2, 1, 5, 25, 10);
    expect(countOf(quiet.ids, 'def')).toBe(5);
    expect(quiet.ids).toHaveLength(8);
  });

  it('returns no duplicates when handing unused slots back', () => {
    const { ids } = select(30, 1, 3, 25, 10);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('degrades safely on empty and zero-cap input', () => {
    expect(select(0, 0, 0, 25, 10).ids).toEqual([]);
    expect(select(50, 50, 50, 0, 10).ids).toEqual([]);
  });

  it('is actually wired into the queue builder, not just defined', () => {
    // Without this, reverting the call site to `combined[:CAP_PER_RUN]` leaves
    // every test above passing while production starves new work again.
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    expect(src).toMatch(/worklist\s*=\s*select_worklist\(/);
    expect(src).not.toMatch(/worklist\s*=\s*combined\[:\s*CAP_PER_RUN\s*\]/);
  });

  it('ships a cap and floor that actually raise throughput', () => {
    // The whole point of the change. If someone drops the cap back to 5 the
    // starvation returns, because the floor would exceed the cap.
    const { cap, floor } = select(1, 1, 0);
    expect(cap).toBeGreaterThanOrEqual(50);
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(cap);
  });

  it('is a ceiling, not a target — a short queue runs in full and no more', () => {
    // A high cap must cost nothing on a quiet day. If this ever returns padding
    // or throws, the cap has become something other than an upper bound.
    const { ids } = select(3, 2, 0);
    expect(ids).toHaveLength(5);
    expect(countOf(ids, 'hb')).toBe(3);
    expect(countOf(ids, 'new')).toBe(2);
  });

  it('clears the whole eligible queue at the shipped cap', () => {
    // Measured live on 14 Aug: 37 eligible (25 worklist + 12 reserve) at cap 25,
    // so 12 waited a day for nothing. At the shipped cap the backlog clears.
    const { ids } = select(10, 27, 0);
    expect(ids).toHaveLength(37);
  });
});
