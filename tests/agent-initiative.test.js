import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const require_ = createRequire(import.meta.url);
const browser = require_(resolve(ROOT, 'scripts/agent-browser.js'));

// ─────────────────────────────────────────────────────────────────────────────
// 27 Aug 2026. The agents looked like they could only draft emails. They were
// capped to Bash(python3) and Bash(curl) with no MCP servers reachable from a
// headless run, so writing a document was the only action they had a route
// for. These tests guard the unlock AND the guardrails that came with it.
// ─────────────────────────────────────────────────────────────────────────────

const RUNNERS = [
  'scripts/agent-slot-run.sh',
  'scripts/handback-poll-run.sh',
  'scripts/inbound-triage-run.sh',
  'scripts/task-manager-run.sh',
];

describe('tool policy is shared, not copied', () => {
  it('every runner sources agent-tools.sh (control: there are four)', () => {
    expect(RUNNERS.length).toBe(4);
    for (const r of RUNNERS) {
      expect(read(r), r).toMatch(/\.\s+"\$\(dirname "\$0"\)\/agent-tools\.sh"/);
    }
  });

  it('no runner hand-rolls its own allowedTools list again', () => {
    // The original bug: four files each carrying their own copy of the cap,
    // so nobody could see it was a policy. A literal Bash(...) in the
    // --allowedTools call is that copy coming back.
    for (const r of RUNNERS) {
      const call = read(r).match(/--allowedTools .*/);
      expect(call, `${r} has an --allowedTools call`).not.toBeNull();
      expect(call[0], r).toContain('${AGENT_ALLOWED_TOOLS[@]}');
      // handback-poll legitimately appends osascript for iMessage sends.
      const extras = call[0].replace('"${AGENT_ALLOWED_TOOLS[@]}"', '');
      const literals = [...extras.matchAll(/"(Bash\([^)]*\)|Web[A-Za-z]+)"/g)].map(m => m[1]);
      const allowed = r.includes('handback-poll') ? ['Bash(osascript:*)'] : [];
      expect(literals.sort(), `${r} appends only its sanctioned extras`).toEqual(allowed.sort());
    }
  });

  it('the shared list actually carries the research and browser tools', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(resolve(ROOT, 'scripts/agent-tools.sh'))}; printf '%s\\n' "\${AGENT_ALLOWED_TOOLS[@]}"`,
    ], { encoding: 'utf8' }).trim().split('\n');
    // Back-test: dropping any of these puts an agent back to draft-only.
    for (const t of ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob', 'Bash(node:*)']) {
      expect(out, `${t} must be reachable by a headless agent`).toContain(t);
    }
    // The capabilities that already worked must survive the change.
    expect(out).toContain('Bash(python3:*)');
    expect(out).toContain('Bash(curl:*)');
  });

  it('lets a run wait 40 minutes for its agents, under the hand-back poll\'s own 45-minute limit (25 Sep 2026)', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(resolve(ROOT, 'scripts/agent-tools.sh'))}; echo "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"`,
    ], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();
    expect(Number(out)).toBe(2400000);
    const poll = read('scripts/handback-poll-run.sh').match(/HANDBACK_MAX_MINUTES:-(\d+)/);
    expect(Number(out) / 60000).toBeLessThan(Number(poll[1]));
  });

  it('resolves node by absolute path, because launchd has no nvm on PATH', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(resolve(ROOT, 'scripts/agent-tools.sh'))}; echo "$AGENT_NODE_BIN"`,
    ], { encoding: 'utf8' }).trim();
    expect(out).toMatch(/\/node$/);
  });

  it('does NOT hand agents an unrestricted shell or code-write tools', () => {
    const src = read('scripts/agent-tools.sh');
    const list = src.match(/AGENT_ALLOWED_TOOLS=\(([\s\S]*?)\n\)/)[1];
    expect(list).not.toMatch(/"Bash\(\*\)"|"Bash"/);
    expect(list).not.toMatch(/"(Edit|Write|NotebookEdit)"/);
  });

  // Finding 20260925-agent-dispatch-617 (25 Sep 2026): SKILL step 7's verify goes
  // through ~/tools/run-job.sh (the Estate board record and the alert). Headless it
  // needed an approval nobody could give. Proved live the same day: a multi-word
  // absolute-path prefix rule of this shape runs headless, and without it the
  // engine answers "This command requires approval". The WRAPPER itself must never
  // be allowed bare: it runs whatever it is handed.
  it('lets the run record its own verify through run-job.sh, and nothing else through it', () => {
    const out = execFileSync('bash', ['-c',
      `. ${JSON.stringify(resolve(ROOT, 'scripts/agent-tools.sh'))}; printf '%s\\n' "\${AGENT_ALLOWED_TOOLS[@]}"`,
    ], { encoding: 'utf8' }).trim().split('\n');
    expect(out).toContain('Bash(/Users/kevinbrittain/tools/run-job.sh agent-dispatch python3 /Users/kevinbrittain/Projects/leadership-dashboard/scripts/agent-dispatch.py verify:*)');
    const wrapper = out.filter((t) => t.includes('run-job.sh'));
    for (const t of wrapper) expect(t, 'run-job.sh is allowed only for verify').toMatch(/agent-dispatch\.py verify:\*\)$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21 Sep 2026, audit item 121. Leaving Edit/Write off the list above never
// enforced anything: --allowedTools only ADDS permissions, and a headless run
// also loads Kevin's own settings, which allow Edit, Write, Bash(git:*) and
// Bash(gh:*). What enforces "read-only for code" is the deny list in
// scripts/agent-settings.json, passed to every run with --settings. Its rules
// were back-tested on the real engine (2.1.278) in throwaway repos: with the
// file, git commit, git -C commit, a commit from a subagent, a Write into
// scripts/, an Edit of a tracked script, a root .html and a `> js/x` redirect
// were all refused while monitoring/, the scratch dir and read-only commands
// still worked; without it, all of them went through. These tests keep the
// wiring and the file from drifting away from what was proved.
// ─────────────────────────────────────────────────────────────────────────────
describe('robot-only deny list (scripts/agent-settings.json)', () => {
  const SETTINGS = 'scripts/agent-settings.json';
  const RUNNERS_ALL = [...RUNNERS, 'scripts/signin-pickup-run.sh', 'scripts/roy-assistant-run.sh'];
  const deny = () => JSON.parse(read(SETTINGS)).permissions.deny;
  const editRules = () => deny().filter((r) => r.startsWith('Edit('))
    .map((r) => r.slice(5, -1));
  // The repo every runner cds into before starting claude.
  const repoOf = (r) => read(r).match(/^REPO="(?:\$\{[A-Z_]+:-)?(\/[^"}]+)/m)[1];
  const REPO = repoOf('scripts/agent-slot-run.sh');
  // The three rule shapes this file uses, and only those (asserted below), so
  // this matcher is complete for it. The engine's own reading of each shape is
  // what the back-test proved.
  const covers = (rule, abs) => {
    const base = `/${REPO}/`;
    if (!rule.startsWith(base)) return false;
    const rest = rule.slice(base.length);
    const rel = abs.startsWith(`${REPO}/`) ? abs.slice(REPO.length + 1) : null;
    if (rel === null) return false;
    if (rest.endsWith('/**')) return rel.startsWith(rest.slice(0, -2));
    if (rest.startsWith('*.')) return !rel.includes('/') && rel.endsWith(rest.slice(1));
    return rel === rest;
  };
  const covered = (abs) => editRules().some((r) => covers(r, abs));

  it('every script that hands claude the agent tool list also passes the deny list (control: five)', () => {
    const found = readdirSync(resolve(ROOT, 'scripts'))
      .filter((f) => /\.(sh|py)$/.test(f))
      .map((f) => `scripts/${f}`)
      .filter((f) => read(f).includes('${AGENT_ALLOWED_TOOLS[@]}'));
    expect(found.sort()).toEqual([...RUNNERS_ALL].sort());
    for (const r of found) {
      const calls = read(r).match(/"\$CLAUDE" -p [\s\S]*?--allowedTools /g) || [];
      expect(calls.length, `${r} starts claude`).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c, `${r}: a claude run without --settings "$AGENT_SETTINGS_FILE" runs on Kevin's permissions`)
          .toContain('--settings "$AGENT_SETTINGS_FILE"');
      }
      expect(repoOf(r), `${r} must cd into the repo the deny list names`).toBe(REPO);
    }
  });

  it('agent-tools.sh exports the path of the file, and the file exists', () => {
    const out = execFileSync('/bin/bash', ['-c',
      `set -u; . ${JSON.stringify(resolve(ROOT, 'scripts/agent-tools.sh'))}; echo "$AGENT_SETTINGS_FILE"`,
    ], { encoding: 'utf8', cwd: '/' }).trim();
    expect(out).toBe(resolve(ROOT, SETTINGS));
    expect(existsSync(out)).toBe(true);
  });

  it('is valid JSON with a deny list (the engine silently IGNORES an invalid file)', () => {
    expect(() => JSON.parse(read(SETTINGS))).not.toThrow();
    expect(Array.isArray(deny())).toBe(true);
    // Only deny: an allow here would widen what the agents can do.
    expect(Object.keys(JSON.parse(read(SETTINGS)).permissions)).toEqual(['deny']);
  });

  it('denies the git and gh writes', () => {
    for (const r of ['Bash(git commit *)', 'Bash(git push *)', 'Bash(git reset *)',
      'Bash(git checkout *)', 'Bash(git -C *)', 'Bash(gh *)']) {
      expect(deny(), r).toContain(r);
    }
  });

  it('never removes a whole tool the agents rely on', () => {
    for (const bare of ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent']) {
      expect(deny(), `a bare "${bare}" deny takes the tool away from every agent`).not.toContain(bare);
    }
    for (const r of deny()) {
      if (!r.startsWith('Bash(')) continue;
      expect(r, 'Bash denies are git/gh writes only').toMatch(/^Bash\((git |gh )/);
    }
  });

  it('every Edit rule is one of the three proven shapes, anchored at the repo or ~/.claude', () => {
    for (const r of editRules()) {
      if (r.startsWith('~/.claude/')) continue;
      expect(r.startsWith(`/${REPO}/`), `${r} must be anchored with // at ${REPO}`).toBe(true);
      const rest = r.slice(REPO.length + 2);
      expect(rest, r).toMatch(/^([A-Za-z0-9._-]+\/\*\*|\*\.[a-z]+|[A-Za-z0-9._-]+)$/);
    }
  });

  it('covers every tracked file outside monitoring/', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    expect(tracked.length, 'git ls-files returned nothing').toBeGreaterThan(500);
    const open = tracked.filter((f) => !f.startsWith('monitoring/'))
      .filter((f) => !covered(`${REPO}/${f}`));
    expect(open, 'tracked code an agent could still edit: add its folder or name to the deny list').toEqual([]);
  });

  it('leaves monitoring/, the root temp files and the agents’ scratch writable', () => {
    for (const p of [`${REPO}/monitoring/e2e-sweep-2026-09-20.md`, `${REPO}/monitoring/dispatch/rec1.md`,
      `${REPO}/queue_13_tmp.json`, `${REPO}/check_tmp.py`,
      '/Users/kevinbrittain/knowledge-os/logs/task-manager/scratch/board.json']) {
      expect(covered(p), p).toBe(false);
    }
    // Control: the matcher does see a code path, or the lines above prove nothing.
    expect(covered(`${REPO}/scripts/agent-dispatch.py`)).toBe(true);
    expect(covered(`${REPO}/index.html`)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 21 Sep 2026, Kevin approved. Every runner tells its robot to keep working
// files in a folder under ~/knowledge-os/logs/, and the deny list above keeps
// it out of the code paths in the repo. But a run started in the repo may only
// mkdir or redirect (`> file`) inside its working directories, and none of
// those folders was one: "mkdir in '.../logs/agent-dispatch/<run>/...' was
// blocked. For security, Claude Code may only create directories in the
// allowed working directories", in 10 of 12 robot runs on 19 Sep and 11 of 13
// on 20 Sep. Each runner now passes --add-dir for exactly the folder it is
// told to write. Back-tested on 2.1.278 with each runner's exact flags: mkdir
// and `echo x > file` in the granted folder went through; a sibling of it,
// /tmp and scripts/ stayed refused; without the flag the same write was
// refused. These tests keep every runner granting its folder, and only it.
// ─────────────────────────────────────────────────────────────────────────────
describe('robot working folders (--add-dir)', () => {
  const LOGS = '/Users/kevinbrittain/knowledge-os/logs';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const L = esc(LOGS);
  // What each runner must grant, and what each variable must resolve to.
  const WANT = {
    'scripts/agent-slot-run.sh': { SCRATCH: new RegExp(`^${L}/ceo-agent/scratch$`) },
    'scripts/task-manager-run.sh': { SCRATCH: new RegExp(`^${L}/task-manager/scratch$`) },
    'scripts/inbound-triage-run.sh': {
      SCRATCH: new RegExp(`^${L}/inbound-triage/scratch$`),
      DISPATCH_RUNS: new RegExp(`^${L}/agent-dispatch$`),
    },
    'scripts/handback-poll-run.sh': { RUNDIR: new RegExp(`^${L}/agent-dispatch/\\d{8}-\\d{6}$`) },
    'scripts/signin-pickup-run.sh': { RUNDIR: new RegExp(`^${L}/agent-dispatch/\\d{8}-\\d{6}-signin$`) },
    'scripts/roy-assistant-run.sh': { RUNDIR: new RegExp(`^${L}/agent-dispatch/\\d{8}-\\d{6}-roy$`) },
  };
  const RUNNERS_ALL = Object.keys(WANT);
  const callOf = (src) => src.match(/"\$CLAUDE" -p [\s\S]*?--allowedTools /g) || [];
  // The runner's OWN assignment lines, run by bash, so the test reads the
  // folder the runner would really pass rather than a copy of it. Only these
  // five names are taken: other top-level lines call Airtable.
  const resolveVars = (r, names) => {
    const src = read(r);
    const head = src.slice(0, src.indexOf('"$CLAUDE" -p'));
    const lines = head.split('\n').filter((l) => /^(JOB|LOG_DIR|SCRATCH|RUNDIR|DISPATCH_RUNS)=/.test(l));
    const script = [...lines, ...names.map((n) => `printf '%s\\n' "$${n}"`)].join('\n');
    // agent-slot-run.sh takes the job name as $1; ceo-agent is a real slot.
    const out = execFileSync('/bin/bash', ['-c', script, 'runner', 'ceo-agent'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/Users/kevinbrittain' },
    }).split('\n');
    return Object.fromEntries(names.map((n, i) => [n, out[i]]));
  };

  it('every agent runner is covered here (control: the five that start claude with the agent tools)', () => {
    const found = readdirSync(resolve(ROOT, 'scripts'))
      .filter((f) => /\.(sh|py)$/.test(f)).map((f) => `scripts/${f}`)
      .filter((f) => read(f).includes('${AGENT_ALLOWED_TOOLS[@]}'));
    expect(found.sort()).toEqual([...RUNNERS_ALL].sort());
  });

  it('each claude run grants exactly its own folder(s), by variable, nothing else', () => {
    for (const r of RUNNERS_ALL) {
      const calls = callOf(read(r));
      expect(calls.length, `${r} starts claude`).toBeGreaterThan(0);
      for (const c of calls) {
        const all = [...c.matchAll(/--add-dir\b/g)].length;
        const vars = [...c.matchAll(/--add-dir "\$([A-Z_]+)"/g)].map((m) => m[1]);
        expect(vars.length, `${r}: every --add-dir names a variable, never a literal path`).toBe(all);
        expect(vars.sort(), `${r}: a robot refused its own working folder falls back to /tmp and the repo`)
          .toEqual(Object.keys(WANT[r]).sort());
      }
    }
  });

  it('each granted folder resolves to that runner’s own folder under logs/, never wider', () => {
    for (const r of RUNNERS_ALL) {
      const got = resolveVars(r, Object.keys(WANT[r]));
      for (const [name, re] of Object.entries(WANT[r])) {
        expect(got[name], `${r}: $${name}`).toMatch(re);
        // Explicit, although the patterns above already imply it.
        for (const wide of [LOGS, '/Users/kevinbrittain', '/tmp', '/', resolve(ROOT)]) {
          expect(got[name], `${r}: $${name} must not grant ${wide}`).not.toBe(wide);
        }
        expect(got[name].startsWith(`${LOGS}/`), `${r}: $${name}`).toBe(true);
      }
    }
  });

  it('each granted folder is created before claude starts', () => {
    for (const r of RUNNERS_ALL) {
      const src = read(r);
      const start = src.indexOf('"$CLAUDE" -p');
      for (const name of Object.keys(WANT[r])) {
        const mk = src.search(new RegExp(`^\\s*mkdir -p [^\\n]*"\\$${name}"`, 'm'));
        expect(mk, `${r}: mkdir -p "$${name}" is missing`).toBeGreaterThan(-1);
        expect(mk, `${r}: mkdir -p "$${name}" must come before the claude run`).toBeLessThan(start);
      }
    }
  });

  it('the folder granted is the folder the robot is told to write', () => {
    // The prompt names it for SCRATCH and RUNDIR runs.
    for (const r of RUNNERS_ALL) {
      const prompt = callOf(read(r))[0].split(/\n\s+--/)[0];
      for (const name of Object.keys(WANT[r]).filter((n) => n !== 'DISPATCH_RUNS')) {
        expect(prompt, `${r}: the prompt must send working files to $${name}`).toContain(`$${name}`);
      }
    }
    // The dispatch skill names its own run folder mid-run: it must sit inside
    // the folder inbound-triage grants, or step 3 is refused again.
    const skill = read('.claude/scheduled-tasks/agent-dispatch/SKILL.md');
    const m = skill.match(/RUNDIR="\$HOME(\/knowledge-os\/logs\/[^"$]+)\/\$\(date/);
    expect(m, 'agent-dispatch SKILL.md step 1 RUNDIR line').not.toBeNull();
    const { DISPATCH_RUNS } = resolveVars('scripts/inbound-triage-run.sh', ['DISPATCH_RUNS']);
    expect(`/Users/kevinbrittain${m[1]}`).toBe(DISPATCH_RUNS);
    // Control: the task-manager skill's scratch is the one its runner grants.
    expect(read('.claude/scheduled-tasks/task-manager-board/SKILL.md'))
      .toContain('~/knowledge-os/logs/task-manager/scratch');
  });
});

describe('browser lane — prepare can never submit', () => {
  // The stub is the page: runSteps is the thing under test, and driving it
  // with a fake page proves the control flow without a network round trip.
  const stubPage = () => {
    const calls = [];
    return {
      calls,
      goto: async (u) => { calls.push(['goto', u]); },
      fill: async (s, v) => { calls.push(['fill', s, v]); },
      click: async (s) => { calls.push(['click', s]); },
      check: async (s) => { calls.push(['check', s]); },
      selectOption: async (s, v) => { calls.push(['select', s, v]); },
      waitForTimeout: async () => {},
      $eval: async () => ({ type: 'text', name: 'reference' }),
    };
  };
  const PLAN = [
    { do: 'goto', url: 'https://www.gov.uk/' },
    { do: 'fill', selector: '#ref', value: '12345' },
    { do: 'submit', selector: '#go' },
  ];

  it('prepare stops at the submit step and never clicks it', async () => {
    const page = stubPage();
    const r = await browser.runSteps(page, PLAN, false);
    expect(r.stoppedBeforeSubmit).toBe(true);
    expect(page.calls.map(c => c[0])).toEqual(['goto', 'fill']);
    expect(page.calls.some(c => c[0] === 'click')).toBe(false);
  });

  it('commit does click the submit step (control — otherwise the test above proves nothing)', async () => {
    const page = stubPage();
    const r = await browser.runSteps(page, PLAN, true);
    expect(r.stoppedBeforeSubmit).toBe(false);
    expect(page.calls.map(c => c[0])).toEqual(['goto', 'fill', 'click']);
  });
});

describe('browser lane — credentials are never automated', () => {
  const pageWith = (attrs) => ({ $eval: async () => attrs });

  it('refuses any input rendered as a password box', async () => {
    await expect(browser.assertNotCredential(
      pageWith({ type: 'password', name: 'anything' }), '#p', 'x',
    )).rejects.toThrow(/password field/i);
  });

  it('refuses credential- and payment-shaped field names even at type=text', async () => {
    // A site rendering a passcode as type=text is exactly the hole a single
    // type check leaves open.
    for (const name of ['passcode', 'otp', 'mfa-code', 'cardNumber', 'sort code', 'cvv', 'api_key']) {
      await expect(browser.assertNotCredential(
        pageWith({ type: 'text', name }), '#f', 'val',
      ), name).rejects.toThrow(/credential or payment field/i);
    }
  });

  it('refuses when the VALUE looks like a secret on an innocent field', async () => {
    await expect(browser.assertNotCredential(
      pageWith({ type: 'text', name: 'notes' }), '#f', 'api_key=abc123',
    )).rejects.toThrow(/looks like a secret/i);
  });

  it('allows an ordinary reference field (control)', async () => {
    await expect(browser.assertNotCredential(
      pageWith({ type: 'text', name: 'account reference' }), '#f', '5482505',
    )).resolves.toBeUndefined();
  });

  it('refuses a selector that matched nothing rather than filling blind', async () => {
    await expect(browser.assertNotCredential(
      { $eval: async () => { throw new Error('no match'); } }, '#missing', 'v',
    )).rejects.toThrow(/matched nothing/i);
  });
});

describe('browser lane — allowlist and approval gate', () => {
  it('allows the built-in gov hosts and their subdomains', () => {
    expect(browser.hostAllowed('https://www.gov.uk/foo')).toBe(true);
    expect(browser.hostAllowed('https://find-and-update.company-information.service.gov.uk/')).toBe(true);
  });

  it('refuses anything not on the list, including lookalikes', () => {
    expect(browser.hostAllowed('https://example.com/')).toBe(false);
    expect(browser.hostAllowed('https://gov.uk.evil.com/')).toBe(false);
    expect(browser.hostAllowed('not a url')).toBe(false);
  });

  it('the submit gate rejects a non-record-id task before it touches the network', () => {
    expect(() => browser.assertApproved('not-a-record')).toThrow(/record id/i);
  });
});

describe('agent-dispatch exposes the outcome subcommand the gate depends on', () => {
  it('is registered in the CLI (a missing one silently ungates every form)', () => {
    const src = read('scripts/agent-dispatch.py');
    expect(src).toMatch(/sub\.add_parser\("outcome"/);
    expect(src).toMatch(/"outcome": cmd_outcome/);
    expect(src).toMatch(/def cmd_outcome\(args\):/);
  });

  it('agent-browser calls it by that exact name', () => {
    expect(read('scripts/agent-browser.js')).toMatch(/'agent-dispatch\.py'\), 'outcome'/);
  });
});
