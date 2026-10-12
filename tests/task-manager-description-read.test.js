// Finding 20261010-task-manager-825: the board read never asked Airtable for Description, so
// the CHILD-OF guard in the fold check could not fire on live data.
//
// create-agent-task.py stamps "CHILD OF <parent id>" at the head of a follow-up's Description
// when an approved task's whole job was to raise it. fold_groups reads that stamp to keep the
// follow-up out of its parent's closable-twin list (finding 20261003-task-manager-733). But
// TASK_FIELDS omitted "Description", and an Airtable read returns only the fields it asks for,
// so f.get("Description") was "" on every real record and the guard was dead code in production
// while passing every hand-built-view test.
//
// This drives the REAL read path — cmd_board with query_all stubbed — rather than a hand-made
// view, which is exactly the gap the finding named.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TM = path.join(root, 'scripts/task-manager.py');

// Run cmd_board against a stubbed Airtable, capturing the field list each read asked for and
// the board JSON it produced.
function runBoard() {
  const out = execFileSync('python3', ['-c', `
import json, importlib.util, io, sys, contextlib
spec = importlib.util.spec_from_file_location("tm", ${JSON.stringify(TM)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

PARENT = "recPARENT00000001"
CHILD  = "recCHILD000000001"
THREAD = "https://mail.google.com/mail/u/0/#all/THX"
asked = []

def fake_query_all(table, formula, fields, why):
    asked.append({"why": why, "fields": list(fields)})
    if why != "board read":
        return []
    def rec(rid, name, created, desc=None):
        f = {"Task Name": name, "Status": "Today", "Created Time": created,
             "Due Date": "2026-10-12", "Team Member": ["recAGENT000000001"],
             "Assignee": None, "Inbound Note URL Link": THREAD}
        # the stub answers ONLY the fields the caller asked for, which is what Airtable does
        if desc is not None: f["Description"] = desc
        return {"id": rid, "fields": {k: v for k, v in f.items() if k in fields}}
    return [
        rec(PARENT, "INBOUND: Swinton policy renewal", "2026-10-01T10:00:00.000Z"),
        rec(CHILD, "INBOUND: Swinton policy renewal", "2026-10-02T10:00:00.000Z",
            "CHILD OF %s (an approved task whose job is to raise this one)" % PARENT),
    ]

m.query_all = fake_query_all
m.read_activity = lambda *a, **k: ([], set())
m.dispatch_in_flight = lambda *a, **k: set()
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_board()
board = json.loads(buf.getvalue())
print(json.dumps({"asked": asked, "board": board}))
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('task-manager board read asks for Description', () => {
  it('requests Description in the board read, so the CHILD OF stamp exists to read', () => {
    const r = runBoard();
    const boardRead = r.asked.find((a) => a.why === 'board read');
    expect(boardRead).toBeTruthy();
    expect(boardRead.fields).toContain('Description');
  });

  it('carries the CHILD OF stamp through to the view the slot reads', () => {
    const r = runBoard();
    const views = JSON.stringify(r.board);
    expect(views).toContain('CHILD OF recPARENT00000001');
  });
});
