// scripts/check-data-invariants.py must count EVERY violation, not the first page.
//
// Regression origin: 9 Aug 2026. `query()` sent pageSize=100 and returned
// body['records'] without ever following body['offset']. The
// open-tasks-carry-no-completion-date invariant printed "100 VIOLATION(S)" when the
// true population was 143. Nothing errored. A round number reads as a real count,
// which is exactly why it sat unnoticed — the same failure that made the AI
// Reconciliation Accuracy card report 66/100 against a 259-row window.
//
// It was living inside the script written to catch that class of bug.
//
// These tests drive the real function against a local stub that paginates the way
// Airtable does, via the AIRTABLE_API_BASE override. Back-tested: deleting the
// `while`/offset loop from query() makes the 143-row case return exactly 100 and
// this file goes red.

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

// execFileSync would deadlock: it blocks the event loop, so the stub server in this
// same process could never answer the request python3 is waiting on.
const run = promisify(execFile);

const SCRIPT = resolve(__dirname, '../scripts/check-data-invariants.py');

// One page of 100 then a page of 43 — the exact shape of the 9 Aug incident.
const TOTAL = 143;
const PAGE = 100;

let requests = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push(url.search);
  const start = Number(url.searchParams.get('offset') || 0);
  const size = Number(url.searchParams.get('pageSize') || PAGE);
  const slice = [];
  for (let i = start; i < Math.min(start + size, TOTAL); i++) {
    slice.push({ id: `rec${String(i).padStart(5, '0')}`, fields: { n: i } });
  }
  const next = start + slice.length;
  const body = { records: slice };
  if (next < TOTAL) body.offset = String(next);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

const listening = new Promise((r) => server.listen(0, '127.0.0.1', r));
afterAll(() => server.close());

// Import the script as a module and call query() directly. No CLI flag is added to
// production code just to make it testable.
async function callQuery(kwargs = '') {
  await listening;
  const port = server.address().port;
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cdi", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
recs = m.query("fake-pat", "tblFake", "TRUE()"${kwargs})
print(json.dumps({"count": len(recs), "first": recs[0]["id"], "last": recs[-1]["id"]}))
`;
  const { stdout } = await run('python3', ['-c', py], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, AIRTABLE_API_BASE: `http://127.0.0.1:${port}` },
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

describe('check-data-invariants query() pagination', () => {
  it('returns all 143 records, not the first page of 100', async () => {
    requests = [];
    const r = await callQuery();
    expect(r.count).toBe(TOTAL);
    expect(r.first).toBe('rec00000');
    expect(r.last).toBe(`rec${String(TOTAL - 1).padStart(5, '0')}`);
  });

  it('actually follows the offset token rather than raising pageSize', async () => {
    requests = [];
    await callQuery();
    // Two requests: the first without an offset, the second carrying it.
    expect(requests.length).toBe(2);
    expect(requests[0]).not.toContain('offset=');
    expect(requests[1]).toContain('offset=100');
  });

  it('limit stops early, for existence-only reads like the field probe', async () => {
    requests = [];
    const r = await callQuery(', page_size=1, limit=1');
    expect(r.count).toBe(1);
    // One request only — a probe must not walk the whole table.
    expect(requests.length).toBe(1);
  });
});
