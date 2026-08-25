// The ONE loader for evaluating expressions against the real
// scripts/agent-dispatch.py module from a vitest file.
//
// Why: by 25 Aug 2026 four test files each carried their own copy of the
// importlib module-load snippet (inbound-response, creditor-agent,
// tier1, tier2) — four drifting copies of the exact pattern
// constant-drift.test.js exists to prevent. A change to how the module must
// be loaded (an env guard, a path move) now lands here once.
//
// Usage:
//   const runPy = makeRunPy(resolve(ROOT, 'scripts/agent-dispatch.py'));
//   runPy('sorted(mod.ALL_AGENTS.keys())');
//   runPy('{c: mod.tier_match(mod.TIER1_PATTERNS, c, "", "") for c in arg}', cases);
//
// The expression sees the loaded module as `mod` and the optional second
// argument (JSON round-tripped) as `arg`. The result must be JSON-serialisable.
import { execFileSync } from 'node:child_process';

export function makeRunPy(dispatchPath) {
  return (expr, arg) => {
    const script = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("dispatch", ${JSON.stringify(dispatchPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
arg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None
print(json.dumps(${expr}))
`;
    const argv = ['-c', script];
    if (arg !== undefined) argv.push(JSON.stringify(arg));
    return JSON.parse(execFileSync('python3', argv, { encoding: 'utf8' }));
  };
}
