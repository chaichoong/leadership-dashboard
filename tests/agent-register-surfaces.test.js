// The AI Agents register (tbl9msVjyQWslLOIZ) is the single source of truth
// for the agent workforce, and Kevin's "all of it" sync ruling (24 Aug 2026)
// wired it into every owner surface. These are drift guards: if a surface
// loses its register read, or the deep-link handshake breaks on either side,
// the platform quietly splits back into two agent lists that never speak.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const REGISTER = 'tbl9msVjyQWslLOIZ';
const DAILY_LOG = 'tbl6VQKVMnK0Q7hbJ';

const tasksPage = read('os/tasks/index.html');
const sysPage = read('os/systemisation/index.html');
const skills = read('js/skills.js');
const dashboard = read('js/dashboard.js');
const shim = read('os/systemisation/systemisation-shim.js');
const spec = read('docs/supabase-schema-spec.md');

describe('every owner surface reads the register', () => {
  for (const [name, src] of [['Tasks & Projects', tasksPage], ['Systemisation', sysPage], ['Skills Library', skills]]) {
    it(`${name} references the register table`, () => {
      expect(src).toContain(REGISTER);
    });
  }

  it('the Leadership Dashboard reads the register via the config constant', () => {
    // dashboard.js goes through TABLES.aiAgents (the config.js pattern) rather
    // than a raw id — assert the chain end to end.
    expect(dashboard).toMatch(/TABLES\.aiAgents/);
    expect(read('js/config.js')).toContain(REGISTER);
  });

  it('Tasks & Projects and Systemisation both read the Daily Log', () => {
    expect(tasksPage).toContain(DAILY_LOG);
    expect(sysPage).toContain(DAILY_LOG);
  });

  it('the dashboard counts through the shared module, never raw addition', () => {
    expect(dashboard).toMatch(/AgentAccuracy\.countAgents/);
  });

  it('register reads on the Tasks page paginate (the first-100-rows trap)', () => {
    expect(tasksPage).toMatch(/fetchAllAirtablePages/);
  });
});

describe('the role-agent deep link has both halves', () => {
  it('producers set sys_open_role_agent (Skills Library + Tasks roster)', () => {
    expect(skills).toContain("localStorage.setItem('sys_open_role_agent'");
    expect(tasksPage).toContain("localStorage.setItem('sys_open_role_agent'");
  });

  it('Systemisation consumes it and clears it', () => {
    expect(sysPage).toContain("localStorage.getItem('sys_open_role_agent')");
    expect(sysPage).toContain("localStorage.removeItem('sys_open_role_agent')");
  });
});

describe('the client build knows what it owes', () => {
  it('the shim warning names all three unmapped tables and points to the spec', () => {
    expect(shim).toContain(REGISTER);
    expect(shim).toContain(DAILY_LOG);
    expect(shim).toMatch(/2\.8/);
  });

  it('the spec section 2.8 specs ai_agents, agent_daily_log and the module gate', () => {
    expect(spec).toMatch(/### 2\.8 AI Agents register \+ daily log/);
    expect(spec).toContain('ai_agents');
    expect(spec).toContain('agent_daily_log');
    expect(spec).toMatch(/agents: bool/);
  });
});
