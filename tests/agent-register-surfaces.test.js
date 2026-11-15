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
// The register and its panel moved from os/systemisation to the Leadership
// → AI Agents page (os/agents/) on 25 Aug 2026 — Systemisation keeps only
// the SOP-building flow and a pointer tab.
const agentsPage = read('os/agents/index.html');
const dashboard = read('js/dashboard.js');

describe('every owner surface reads the register', () => {
  // (The Skills Library, js/skills.js, was a third surface until it was removed on 15 Nov 2026.)
  for (const [name, src] of [['Tasks & Projects', tasksPage], ['AI Agents page', agentsPage]]) {
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

  it('Tasks & Projects and the AI Agents page both read the Daily Log', () => {
    expect(tasksPage).toContain(DAILY_LOG);
    expect(agentsPage).toContain(DAILY_LOG);
  });

  it('the dashboard counts through the shared module, never raw addition', () => {
    expect(dashboard).toMatch(/AgentAccuracy\.countAgents/);
  });

  it('register reads on the Tasks page paginate (the first-100-rows trap)', () => {
    expect(tasksPage).toMatch(/fetchAllAirtablePages/);
  });
});

describe('the role-agent deep link has both halves', () => {
  it('the same-window deep link uses the parent postMessage helper — the localStorage handoff raced a reloading iframe (24 Aug 2026)', () => {
    // The Skills Library (js/skills.js) was the first sender; it was removed on
    // 15 Nov 2026. The helper and its receiver stay for the shell and Systemisation.
    // sender in shared.js, receiver + boot handshake on the page
    const shared = read('js/shared.js');
    expect(shared).toContain('window.deepLinkAgents');
    expect(shared).toContain("'agentsPageReady'");
    expect(agentsPage).toContain("'agentsDeepLink'");
    expect(agentsPage).toContain("{ type:'agentsPageReady' }");
    // the boot-time localStorage consumption stays for straggler writers
    expect(agentsPage).toContain("localStorage.getItem('sys_open_role_agent')");
  });

  it('the Tasks roster (new tab) uses the URL hash — the storage event would be stolen by the hidden shell iframe', () => {
    expect(tasksPage).toContain('index.html#agent=');
    expect(tasksPage).not.toContain("localStorage.setItem('sys_open_role_agent'");
    expect(agentsPage).toMatch(/#agent=\(rec\[A-Za-z0-9\]\+\)/);
  });
});

// 'the client build knows what it owes' (the Systemisation shim and the Supabase schema spec)
// was removed on 15 Nov 2026 with the Supabase shadow build.

describe("the shell's badge poll mirrors the page's approval queue", () => {
  // The sidebar badge is polled by js/shared.js BEFORE the tab is ever
  // opened (trust surfaces report absence, 24 Aug 2026). Its population
  // must be the SAME queue the page renders: identical formula, identical
  // Kevin-lane rule — a drifted copy silently shows him the wrong count.
  const shared = read('js/shared.js');

  it('formula strings are identical', () => {
    const m = shared.match(/AGENTS_BADGE_FORMULA = "([^"]+)"/);
    expect(m).not.toBeNull();
    expect(agentsPage).toContain(m[1]);
  });

  it('both filter to the Kevin lane on the same approver field', () => {
    for (const src of [shared, agentsPage]) {
      expect(src).toContain('fldLLAG5HQPEFEfE5');
      expect(src).toContain('kevin@runpreneur.org.uk');
    }
  });
});
