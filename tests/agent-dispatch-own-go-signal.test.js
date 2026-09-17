import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SRC = readFileSync(DISPATCH, 'utf8');

// 16 Sep 2026. Kevin approved the Content Engine's cards for episodes 2057 and 2058. The engine's own hourly job
// publishes approved episodes, but the hand-back poll ALSO took both cards as carry-outs: a headless Claude run
// drove publish.py by hand, its command time limit killed each YouTube upload part way, the next attempt adopted the
// half-uploaded videos with no publish time (so the record never flipped to published and the Publishing page said
// nothing went out), and 2058's Short was left stuck "processing" on the channel. An agent on its own Go Signal
// (`dispatch: False`) carries out its own cards; the dispatcher lists them under ownGoSignal and never works them.
function py(snippet) {
  const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('an agent on its own Go Signal is never handed its own approved cards', () => {
  it('the Content Engine is its own Go Signal; a dispatchable agent is not', () => {
    const r = py(`
engine = [k for k, v in m.ROLE_AGENTS.items() if v.get("agent") == "content-engine"][0]
dispatchable = [k for k, v in m.ROLE_AGENTS.items() if v.get("dispatch", True)][0]
print(json.dumps({"engine": m.own_go_signal(engine), "other": m.own_go_signal(dispatchable), "blank": m.own_go_signal(""), "unknown": m.own_go_signal("recNOTANAGENT")}))
`);
    expect(r).toEqual({ engine: true, other: false, blank: false, unknown: false });
  });

  it('the check sits before an approved task becomes a hand-back, and the queue lists what it held', () => {
    const at = SRC.indexOf('own_go_signal(t["agentId"])');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(SRC.indexOf('approved_hb.append(t)'));
    expect(SRC).toMatch(/"ownGoSignal": own_signal,/);
  });
});
