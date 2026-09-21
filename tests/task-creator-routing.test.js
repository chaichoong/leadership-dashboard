import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// 21 Sep 2026. The claude.ai skill "airtable-task-creator" still described itself as
// creating tasks for "Kevin / Mica / Ericamae", told the caller to STOP if the owner was
// "Gary, Roy, or Rob" (Roy has been head of the property business, a team member, since
// 25 Aug 2026), and defaulted the assignee to Kevin. Every one of those contradicts a
// ruling: no work routes to Mica since 25 Aug 2026, Ericamae left on 17 Sep 2026, and a
// blank Assignee is how an AI agent owns a task. The project copy below is the fix. This
// test exists so a re-sync from claude.ai, or a tidy-up of the file, cannot bring the old
// routing back, and so its IDs cannot drift away from the code that owns them.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(resolve(ROOT, '.claude/skills/airtable-task-creator/SKILL.md'), 'utf8');
const CONFIG = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
const DISPATCH = readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8');

// Each entry: a phrase the routing must keep, and what is lost if it goes.
const ROUTING_CLAUSES = [
  ['Leave **Assignee blank**', 'the default: an AI agent owns the task through Team Member'],
  ['A blank Assignee is not a gap', 'the reason a blank Assignee must never be filled'],
  ['Roy is a TEAM MEMBER, not a contractor', "Roy's role since 25 Aug 2026"],
  ['--to roy.lavin1978@gmail.com', 'the handover that emails Roy the work'],
  ['No task has been routed to Mica since 25 Aug 2026', 'the Mica ruling'],
  ['She left on 17 Sep 2026', 'Ericamae has left'],
  ['**Kevin, the last resort.**', 'Kevin only when no agent can do it'],
  ['REPLACES the claude.ai skill', 'the note that this copy replaces the claude.ai skill'],
  ['python3 scripts/create-agent-task.py create', 'the create-time duplicate gate'],
  ['"fldx4qCw17UfrKpaN": "Today"', 'Status set at create (the creation automation is undeployed)'],
];

// Wording the rulings retired. Any of these back in the file is the old skill returning.
const RETIRED = [
  ['Kevin / Mica / Ericamae', 'internal team listed as Mica and Ericamae'],
  ['(Kevin, Mica, Ericamae)', 'internal team listed as Mica and Ericamae'],
  ['Gary, Roy, or Rob', 'Roy treated as a contractor'],
  ['Gary/Roy/Rob', 'Roy treated as a contractor'],
  ['**Default Assignee**: Kevin', 'Kevin as the default assignee'],
  ['default: Kevin Brittain', 'Kevin as the default assignee'],
  ['manus-mcp-cli tool call', 'a command that cannot run here'],
];

describe('airtable-task-creator routing (project copy)', () => {
  it.each(ROUTING_CLAUSES)('keeps %s', (phrase, loses) => {
    expect(SKILL, `SKILL.md no longer states: ${loses}`).toContain(phrase);
  });

  it.each(RETIRED)('does not carry retired wording %s', (phrase, why) => {
    expect(SKILL, `retired wording is back: ${why}`).not.toContain(phrase);
  });

  it('every field ID it writes is one js/config.js defines', () => {
    const ids = [...new Set(SKILL.match(/\bfld[A-Za-z0-9]{14}\b/g))];
    expect(ids.length).toBeGreaterThanOrEqual(9);
    const missing = ids.filter((id) => !CONFIG.includes(`'${id}'`));
    expect(missing, `field IDs not in js/config.js: ${missing.join(', ')}`).toEqual([]);
  });

  it('every table ID it uses is one js/config.js defines', () => {
    const ids = [...new Set(SKILL.match(/\btbl[A-Za-z0-9]{14}\b/g))];
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const missing = ids.filter((id) => !CONFIG.includes(`'${id}'`) && !DISPATCH.includes(id));
    expect(missing, `table IDs not in the code: ${missing.join(', ')}`).toEqual([]);
  });

  it('the owner records match the constants agent-dispatch.py routes by', () => {
    const ceo = DISPATCH.match(/^CEO_REC_ID = "(rec[A-Za-z0-9]{14})"/m)[1];
    const kevin = DISPATCH.match(/^KEVIN_REC_ID = "(rec[A-Za-z0-9]{14})"/m)[1];
    const roy = DISPATCH.match(/"roy\.lavin1978@gmail\.com": \{"rec": "(rec[A-Za-z0-9]{14})"/)[1];
    const kevinUsr = DISPATCH.match(/^KEVIN_APPROVER_USR = "(usr[A-Za-z0-9]{14})"/m)[1];
    expect(SKILL).toContain(`\`${ceo}\``);
    expect(SKILL).toContain(`\`${kevin}\``);
    expect(SKILL).toContain(`\`${roy}\``);
    expect(SKILL).toContain(kevinUsr);
    // The default owner in Phase 1 is the CEO's row, never Kevin's.
    expect(SKILL).toContain(`"flduCtmQGpOA4eWaj": ["${ceo}"]`);
  });
});
