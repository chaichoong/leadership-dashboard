// Guards scripts/adobe-send.js (10 Nov 2026).
//
// The send step of a tenancy pack was prose in the tenant-doc-generator skill and code nowhere,
// so each pack session wrote its own browser script. adobe-send.js is the one route now. Its
// guards are what make it safe to exist next to adobe-assign.js, which cannot send at all:
// only a chat Kevin is in may press Send, Agile Lets signs first, two signers need the order
// switch ON, and Adobe's own line for THIS draft is the only proof.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'adobe-send.js');
const mod = createRequire(import.meta.url)(SCRIPT);

describe('adobe-send.js guards', () => {
  it('passes its own selftest', () => {
    expect(execFileSync('node', [SCRIPT, '--selftest'], { encoding: 'utf8' })).toMatch(/selftest OK/);
  });

  it.each([
    ['a robot slot', { AGENT_SLOT_SCRATCH: '/tmp/x', CLAUDE_CODE_SESSION_ATTENDED: '1' }],
    ['the task manager', { TASK_MANAGER_SCRATCH: '/tmp/x', CLAUDE_CODE_SESSION_ATTENDED: '1' }],
    ['an unattended session', {}],
    ['a session marked 0', { CLAUDE_CODE_SESSION_ATTENDED: '0' }],
  ])('refuses %s before opening a browser', (_, extra) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
    const r = spawnSync('node', [SCRIPT, '--title', 'AST_Jane_Testwood_5_Dalham_Place'], { env, encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SEND REFUSED/);
  });

  it('lets an attended chat through', () => {
    expect(mod.headlessRefusal({ CLAUDE_CODE_SESSION_ATTENDED: '1' })).toBe('');
  });

  it('refuses a title short enough to match the wrong draft', () => {
    expect(() => mod.checkTitle('AST_Jane')).toThrow(/too short/);
    expect(mod.checkTitle('  AST_Jane_Testwood  ')).toBe('AST_Jane_Testwood');
  });

  it('needs info@agilelets.co.uk first, and the order switch when there are two signers', () => {
    expect(mod.checkRecipients(['info@agilelets.co.uk (myself)', 'Jane@Example.com']))
      .toEqual({ recipients: ['info@agilelets.co.uk', 'jane@example.com'], needsOrder: true });
    expect(mod.checkRecipients(['info@agilelets.co.uk (myself)']).needsOrder).toBe(false);
    expect(() => mod.checkRecipients(['jane@example.com', 'info@agilelets.co.uk'])).toThrow(/signs first/);
    expect(() => mod.checkRecipients([])).toThrow(/no recipients/);
  });

  it('believes only the confirmation that names this draft', () => {
    const page = 'You are on page 1 6 AST_George_Diver_Stephen_O_Reilly_55_Elmdon_Place was successfully sent for signature A PDF copy';
    expect(mod.confirmed(page, 'AST_George_Diver_Stephen_O_Reilly_55_Elmdon_Place')).toBe(true);
    expect(mod.confirmed(page, 'Proof_of_Residency_George_Diver_Stephen_O_Reilly')).toBe(false);
    expect(mod.confirmed('Something went wrong', 'AST_George_Diver_Stephen_O_Reilly_55_Elmdon_Place')).toBe(false);
  });
});
