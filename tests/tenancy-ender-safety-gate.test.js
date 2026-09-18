import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_SKILL = resolve(ROOT, '.claude/skills/airtable-tenancy-ender/SKILL.md');
const REPO_SCHEMA = resolve(ROOT, '.claude/skills/airtable-tenancy-ender/references/airtable_schema.md');
const PERSONAL_SKILL = resolve(homedir(), '.claude/skills/anthropic-skills/airtable-tenancy-ender/SKILL.md');

// 18 Sep 2026. Ending Kevin Radford's tenancy, the skill was one step away from
// setting Unit 1 - 25 Abercorn Court to Void. That unit is let to Cheffins for
// £1,096.80 a month. The tenancy's own Rental Unit link was EMPTY; a legacy copy
// of the record carried it. Nothing in the skill checked, and nothing would have
// errored: the occupancy rollups and the cash flow forecast would simply have been
// wrong. The gate below is the fix. This test exists so a re-sync of the upstream
// skill, or an edit that tidies the file, cannot quietly remove it again.

// Each entry: a phrase the gate must keep, and what is lost if it goes.
const GATE_CLAUSES = [
  ['## SAFETY GATE', 'the gate section itself'],
  ['skip the unit step entirely', 'the refusal to act when no unit is linked'],
  ['do not void the unit', 'the refusal to void a unit with another live tenancy'],
  ['fldxOnUDg49C2PNVW', 'the Tenancies link field to check'],
  ['fldmpIYp1cN0eQgWt', 'the Tenancies copy link field, which points at the legacy table'],
  ['Tenants Field', 'the warning that the plain-text occupant label is stale'],
  ['resolves the ID across the WHOLE BASE', 'the warning that a read against the wrong table still returns 200'],
  ["TRANSACTION's own `Tenancy` link", 'the only reliable test of whose money a payment is'],
];

describe('airtable-tenancy-ender safety gate', () => {
  const repo = readFileSync(REPO_SKILL, 'utf8');

  it.each(GATE_CLAUSES)('repo copy keeps %s', (phrase, loses) => {
    expect(repo, `SKILL.md no longer states: ${loses}`).toContain(phrase);
  });

  it('never presents voiding the unit as unconditional', () => {
    expect(repo).toMatch(/Set to 'Void'\. ONLY if the safety gate above passes\./);
  });

  it('records that the bundled script cannot run', () => {
    // It shells out to manus-mcp-cli against an MCP server that does not exist
    // here, and the airtable MCP connector is broken. Anyone who runs it gets
    // an exception, not a tenancy ended.
    expect(repo).toContain('The script does not run');
  });

  it('schema reference warns about the fields that misled', () => {
    const schema = readFileSync(REPO_SCHEMA, 'utf8');
    expect(schema).toContain('STALE FREE TEXT');
    expect(schema).toContain('OFTEN EMPTY');
    expect(schema).toContain('RENAMED from `Tenants`');
  });

  // The copy the app actually loads lives outside git. If it is installed, it
  // must carry the same gate: a repo copy alone protects nothing at runtime.
  it('installed personal copy carries the gate too', () => {
    if (!existsSync(PERSONAL_SKILL)) return; // not installed on this machine
    const personal = readFileSync(PERSONAL_SKILL, 'utf8');
    for (const [phrase, loses] of GATE_CLAUSES) {
      expect(personal, `installed skill no longer states: ${loses}`).toContain(phrase);
    }
  });
});
