// The merge guard refuses a bare `gh pr merge`, by command POSITION, not by text.
//
// Regression origin: 29 Sep 2026. 405 of the 472 changes that reached main in
// the previous 30 days arrived by `gh pr merge --squash` from an interactive
// Claude session, and nothing tested that route: scripts/pre-push gates only a
// direct push to main, and no GitHub workflow runs the tests. scripts/merge-pr.py
// is the gate for that route; scripts/merge-guard.py (a PreToolUse hook on Bash)
// makes it the only route.
//
// Two ways a guard like this fails, and both are tested here:
//   * TOO LOOSE: a merge after `cd x &&`, on a second line, inside $( ), behind
//     an env prefix, or through `gh api` slips past a check for "starts with gh".
//   * TOO TIGHT: a commit message or heredoc body that merely MENTIONS the words
//     gets blocked, and a guard that cries wolf is the one people turn off. A
//     crash that blocks every Bash call is an outage.
//
// These tests DRIVE the real script with hook JSON on stdin. They never grep it.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts/merge-guard.py');
// A scratch HOME, so a denial is logged here and never in Kevin's real log.
const HOME = mkdtempSync(join(tmpdir(), 'merge-guard-home-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function hook(input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync('python3', [GUARD], {
    input: stdin, encoding: 'utf8', env: { ...process.env, HOME }, timeout: 10000,
  });
  const out = (r.stdout || '').trim();
  return { code: r.status, out, json: out ? JSON.parse(out) : null, stderr: r.stderr };
}

const bash = (command) => hook({ tool_name: 'Bash', tool_input: { command } });

function expectDeny(command) {
  const r = bash(command);
  expect(r.code, `exit code for ${JSON.stringify(command)}`).toBe(0);
  expect(r.json, `expected a deny for ${JSON.stringify(command)}`).not.toBe(null);
  const h = r.json.hookSpecificOutput;
  expect(h.hookEventName).toBe('PreToolUse');
  expect(h.permissionDecision).toBe('deny');
  return h.permissionDecisionReason;
}

function expectAllow(command) {
  const r = bash(command);
  expect(r.code, `exit code for ${JSON.stringify(command)}`).toBe(0);
  expect(r.out, `expected no output (allow) for ${JSON.stringify(command)}`).toBe('');
}

describe('merge-guard denies a merge wherever it sits in command position', () => {
  it('a bare merge', () => {
    const why = expectDeny('gh pr merge 5 --squash --delete-branch');
    // The reason must hand Claude the route, with the PR number filled in.
    expect(why).toContain('python3 scripts/merge-pr.py --pr 5');
    expect(why).toMatch(/run_in_background/);
    expect(why).toMatch(/5 to 15 minutes/);
    expect(why).toMatch(/repair main first/);
  });
  it('--auto is still a merge', () => expectDeny('gh pr merge --auto --squash 12'));
  it('after cd &&', () => expectDeny('cd /tmp/x && gh pr merge 5 --squash'));
  it('on the second line', () => expectDeny('git status\ngh pr merge 5 --squash'));
  it('inside $( )', () => expectDeny('echo $(gh pr merge 5)'));
  it('inside $( ) inside double quotes', () => expectDeny('echo "result: $(gh pr merge 5)"'));
  it('inside backticks', () => expectDeny('x=`gh pr merge 5`'));
  it('behind env assignments', () => expectDeny('GH_DEBUG=1 FOO=bar gh pr merge 5'));
  it('behind command / env / time / sudo / timeout wrappers', () => {
    for (const c of ['command gh pr merge 5', 'env GH_PROMPT_DISABLED=1 gh pr merge 5',
                     'time gh pr merge 5', 'sudo -u kevin gh pr merge 5', 'timeout 600 gh pr merge 5']) {
      expectDeny(c);
    }
  });
  it('after || and | and ;', () => {
    expectDeny('git push || gh pr merge 5');
    expectDeny('gh pr view 5 | gh pr merge 5');
    expectDeny('ls; gh pr merge 5');
  });
  it('by full path, and with -R before the subcommand', () => {
    expectDeny('/opt/homebrew/bin/gh pr merge 5');
    expectDeny('gh -R chaichoong/leadership-dashboard pr merge 5');
  });
  it('run through bash -c or eval', () => {
    expectDeny("bash -c 'gh pr merge 5'");
    expectDeny('eval gh pr merge 5');
  });
  it('gh api PUT to pulls/<n>/merge, in every method-flag form', () => {
    for (const c of [
      'gh api -X PUT repos/chaichoong/leadership-dashboard/pulls/5/merge',
      'gh api --method PUT repos/o/r/pulls/5/merge -f merge_method=squash',
      'gh api -XPUT /repos/o/r/pulls/5/merge',
      'gh api --method=PUT repos/{owner}/{repo}/pulls/5/merge',
    ]) {
      expect(expectDeny(c), c).toContain('--pr 5');
    }
  });
  it('the GraphQL merge mutation', () => {
    expectDeny(`gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }'`);
  });
  it('behind caffeinate, stdbuf, arch, nice, nohup and timeout, in their option forms', () => {
    for (const c of ['caffeinate -i -t 600 gh pr merge 5', 'stdbuf -oL gh pr merge 5', 'stdbuf -o L gh pr merge 5',
                     'arch -arm64 gh pr merge 5', 'arch -arch arm64 gh pr merge 5', 'nice -n 10 gh pr merge 5',
                     'nohup gh pr merge 5 &', 'timeout --foreground -k 5 600 gh pr merge 5']) {
      expectDeny(c);
    }
  });
  it('run by watch (which hands its words to sh -c) or by script', () => {
    expectDeny('watch -n 60 gh pr merge 5');
    expectDeny("watch 'gh pr merge 5'");
    expectDeny('script -q /dev/null gh pr merge 5');
    expectDeny("script -c 'gh pr merge 5' /dev/null");
  });
  it('curl or wget writing to /pulls/<n>/merge', () => {
    for (const c of [
      "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/5/merge",
      'curl -sSX PUT https://api.github.com/repos/o/r/pulls/5/merge',
      "curl --request=PUT https://api.github.com/repos/o/r/pulls/5/merge -d '{}'",
      `curl -d '{"merge_method":"squash"}' https://api.github.com/repos/o/r/pulls/5/merge`,
      'wget --method=PUT https://api.github.com/repos/o/r/pulls/5/merge',
      'wget --method PUT -O- https://api.github.com/repos/o/r/pulls/5/merge',
    ]) {
      expect(expectDeny(c), c).toContain('--pr 5');
    }
  });
  it('an unbalanced quote around a merge fails CLOSED', () => {
    expectDeny('gh pr merge 5 --body "unterminated');
  });
});

describe('merge-guard allows everything that is not a merge', () => {
  it('gh pr view and gh pr create', () => {
    expectAllow('gh pr view 5 --json state,mergedAt');
    expectAllow("gh pr create --title 'Fix: x' --body 'y'");
  });
  it('a commit message in quotes that names the command', () => {
    expectAllow('git commit -m "Fix: stop using gh pr merge by hand"');
  });
  it('a heredoc commit body with a line "gh pr merge 5"', () => {
    // The exact shape Claude Code writes commits in, with a ) in the body too.
    expectAllow(`git add -A && git commit -m "$(cat <<'EOF'
Fix: send merges through the gate

gh pr merge 5
) a stray paren inside the body
EOF
)" && git status`);
  });
  it('the merge gate itself', () => {
    expectAllow('python3 scripts/merge-pr.py --pr 5');
    expectAllow('python3 scripts/merge-pr.py --pr 5 --dry-run 2>&1 | tail -5');
  });
  it('the branch delete merge-pr.py makes after a merge', () => {
    expectAllow('gh api -X DELETE repos/chaichoong/leadership-dashboard/git/refs/heads/feature/qa-merge-gate');
  });
  it('a GET of the merge status, and a mention in a field value', () => {
    expectAllow('gh api repos/o/r/pulls/5/merge');
    expectAllow("gh api repos/o/r/pulls/5 -f body='see pulls/5/merge'");
  });
  it('echo, grep and comments that mention it', () => {
    expectAllow('echo gh pr merge 5');
    expectAllow("grep -rn 'gh pr merge' CLAUDE.md");
    expectAllow('# gh pr merge 5\nls');
  });
  it('help and switching auto-merge off', () => {
    expectAllow('gh pr merge 5 --help');
    expectAllow('gh pr merge 5 --disable-auto');
  });
  it('curl or wget READING the merge status, or writing elsewhere', () => {
    expectAllow('curl -s https://api.github.com/repos/o/r/pulls/5/merge');
    expectAllow('curl -I https://api.github.com/repos/o/r/pulls/5/merge');
    expectAllow('curl -X PUT https://api.github.com/repos/o/r/pulls/5');
    expectAllow('wget -qO- https://api.github.com/repos/o/r/pulls/5/merge');
  });
  it('the wrappers around ordinary commands', () => {
    expectAllow('caffeinate -i npx vitest run');
    expectAllow("watch -n 5 'gh pr view 5'");
    expectAllow('script -q /dev/null ls');
  });
  it('deliberate evasion is left alone, as the header says', () => {
    // A habit is what the guard stops. Piping text into a shell is a choice.
    expectAllow("echo 'gh pr merge 5' | bash");
  });
  it('a tool that is not Bash', () => {
    const r = hook({ tool_name: 'Edit', tool_input: { command: 'gh pr merge 5', file_path: '/x' } });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });
  it('nesting too deep for the reader: a plain command is allowed, a merge still denied', () => {
    // Past its depth limit the reader gives up and the fallback regex decides:
    // fail closed for merges only, never for everything else.
    const deep = (inner) => 'echo ' + '$(echo '.repeat(12) + inner + ')'.repeat(12);
    expectAllow(deep('hello'));
    expectDeny(deep('x; gh pr merge 8'));
  });
  it('malformed stdin exits 0 with no decision', () => {
    for (const bad of ['not json at all', '', '[1,2]', '{"tool_name":"Bash"}',
                       '{"tool_name":"Bash","tool_input":{"command":42}}']) {
      const r = hook(bad);
      expect(r.code, bad).toBe(0);
      expect(r.out, bad).toBe('');
    }
  });
});

describe('merge-guard on the desktop auto-merge tool', () => {
  const AUTO = 'mcp__ccd_pr__set_auto_merge';
  const URL = 'https://github.com/chaichoong/leadership-dashboard/pull/42';
  it('denies turning auto-merge ON: it lands the PR with no gate', () => {
    const r = hook({ tool_name: AUTO, tool_input: { url: URL, enabled: true, merge_method: 'squash' } });
    expect(r.code).toBe(0);
    const h = r.json.hookSpecificOutput;
    expect(h.permissionDecision).toBe('deny');
    expect(h.permissionDecisionReason).toContain('python3 scripts/merge-pr.py --pr 42');
  });
  it('allows turning it OFF, and fails open on anything else', () => {
    for (const input of [{ url: URL, enabled: false }, { url: URL }, {}, { url: URL, enabled: 'false' }]) {
      const r = hook({ tool_name: AUTO, tool_input: input });
      expect(r.code, JSON.stringify(input)).toBe(0);
      expect(r.out, JSON.stringify(input)).toBe('');
    }
  });
  it('the hook is wired for the tool in .claude/settings.json, and runs this guard', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
    const pre = settings.hooks.PreToolUse;
    for (const matcher of ['Bash', AUTO]) {
      const entry = pre.find(e => e.matcher === matcher);
      expect(entry, matcher).toBeTruthy();
      expect(entry.hooks[0].command, matcher).toContain('scripts/merge-guard.py');
    }
  });
});

describe('merge-guard bookkeeping', () => {
  it('logs each denial to ~/knowledge-os/logs/merge-guard.log, with secrets redacted', () => {
    expectDeny('GH_TOKEN=ghp_abcdefghijklmnop gh pr merge 99');
    const log = join(HOME, 'knowledge-os/logs/merge-guard.log');
    expect(existsSync(log)).toBe(true);
    const text = readFileSync(log, 'utf8');
    const last = text.trim().split('\n').pop();
    expect(last).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tGH_TOKEN=\[REDACTED\] gh pr merge 99$/);
    expect(text).not.toContain('ghp_abcdefghijklmnop');
  });
  it('an allowed call writes nothing to the log', () => {
    const log = join(HOME, 'knowledge-os/logs/merge-guard.log');
    const before = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expectAllow('gh pr view 1');
    const after = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(after).toBe(before);
  });
  it('its own --selftest passes', () => {
    const out = execFileSync('python3', [GUARD, '--selftest'], { encoding: 'utf8', env: { ...process.env, HOME } });
    expect(out).toMatch(/, 0 failed/);
  });
});
