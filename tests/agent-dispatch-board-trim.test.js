import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// The board trim (Kevin, 9 Oct 2026; brain Decisions/2026-10-09). Eight seats
// left the board: Systemisation folded into Operations, Wealth into Finance;
// HR, Productivity and Mindset retired; Marketing, Sales and the Writer parked
// until the January Operations Director decision. Their agent files moved out
// of ~/.claude/agents, so a task routed to one would be dispatched to a file
// that no longer exists. These tests drive the REAL module: every off-board row
// points at a live agent, and `route` refuses to hand work to one.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

function py(code) {
  const script = `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec)
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec.loader.exec_module(ad)
${code}
`;
  return execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' });
}

const LIVE_AGENTS = ['od-ceo', 'dept-strategy', 'dept-operations', 'dept-finance', 'dept-legal-compliance',
  'worker-builder', 'worker-auditor', 'worker-analyst', 'worker-researcher'];

describe('the trimmed board', () => {
  const state = JSON.parse(py(`print(json.dumps({
  "off": list(ad.OFF_BOARD),
  "agents": {k: v["agent"] for k, v in ad.AGENTS.items()},
}))`));

  it('lists the eight seats that left (control)', () => {
    expect(state.off).toHaveLength(8);
    for (const id of state.off) expect(state.agents[id], `${id} missing from AGENTS`).toBeTruthy();
  });

  it('points every strategic row at one of the nine live agents', () => {
    for (const [id, agent] of Object.entries(state.agents)) {
      expect(LIVE_AGENTS, `${id} points at ${agent}`).toContain(agent);
    }
  });

  it('route refuses a seat that left the board, before any network call', () => {
    for (const id of state.off) {
      let err = '';
      try {
        py(`ad.cmd_route(types.SimpleNamespace(task="recTEST00000000001", to=${JSON.stringify(id)}))`);
      } catch (e) {
        err = String(e.stderr || e.message);
      }
      expect(err, `${id} was accepted`).toMatch(/left the board on 9 Oct 2026/);
    }
  });

  it('no live head is on the off-board list', () => {
    for (const id of ['recFZ1ofn0OuoZNEr', 'recGvMnprGf1hr9Z1', 'recRStFWWEyHgOD6t', 'recSvV7a47ze9i5X9']) {
      expect(state.off).not.toContain(id);
    }
  });
});

// Only on the Mac that runs the estate: the agent files themselves.
const AGENT_DIR = join(homedir(), '.claude/agents');
describe.runIf(existsSync(join(AGENT_DIR, 'od-ceo.md')))('the agent files on this Mac', () => {
  it('holds every live agent and none of the eight that left', () => {
    for (const a of LIVE_AGENTS) expect(existsSync(join(AGENT_DIR, `${a}.md`)), `${a}.md missing`).toBe(true);
    for (const a of ['dept-hr', 'dept-mindset', 'dept-productivity', 'dept-systemisation', 'dept-wealth',
      'dept-marketing', 'dept-sales', 'worker-writer']) {
      expect(existsSync(join(AGENT_DIR, `${a}.md`)), `${a}.md still live`).toBe(false);
    }
  });
});
