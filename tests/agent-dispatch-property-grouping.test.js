import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── ONE JOB PER CERTIFICATE TYPE AND DISTRICT (Kevin, 17 Sep 2026) ─────────
//
// On 17 Sep 2026 three EICR renewals in CB9 (13 Chedburgh Place, 6 Chedburgh
// Place, 5 Dalham Place) sat as three tasks, which meant three agent runs,
// three rounds of quote emails to the same electricians and three cards.
// Kevin's ruling: one piece of property work is a certificate type plus a
// postcode district, everything due inside 60 days. These tests pin the
// grouping, the hold on siblings, and the submit refusal.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const SKILL = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/agent-dispatch/SKILL.md'), 'utf8');

function py(snippet) {
  const script = `
import importlib.util, json, sys
from datetime import date
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
TODAY = date(2026, 9, 17)
PA = m.PROPERTY_REC_ID
BOOK = [
  {"short": "13 Chedburgh Place", "postcode": "CB9 0AJ", "name": "13 Chedburgh Place, Haverhill, CB9 0AJ"},
  {"short": "6 Chedburgh Place", "postcode": "CB9 0AJ", "name": "6 Chedburgh Place, Haverhill, CB9 0AJ"},
  {"short": "5 Dalham Place", "postcode": "CB9 0AL", "name": "5 Dalham Place, Haverhill, CB9 0AL"},
  {"short": "23 Viola Street", "postcode": "L20 7DR", "name": "23 Viola Street, Bootle, L20 7DR"},
]
def t(id, name, due="2026-09-26", **kw):
    base = {"id": id, "name": name, "dueDate": due, "kind": "new", "tier1": False,
            "creditor": False, "agentId": PA, "teamMemberIds": [PA], "notes": "",
            "description": "", "status": "Today"}
    base.update(kw); return base
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('property work is grouped by certificate type and district', () => {
  it('reads one certificate type from a task name, and refuses to guess between two', () => {
    const out = py(`print(json.dumps([m.certificate_type(n) for n in [
      "COMPLIANCE: EICR renewal due 2026-09-26 - 6 Chedburgh Place",
      "COMPLIANCE: GSC renewal due 2026-09-08 - 5 Dalham Place",
      "COMPLIANCE: fire alarm and emergency lighting service - Duckworth Building",
      "COMPLIANCE: quote request - 6 Chedburgh Place"]]))`);
    expect(out).toEqual(['EICR', 'GSC', '', '']);
  });

  it('never reads 13 Chedburgh Place as 3 Chedburgh Place, and takes the district from the book', () => {
    const out = py(`print(json.dumps([
      m.task_district(t("r1", "COMPLIANCE: EICR renewal due 2026-09-06 - 13 Chedburgh Place"), BOOK),
      m.task_district(t("r2", "COMPLIANCE: EICR renewal - 23 Viola Street", description="AC1 Electrical, CB9 7AA"), BOOK),
      m.task_district(t("r3", "COMPLIANCE: EICR renewal - 1 Unknown Road"), BOOK)]))`);
    expect(out).toEqual(['CB9', 'L20', '']);
  });

  it('groups the three CB9 EICR renewals under the earliest due, and leaves everything else alone', () => {
    const out = py(`
wl = [
  t("recA0000000000006", "COMPLIANCE: EICR renewal due 2026-09-26 - 6 Chedburgh Place", "2026-09-26"),
  t("recA0000000000013", "COMPLIANCE: EICR renewal due 2026-09-06 - 13 Chedburgh Place", "2026-09-15"),
  t("recA0000000000005", "COMPLIANCE: EICR renewal due 2026-10-14 - 5 Dalham Place", "2026-10-14"),
  t("recG0000000000005", "COMPLIANCE: GSC renewal due 2026-09-08 - 5 Dalham Place", "2026-09-15"),
  t("recV0000000000023", "COMPLIANCE: EICR renewal - 23 Viola Street", "2026-09-20"),
  t("recT0000000000001", "COMPLIANCE: EICR renewal - 6 Chedburgh Place", "2026-09-20", tier1=True),
  t("recH0000000000001", "COMPLIANCE: EICR renewal - 6 Chedburgh Place", "2026-09-20", kind="carry_out"),
  t("recF0000000000001", "COMPLIANCE: EICR renewal - 5 Dalham Place", "2026-12-30"),
  t("recN0000000000001", "COMPLIANCE: EICR renewal - 5 Dalham Place", ""),
  t("recR0000000000001", "COMPLIANCE: EICR renewal - 5 Dalham Place", "2026-09-20", agentId="recOther", teamMemberIds=["recOther"]),
]
keep, held = m.group_property_work(wl, BOOK, TODAY)
lead = [x for x in keep if x.get("siblings")]
print(json.dumps({"kept": [x["id"] for x in keep], "held": [x["id"] for x in held],
  "lead": lead[0]["id"], "key": lead[0]["groupKey"], "sibs": [s["id"] for s in lead[0]["siblings"]],
  "heldLead": [x["groupLead"] for x in held]}))`);
    expect(out.lead).toBe('recA0000000000013');
    expect(out.key).toBe('EICR CB9');
    expect(out.sibs).toEqual(['recA0000000000006', 'recA0000000000005']);
    expect(out.held).toEqual(['recA0000000000006', 'recA0000000000005']);
    expect(out.heldLead).toEqual(['recA0000000000013', 'recA0000000000013']);
    // Single GSC, other district, tier 1, hand-back, beyond 60 days, no due date, other agent: all still worked alone.
    expect(out.kept).toEqual(['recA0000000000013', 'recG0000000000005', 'recV0000000000023',
      'recT0000000000001', 'recH0000000000001', 'recF0000000000001', 'recN0000000000001', 'recR0000000000001']);
  });

  it('holds a sibling while its lead is open, and releases it when the lead has closed', () => {
    const out = py(`
sib = t("recS0000000000001", "COMPLIANCE: EICR renewal - 6 Chedburgh Place",
        notes="[17 Sep 2026 10:00 - agent-dispatch] HELD UNDER recL0000000000001 (EICR CB9): worked in one job")
open_rows = lambda f: [{"id": "recL0000000000001", "fields": {m.AF["status"]: "Approval"}}]
closed_rows = lambda f: [{"id": "recL0000000000001", "fields": {m.AF["status"]: "Completed"}}]
def broken(f): raise RuntimeError("HTTP 500")
print(json.dumps({"lead": m.held_lead_id(sib),
  "open": sorted(m.open_lead_ids({"recL0000000000001"}, fetch=open_rows)),
  "closed": sorted(m.open_lead_ids({"recL0000000000001"}, fetch=closed_rows)),
  "broken": sorted(m.open_lead_ids({"recL0000000000001"}, fetch=broken)),
  "none": m.held_lead_id(t("recX0000000000001", "COMPLIANCE: EICR renewal - 6 Chedburgh Place"))}))`);
    expect(out.lead).toBe('recL0000000000001');
    expect(out.open).toEqual(['recL0000000000001']);
    expect(out.closed).toEqual([]);
    // A failed read keeps the sibling held: dispatching it twice is the worse failure.
    expect(out.broken).toEqual(['recL0000000000001']);
    expect(out.none).toBe('');
  });

  it('refuses a sibling from another district, another type, or missing from the coverage file', () => {
    const out = py(`
lead = t("recL0000000000001", "COMPLIANCE: EICR renewal due 2026-09-06 - 13 Chedburgh Place")
same = t("recS0000000000001", "COMPLIANCE: EICR renewal due 2026-09-26 - 6 Chedburgh Place")
cov_ok = "PROPERTY: 13 Chedburgh Place, Haverhill, CB9 0AJ\\nPROPERTY: 6 Chedburgh Place, Haverhill, CB9 0AJ\\nCONTRACTOR: AC1 covers CB9 (source: https://ac1.example/areas)"
cov_other = "PROPERTY: 23 Viola Street, Bootle, L20 7DR\\nCONTRACTOR: X covers L20 (source: https://x.example)"
print(json.dumps({
  "same": m.sibling_problem(lead, same, BOOK, cov_ok),
  "district": m.sibling_problem(lead, t("recV0000000000023", "COMPLIANCE: EICR renewal - 23 Viola Street"), BOOK),
  "type": m.sibling_problem(lead, t("recG0000000000005", "COMPLIANCE: GSC renewal - 5 Dalham Place"), BOOK),
  "coverage": m.sibling_problem(lead, same, BOOK, cov_other),
  "closed": m.sibling_problem(lead, t("recC0000000000001", "COMPLIANCE: EICR renewal - 6 Chedburgh Place", status="Completed"), BOOK),
  "itself": m.sibling_problem(lead, lead, BOOK)}))`);
    expect(out.same).toBe('');
    expect(out.district).toMatch(/EICR L20.*EICR CB9/);
    expect(out.type).toMatch(/GSC CB9.*EICR CB9/);
    expect(out.coverage).toMatch(/no PROPERTY line/);
    expect(out.closed).toMatch(/already Completed/);
    expect(out.itself).toMatch(/the lead itself/);
  });

  it('the dispatch skill runs one job per group and submits once with --siblings', () => {
    expect(SKILL).toContain('ONE JOB PER CERTIFICATE TYPE AND DISTRICT');
    expect(SKILL).toContain('--siblings');
    expect(SKILL).toContain('heldUnderLead');
  });
});
