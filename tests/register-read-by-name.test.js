// "POSSIBLE FIELD ID DRIFT" WAS A READ BUG, AND THE WRONG DIAGNOSIS SHIPPED.
//
// Finding 20260910-daily-ops-515. The 10 Sep 2026 06:45 CEO slot reported:
// "AI Agents register: Status field ID `fld71vXWqcxhdljac` returning '?' for
// all 26 rows. Possible field ID drift; scores unreadable." It then filed the
// whole workforce section as UNCONFIRMED.
//
// The field ID has not drifted. Verified live on 10 Sep 2026 against
// tbl9msVjyQWslLOIZ:
//     fields[]=Status                              -> {"Status": "Live"}
//     fields[]=fld71vXWqcxhdljac                   -> {"Status": "Live"}
//     fields[]=fld71vXWqcxhdljac&returnFieldsByFieldId=true
//                                                  -> {"fld71vXWqcxhdljac": "Live"}
//
// Airtable ACCEPTS a field ID in `fields[]` and answers with keys by NAME
// unless returnFieldsByFieldId=true is also sent. So a reader that asks by ID
// and then looks the ID up in the response gets nothing on every row — the
// mirror image of the returnFieldsByFieldId anti-pattern already in CLAUDE.md.
//
// Two things are guarded: the skill tells the agent to read by NAME, and it
// carries the control that says an all-'?' Status column is a broken read
// rather than drift. A metric you cannot attribute cannot be acted on, and a
// confident wrong cause in a closing report is worse than no line at all.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKILL = resolve(__dirname, '../.claude/scheduled-tasks/ceo-huddle/SKILL.md');
const src = readFileSync(SKILL, 'utf8');

// The paragraph that covers the AI Agents register read, from the register's
// table id to the end of that bullet.
const block = src.slice(src.indexOf('tbl9msVjyQWslLOIZ'),
                        src.indexOf('Stuck approvals:'));

describe('the CEO reads the AI Agents register by field NAME', () => {
  it('names the four fields by name, not only by id', () => {
    expect(block).toMatch(/fields\[\]=Status/);
    expect(block).toMatch(/fields\[\]=Guardrail Level/);
    expect(block).toMatch(/fields\[\]=Metric Score/);
    expect(block).toMatch(/fields\[\]=Learning Log/);
  });

  it('says an id in fields[] needs returnFieldsByFieldId on BOTH sides', () => {
    // Half the flag is the bug: setting it on the request and parsing by name
    // fails the same way round the other side.
    expect(block).toMatch(/returnFieldsByFieldId=true/);
    expect(block).toMatch(/read\s+the response back by ID/i);
  });

  it('carries the control: all rows empty is a broken read, not drift', () => {
    expect(block).toMatch(/BROKEN READ, never field drift/);
    expect(block).toMatch(/read it\s+again by name/i);
  });

  it('records the 10 Sep evidence that the id itself is intact', () => {
    expect(block).toContain('fld71vXWqcxhdljac');
    expect(block).toMatch(/10 Sep 2026/);
    expect(block).toMatch(/has not drifted/);
  });

  it('the repo mirror matches the live skill file', () => {
    // sync-scheduled-tasks.py owns this; the assertion is here so a fix made
    // only in ~/.claude never lands as a green PR that changed nothing real.
    const live = readFileSync(
      '/Users/kevinbrittain/.claude/scheduled-tasks/ceo-huddle/SKILL.md', 'utf8');
    expect(live).toBe(src);
  });
});
