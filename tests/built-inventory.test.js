import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── EVERYTHING BUILT, READ FROM THE FILES THAT RUN IT (Kevin, 29 Sep 2026) ──
//
// scripts/built_inventory.py feeds the AI Agents page's Track record tab
// through the built-inventory row of the Estate Status table. These tests
// drive the real module against a throwaway Mac home and repo:
//   * each source is read and joined: job schedule on/off, parked, not loaded,
//     loaded from outside LaunchAgents, scheduled but not installed, the
//     Claude-scheduler routine; agent rows written `key, agent, name`
//   * the hand-kept list is read as data, in either quote style, with JS escapes
//   * drift is reported both ways where a machine source exists
//   * EVERY source under its floor fails, counted on what it PARSED
//   * the payload is shrunk to fit the Airtable field, and says so
//   * estate-status.py always carries the row, and a failed build keeps the
//     last good list (no payload written)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = resolve(ROOT, 'scripts/built_inventory.py');
const ESTATE = resolve(ROOT, 'scripts/estate-status.py');
const TMP = mkdtempSync(join(tmpdir(), 'built-inv-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function py(snippet) {
  seq += 1;
  const home = join(TMP, `home-${seq}`), repo = join(TMP, `repo-${seq}`);
  const script = `
import importlib.util, json, os, plistlib, shutil, sys
HOME, REPO = ${JSON.stringify(home)}, ${JSON.stringify(repo)}
def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(text)
def plist(folder, key, body):
    os.makedirs(folder, exist_ok=True)
    body = dict({"Label": "com.kevinbrittain." + key, "ProgramArguments": ["/bin/true"]}, **body)
    with open(os.path.join(folder, "com.kevinbrittain.%s.plist" % key), "wb") as fh:
        plistlib.dump(body, fh)
la = os.path.join(HOME, "Library", "LaunchAgents")
sched = {"_comment": ["x"]}
loaded = []
for i in range(22):
    key = "job%02d" % i
    plist(la, key, {"StartCalendarInterval": {"Hour": 6, "Minute": i}})
    sched[key] = {"cron": "%d 6 * * *" % i, "mode": "wrapped"}
    if key != "job03":
        loaded.append("com.kevinbrittain." + key)
sched["job01"]["enabled"] = False
del sched["job20"]
plist(la, "job20", {"StartCalendarInterval": {"Weekday": 5, "Hour": 21, "Minute": 0}})
plist(la, "stay-awake", {"KeepAlive": True})
loaded += ["com.kevinbrittain.stay-awake", "com.kevinbrittain.elsewhere-job", "com.apple.notours"]
with open(os.path.join(la, "com.kevinbrittain.job00.plist.bak-2026"), "wb") as fh:
    plistlib.dump({"Label": "ignored"}, fh)
plist(os.path.join(HOME, "Library", "LaunchAgents.parked"), "prospecting", {})
plist(os.path.join(HOME, "Library", "LaunchAgents.parked"), "parked-running", {})
loaded.append("com.kevinbrittain.parked-running")
w(os.path.join(HOME, "Library", "LaunchAgents.parked", "com.kevinbrittain.parked-corrupt.plist"), "not a plist")
sched["daily-ops"] = {"cron": "0 7 * * *", "mode": "cooperative"}
sched["wrapped-missing"] = {"cron": "5 5 * * *", "mode": "wrapped"}
w(os.path.join(REPO, "scripts", "job-schedule.json"), json.dumps(sched))
w(os.path.join(REPO, "js", "automations-data.js"), r"""var AUTOMATIONS = { macJobs: [
    { key: 'job00', name: 'Job Zero', when: 'x', status: 'on',
      what: 'Does the zeroth thing, it\\'s fine.' },
    { key: "job02", name: "Job Two", when: 'x', status: 'on', what: "Kevin\\u2019s job \\u2014 two." },
    { key: 'daily-ops', agent: true, name: 'Systems Check', when: '7am', status: 'on', what: 'The 07:00 routine.' },
    { key: 'ghost-job', name: 'Ghost', when: 'x', status: 'on', what: 'Listed, never run.' },
    { key: 'old-job', name: 'Old', when: 'x', status: 'off', what: 'Switched off on purpose.' },
  ], workers: [ { name: 'w0', when: 'x', status: 'on', what: 'Worker zero.' } ] };""")
w(os.path.join(REPO, "js", "skills-data.js"), "var SKILLS_LIBRARY = [ { id: 'sk00', command: 'anthropic-skills:pk00', instructions: 'mentions sk01 and sk02 in passing' } ];")
for i in range(12):
    w(os.path.join(HOME, ".claude", "agents", "ag%02d.md" % i), '---\\nname: ag%02d\\ndescription: "Agent %d does \\\\"work\\\\"."\\n---\\nbody' % (i, i))
w(os.path.join(HOME, ".claude", "agents", "ESTATE.md"), "# How the estate works")
for i in range(10):
    w(os.path.join(HOME, ".claude", "skills", "sk%02d" % i, "SKILL.md"), "---\\nname: sk%02d\\ndescription: >\\n  Folded\\n  description %d.\\n---\\n" % (i, i))
for i in range(6):
    w(os.path.join(REPO, ".claude", "skills", "pk%02d" % i, "SKILL.md"), "---\\nname: pk%02d\\ndescription: Project skill.\\n---\\n" % i)
w(os.path.join(REPO, ".claude", "skills", "sk05", "SKILL.md"), "---\\nname: sk05\\ndescription: Same skill in both places.\\n---\\n")
for i in range(12):
    desc = "RETIRED 1 Sep." if i == 0 else ("ABSORBED into daily-ops as phase 3." if i == 1 else "Runs.")
    w(os.path.join(HOME, ".claude", "scheduled-tasks", "t%02d" % i, "SKILL.md"), "---\\nname: t%02d\\ndescription: %s\\n---\\n" % (i, desc))
for i in range(5):
    w(os.path.join(REPO, "workers", "w%d" % i, "wrangler.toml"),
      'name = "w%d"\\nmain = "x.js"\\n%s[[kv_namespaces]]\\nname = "NOT_THE_NAME"\\n' % (i, '[triggers]\\ncrons = ["* * * * *"]\\n' if i == 1 else ('[triggers]\\ncrons = []\\n' if i == 2 else '')))
w(os.path.join(REPO, "cloudflare-worker", "wrangler.toml"), 'name = "claude-proxy"\\n')
w(os.path.join(REPO, ".github", "workflows", "sync.yml"), "name: Sync projects\\non:\\n  schedule:\\n    - cron: '41 * * * *'\\n")
w(os.path.join(REPO, ".github", "workflows", "bump.yml"), "name: Auto-bump\\non: push\\n")
os.environ["BUILT_HOME"], os.environ["BUILT_REPO"] = HOME, REPO
os.environ["BUILT_LAUNCHCTL_LIST"] = ",".join(loaded)
spec = importlib.util.spec_from_file_location("bi", ${JSON.stringify(MODULE)})
bi = importlib.util.module_from_spec(spec); spec.loader.exec_module(bi)
def fails(fn):
    try:
        fn(); return None
    except bi.SourceFailure as e:
        return str(e)
out = {}
${snippet}
print("RESULT " + json.dumps(out))
`;
  const stdout = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
}

describe('built_inventory reads the real sources', () => {
  const r = py(`
inv = bi.build()
g = {x["id"]: x["items"] for x in inv["groups"]}
out["counts"] = inv["counts"]
out["missing"] = inv["missing"]
out["mac"] = {j["k"]: [j["s"], j.get("w"), j["n"], j["d"], j.get("via")] for j in g["mac-jobs"]}
out["tasks"] = {t["k"]: t["s"] for t in g["scheduled-tasks"]}
out["agents"] = {a["k"]: [a["s"], a["d"]] for a in g["agent-files"]}
out["skills"] = [[s["k"], s["s"], s["d"]] for s in g["skills"]]
out["workers"] = {x["k"]: [x["s"], x["w"], x["d"]] for x in g["workers"]}
out["timers"] = {x["k"]: x["s"] for x in g["github-timers"]}
out["chars"] = len(json.dumps(inv, separators=(",", ":")))
`);

  it('joins each Mac job to the schedule and to what launchd has loaded', () => {
    expect(r.mac.job00).toEqual(['on', '0 6 * * *', 'Job Zero', "Does the zeroth thing, it's fine.", null]);
    expect(r.mac.job01[0]).toBe('off');
    expect(r.mac.job03[0]).toBe('not loaded');                       // a plist launchd is not running
    expect(r.mac.prospecting[0]).toBe('parked');
    expect(r.mac['stay-awake'][1]).toBe('always on');
    expect(r.mac.job20[1]).toBe('21:00 (Fri)');                     // no schedule entry: the plist, weekday and all
    expect(r.mac['elsewhere-job'][0]).toBe('on');                   // loaded from a plist outside LaunchAgents
    expect(r.mac['daily-ops']).toEqual(['on', '0 7 * * *', 'Systems Check', 'The 07:00 routine.', 'Claude scheduler']);
    expect(r.mac['wrapped-missing'][0]).toBe('not installed');      // scheduled, but no launchd job
    expect(Object.keys(r.mac)).not.toContain('ignored');            // a .bak plist is not a job
    expect(Object.keys(r.mac)).not.toContain('notours');            // someone else's label
    expect(r.mac['parked-running']).toEqual(['on', '', 'parked-running', '', 'parked, but launchd still runs it']);
    // 22 plists + stay-awake, minus job01 off and job03 not loaded, plus parked-running, elsewhere-job and daily-ops
    expect(r.counts.macJobs).toBe(24);
  });

  it('reads the hand-kept list in either quote style, JS escapes decoded', () => {
    expect(r.mac.job02[2]).toBe('Job Two');
    expect(r.mac.job02[3]).toBe('Kevin’s job — two.');
  });

  it('reads agents, skills (folded descriptions too), workers and GitHub timers', () => {
    expect(r.agents.ag03).toEqual(['live', 'Agent 3 does "work".']);
    expect(r.agents.ESTATE[0]).toBe('reference');
    expect(r.counts.agentFiles).toBe(12);
    expect(r.skills).toContainEqual(['sk02', 'global', 'Folded description 2.']);
    expect(r.skills).toContainEqual(['sk05', 'project', 'Same skill in both places.']);
    expect(r.counts.skills).toBe(16);                                 // sk05 in both places counts once
    expect(r.workers.w1).toEqual(['on', '* * * * * (UTC)', '']);
    expect(r.workers.w2[0]).toBe('no timer');                        // crons = [] is not "off"
    expect(r.workers.w0[2]).toBe('Worker zero.');
    expect(r.workers['claude-proxy'][1]).toBe('on request');
    expect(Object.keys(r.workers)).not.toContain('NOT_THE_NAME');    // a section's name is not the worker's
    expect(r.timers).toEqual({ 'bump.yml': 'on push', 'sync.yml': 'timer' });
  });

  it('marks retired and absorbed instructions for what they are', () => {
    expect(r.tasks.t00).toBe('retired');
    expect(r.tasks.t01).toBe('inside daily-ops');
    expect(r.tasks.t05).toBe('on');
    expect(r.counts.scheduledTasks).toBe(11);
  });

  it('reports drift both ways where a machine source exists', () => {
    expect(r.missing.automations).toContain('job04');
    expect(r.missing.automations).toContain('elsewhere-job');
    expect(r.missing.automations).not.toContain('job00');
    expect(r.missing.automations).not.toContain('daily-ops');       // an agent row written key, agent, name
    expect(r.missing.automations).not.toContain('job03');           // not running, so not "running but unlisted"
    expect(r.missing.listedNotFound).toEqual(['ghost-job']);        // old-job is listed as off: not a gap
    expect(r.missing.notInstalled).toEqual(['wrapped-missing']);
    expect(r.missing.notLoaded).toEqual(['job03']);
    expect(r.missing.parkedButRunning).toEqual(['parked-running']);
    expect(r.mac['parked-corrupt'][0]).toBe('unreadable');
    expect(r.missing.notLoaded).not.toContain('parked-corrupt');   // parked on purpose is not "not running as expected"
    expect(r.missing.workers).toContain('w1');
    // The Skills Library lists sk00 by id and pk00 by command. sk01 is only
    // MENTIONED in another entry's text, which does not count as listed.
    expect(r.missing.skills).not.toContain('sk00');
    expect(r.missing.skills).not.toContain('pk00');
    expect(r.missing.skills).toContain('sk01');
  });

  it('fits well inside the Airtable field', () => {
    expect(r.chars).toBeLessThan(90000);
  });
});

describe('a broken read fails loudly, never as a smaller estate', () => {
  const r = py(`
A = os.path.join(HOME, ".claude")
out["mac"] = fails(lambda: (shutil.rmtree(os.path.join(HOME, "Library", "LaunchAgents")), bi.build()))
`);
  it('an unreadable LaunchAgents folder raises with the reason', () => {
    expect(r.mac).toMatch(/read 0 Mac jobs .*expected 20\+.*not an empty estate/);
  });

  it('every other source raises when it PARSES too little, even with its files present', () => {
    const b = py(`
def strip_front_matter(pattern):
    import glob
    for p in glob.glob(pattern):
        open(p, "w").write("no front matter here")
out["agents"] = fails(lambda: (strip_front_matter(os.path.join(HOME, ".claude", "agents", "*.md")), bi.build()))
`);
    expect(b.agents).toMatch(/parsed 0 agent files of 13 \(expected 10\+\)/);
    const s = py(`
import glob
for p in glob.glob(os.path.join(HOME, ".claude", "skills", "*", "SKILL.md")) + glob.glob(os.path.join(REPO, ".claude", "skills", "*", "SKILL.md")):
    open(p, "w").write("---\\ndescription: no name\\n---\\n")
out["msg"] = fails(bi.build)
`);
    expect(s.msg).toMatch(/parsed 0 skills of 17 files/);
    const t = py(`
import glob
for p in glob.glob(os.path.join(HOME, ".claude", "scheduled-tasks", "*", "SKILL.md")):
    open(p, "w").write("plain text")
out["msg"] = fails(bi.build)
`);
    expect(t.msg).toMatch(/parsed 0 scheduled-task instructions of 12 files/);
    const wk = py(`
shutil.rmtree(os.path.join(REPO, "workers"))
out["msg"] = fails(bi.build)
`);
    expect(wk.msg).toMatch(/read 1 workers \(expected 5\+\)/);
    const gh = py(`
os.remove(os.path.join(REPO, ".github", "workflows", "sync.yml"))
out["msg"] = fails(bi.build)
`);
    expect(gh.msg).toMatch(/found no scheduled GitHub workflow/);
  });
});

describe('a launchd read of the wrong domain is "unknown", never "nothing loaded"', () => {
  it('keeps every plist on and says it could not check', () => {
    const r = py(`
os.environ["BUILT_LAUNCHCTL_LIST"] = "com.apple.Finder"
inv = bi.build()
g = {x["id"]: x["items"] for x in inv["groups"]}
out["macJobs"] = inv["counts"]["macJobs"]
out["notes"] = inv.get("notes")
out["job03"] = [j["s"] for j in g["mac-jobs"] if j["k"] == "job03"][0]
`);
    expect(r.job03).toBe('on');
    expect(r.macJobs).toBeGreaterThanOrEqual(20);
    expect(r.notes[0]).toMatch(/could not check what launchd has loaded: it listed 0 of the 23 jobs here/);
  });
});

describe('JS string literals in the hand-kept list decode as JS does', () => {
  it('handles \\\' in double quotes, \\xHH, line continuations and a " inside single quotes', () => {
    const r = py(`
src = r"""{ key: 'a', name: "Kevin\\'s", what: 'said "hi" \\x41' },
{ key: 'b', name: 'B', what: "one \\
two" }"""
jobs, _ = bi.automation_entries(src)
out["a"] = [jobs["a"]["name"], jobs["a"]["what"]]
out["b"] = jobs["b"]["what"]
`);
    expect(r.a).toEqual(["Kevin's", 'said "hi" A']);
    expect(r.b).toBe('one two');
  });

  it('an escaped backslash is a backslash, never the start of another escape', () => {
    const r = py(`
src = r"""{ key: 'c', name: 'C:\\\\x41', what: "a\\\\'b" }"""
jobs, _ = bi.automation_entries(src)
out["c"] = [jobs["c"]["name"], jobs["c"]["what"]]
`);
    expect(r.c).toEqual(['C:\\x41', "a\\'b"]);
  });
});

describe('the payload is shrunk to fit, and says so', () => {
  it('trims long descriptions under the cap and records it', () => {
    const r = py(`
inv = bi.build()
for g in inv["groups"]:
    for it in g["items"]:
        it["d"] = "x" * 900
small = bi.fit(inv, cap=40000)
out["chars"] = len(json.dumps(small, separators=(",", ":")))
out["trimmed"] = small.get("trimmed")
`);
    expect(r.chars).toBeLessThanOrEqual(40000);
    expect([100, 50, 0]).toContain(r.trimmed);
  });
});

describe('estate-status.py carries it as one report row', () => {
  const r = py(`
from datetime import datetime, timezone
es_spec = importlib.util.spec_from_file_location("es", ${JSON.stringify(ESTATE)})
es = importlib.util.module_from_spec(es_spec); es_spec.loader.exec_module(es)
now = datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)
ok = es.built_row(now, module_path=${JSON.stringify(MODULE)})
out["ok"] = {k: ok.get(k) for k in ("key", "kind", "status", "detail")}
out["okPayload"] = json.loads(ok["payload"])["counts"]
# The whole ten-minute board, with every other source stubbed: the row must be in it,
# or upsert() would mark it "No longer scheduled".
es.load_schedule = lambda *a, **k: {"x": {"cron": "0 1 * * *"}}
es.read_jsonl = lambda *a, **k: []
es.load_labels = lambda: {}
es.classify = lambda job, *a, **k: {"key": job, "kind": "job", "status": "Idle"}
for name in ("allowance_row", "needs_you_row", "robot_signins_row", "blockers_row"):
    setattr(es, name, (lambda n: lambda now: {"key": n, "kind": "report", "status": "Worked"})(name))
es.BUILT_MODULE = ${JSON.stringify(MODULE)}
out["boardKeys"] = [row["key"] for row in es.build_rows(now, with_loop_health=False)]
os.environ["BUILT_HOME"] = "/nonexistent-home"
bad = es.built_row(now, module_path=${JSON.stringify(MODULE)})
out["bad"] = {k: bad.get(k) for k in ("status", "detail")}
out["badHasPayload"] = "payload" in bad
out["badFields"] = sorted(es.to_fields(bad, now).keys())
out["payloadField"] = es.ES["payload"]
`);

  it('writes a Worked row with the counts', () => {
    expect(r.ok.key).toBe('built-inventory');
    expect(r.ok.kind).toBe('report');
    expect(r.ok.status).toBe('Worked');
    expect(r.ok.detail).toMatch(/^24 Mac jobs, 12 agent files, 16 skills, 6 workers, 1 GitHub timers, 11 scheduled tasks; \d+ not yet on the hand-kept lists; 4 Mac jobs not running as expected$/);
    expect(r.okPayload.macJobs).toBe(24);
  });

  it('is always on the ten-minute board', () => {
    expect(r.boardKeys).toContain('built-inventory');
  });

  it('a failed build says why and leaves the last good list in place', () => {
    expect(r.bad.status).toBe('Failed');
    expect(r.bad.detail).toMatch(/Could not build the everything-built list: read 0 Mac jobs/);
    expect(r.badHasPayload).toBe(false);
    expect(r.badFields).not.toContain(r.payloadField);
  });
});
