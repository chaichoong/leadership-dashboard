/**
 * scripts/airtable-read.py — the robots' one-command Airtable reader.
 *
 * WHY (findings 20261013-ceo-agent-856 and 20261011-phase-2-765): the
 * department heads are started with an allow list of commands that must START
 * with python3, curl or node. A pipe is not such a command, and neither is
 * `$(cat token)`, so on 13 and 14 Oct 2026 the 06:45 CEO huddle reported three
 * lanes NOT CHECKED two days running — no head could read a single row.
 *
 * These tests DRIVE the real script (a test that only greps source is theatre)
 * against a stub Airtable run inside the same python process, because the bugs
 * worth catching here are ones this repo has already shipped: a read that
 * follows only the first page, a token that reaches a log, and a reader that
 * grows a write path.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/airtable-read.py');
const SECRET = 'patFAKE0000000000.thisMustNeverBePrinted';

const dir = mkdtempSync(join(tmpdir(), 'atread-'));
const patFile = join(dir, 'pat');
writeFileSync(patFile, SECRET + '\n');

const run = (args, env = {}) => {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AIRTABLE_PAT_FILE: patFile,
           AIRTABLE_BASE_ID: 'appTEST', ...env },
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
};

/** Runs the real read_table() against a two-page stub served in-process. */
const driveStub = () => {
  const py = `
import importlib.util, json, threading, http.server, socketserver, urllib.parse

SEEN = []

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        SEEN.append(("GET", self.path, self.headers.get("Authorization") or ""))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if q.get("offset"):
            body = {"records": [{"id": "rec2", "fields": {"Status": "Today"}}]}
        else:
            body = {"records": [{"id": "rec1", "fields": {"Status": "Today"}}],
                    "offset": "pg2"}
        b = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_POST(self):
        SEEN.append(("POST", self.path, ""))
        self.send_response(405); self.end_headers()

srv = socketserver.TCPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

spec = importlib.util.spec_from_file_location("atr", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.API = "http://127.0.0.1:%d/v0" % port

rows, pages = m.read_table("Tasks", formula="{Status}='Today'")
srv.shutdown()
print(json.dumps({"rows": [r["id"] for r in rows], "pages": pages,
                  "seen": SEEN}))
`;
  const r = spawnSync('python3', ['-c', py], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AIRTABLE_PAT_FILE: patFile, AIRTABLE_BASE_ID: 'appTEST' },
  });
  if (r.status !== 0) throw new Error(`stub run failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim());
};

describe('airtable-read.py', () => {
  it('is one bare python3 command: it reads the token itself, no shell glue', () => {
    // The whole point. A head may only run a command starting with python3,
    // so a pipe, a $(cat ...) or a shell-out would put it back behind the wall.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('PAT_FILE');
    expect(src).not.toMatch(/subprocess|os\.system|shell=True/);
  });

  it('paginates to the end: a two-page read returns BOTH rows', () => {
    const got = driveStub();
    expect(got.rows).toEqual(['rec1', 'rec2']);
    expect(got.pages).toBe(2);
  });

  it('sends the token as a Bearer header, never in the URL', () => {
    const got = driveStub();
    const authed = got.seen.filter((s) => String(s[2]).startsWith('Bearer '));
    expect(authed.length).toBe(2);               // one per page
    expect(got.seen.map((s) => s[1]).join(' ')).not.toContain(SECRET);
  });

  it('is read-only: every request is a GET and no write path exists', () => {
    const got = driveStub();
    expect(got.seen.every((s) => s[0] === 'GET')).toBe(true);
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/method\s*=\s*["'](POST|PATCH|PUT|DELETE)/i);
    expect(src).not.toMatch(/data\s*=\s*json\.dumps/);
  });

  it('a missing token file is a loud JSON error, exit 2, with no token in it', () => {
    const r = run(['Tasks'], { AIRTABLE_PAT_FILE: join(dir, 'gone') });
    expect(r.status).toBe(2);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/cannot read the Airtable token file/);
    expect(r.out + r.err).not.toContain(SECRET);
  });

  it('an empty token file is refused, not sent as an empty Bearer', () => {
    const empty = join(dir, 'empty');
    writeFileSync(empty, '   \n');
    const r = run(['Tasks'], { AIRTABLE_PAT_FILE: empty });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.out).error).toMatch(/empty/);
  });

  it('no table named is refused, not guessed', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.out).error).toMatch(/no table given/);
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
