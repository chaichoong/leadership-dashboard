import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
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
