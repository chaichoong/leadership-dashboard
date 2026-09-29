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
//   * each source is read and joined (job schedule on/off, parked, lockless
//     Claude-scheduler jobs, agent rows written `key, agent, name`)
//   * anything running that the hand-kept lists miss is reported
//   * a source under its floor FAILS, never returns a shorter list
//     (back-test: set any FLOORS value to 0 and the floor test fails)
//   * the payload is shrunk to fit the Airtable field, and says so
//   * estate-status.py turns a failure into a red row with the reason

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = resolve(ROOT, 'scripts/built_inventory.py');
const ESTATE = resolve(ROOT, 'scripts/estate-status.py');
const TMP = mkdtempSync(join(tmpdir(), 'built-inv-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function py(snippet, { skipLaunchAgents = false } = {}) {
  seq += 1;
  const home = join(TMP, `home-${seq}`), repo = join(TMP, `repo-${seq}`);
  const script = `
import importlib.util, json, os, plistlib, sys
HOME, REPO = ${JSON.stringify(home)}, ${JSON.stringify(repo)}
def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(text)
la = os.path.join(HOME, "Library", "LaunchAgents")
os.makedirs(la, exist_ok=True)
sched = {"_comment": ["x"]}
if not ${skipLaunchAgents ? 'True' : 'False'}:
    for i in range(22):
        key = "job%02d" % i
        with open(os.path.join(la, "com.kevinbrittain.%s.plist" % key), "wb") as fh:
            plistlib.dump({"Label": "com.kevinbrittain." + key, "ProgramArguments": ["/bin/true"],
                           "StartCalendarInterval": {"Hour": 6, "Minute": i}}, fh)
        sched[key] = {"cron": "%d 6 * * *" % i}
    sched["job01"]["enabled"] = False
    with open(os.path.join(la, "com.kevinbrittain.stay-awake.plist"), "wb") as fh:
        plistlib.dump({"Label": "com.kevinbrittain.stay-awake", "KeepAlive": True}, fh)
    with open(os.path.join(la, "com.kevinbrittain.job00.plist.bak-2026"), "wb") as fh:
        plistlib.dump({"Label": "ignored"}, fh)
    os.makedirs(os.path.join(HOME, "Library", "LaunchAgents.parked"), exist_ok=True)
    with open(os.path.join(HOME, "Library", "LaunchAgents.parked", "com.kevinbrittain.prospecting.plist"), "wb") as fh:
        plistlib.dump({"Label": "com.kevinbrittain.prospecting"}, fh)
sched["daily-ops"] = {"cron": "0 7 * * *"}
w(os.path.join(REPO, "scripts", "job-schedule.json"), json.dumps(sched))
w(os.path.join(REPO, "js", "automations-data.js"), """var AUTOMATIONS = { macJobs: [
    { key: 'job00', name: 'Job Zero', when: 'x', status: 'on',
      what: 'Does the zeroth thing, it\\\\'s fine.' },
    { key: 'daily-ops', agent: true, name: 'Systems Check', when: '7am', status: 'on', what: 'The 07:00 routine.' },
  ], workers: [ { name: 'w0', when: 'x', status: 'on', what: 'Worker zero.' } ] };""")
w(os.path.join(REPO, "js", "skills-data.js"), "var SKILLS_LIBRARY = [ { name: 'S', instructions: 'name: sk00' } ];")
for i in range(12):
    w(os.path.join(HOME, ".claude", "agents", "ag%02d.md" % i), '---\\nname: ag%02d\\ndescription: "Agent %d does \\\\"work\\\\"."\\n---\\nbody' % (i, i))
w(os.path.join(HOME, ".claude", "agents", "ESTATE.md"), "# How the estate works")
for i in range(10):
    w(os.path.join(HOME, ".claude", "skills", "sk%02d" % i, "SKILL.md"), "---\\nname: sk%02d\\ndescription: >\\n  Folded\\n  description %d.\\n---\\n" % (i, i))
for i in range(6):
    w(os.path.join(REPO, ".claude", "skills", "pk%02d" % i, "SKILL.md"), "---\\nname: pk%02d\\ndescription: Project skill.\\n---\\n" % i)
for i in range(12):
    desc = "RETIRED 1 Sep." if i == 0 else ("ABSORBED into daily-ops as phase 3." if i == 1 else "Runs.")
    w(os.path.join(HOME, ".claude", "scheduled-tasks", "t%02d" % i, "SKILL.md"), "---\\nname: t%02d\\ndescription: %s\\n---\\n" % (i, desc))
for i in range(5):
    w(os.path.join(REPO, "workers", "w%d" % i, "wrangler.toml"),
      'name = "w%d"\\nmain = "x.js"\\n%s[[kv_namespaces]]\\nname = "NOT_THE_NAME"\\n' % (i, '[triggers]\\ncrons = ["* * * * *"]\\n' if i == 1 else ''))
w(os.path.join(REPO, "cloudflare-worker", "wrangler.toml"), 'name = "claude-proxy"\\n')
w(os.path.join(REPO, ".github", "workflows", "sync.yml"), "name: Sync projects\\non:\\n  schedule:\\n    - cron: '41 * * * *'\\n")
w(os.path.join(REPO, ".github", "workflows", "bump.yml"), "name: Auto-bump\\non: push\\n")
os.environ["BUILT_HOME"], os.environ["BUILT_REPO"] = HOME, REPO
spec = importlib.util.spec_from_file_location("bi", ${JSON.stringify(MODULE)})
bi = importlib.util.module_from_spec(spec); spec.loader.exec_module(bi)
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
out["skills"] = {s["k"]: [s["s"], s["d"]] for s in g["skills"]}
out["workers"] = {x["k"]: [x["s"], x["w"], x["d"]] for x in g["workers"]}
out["timers"] = {x["k"]: x["s"] for x in g["github-timers"]}
out["chars"] = len(json.dumps(inv, separators=(",", ":")))
`);

  it('joins each Mac job to the schedule: on, off, parked, always-on and the Claude-scheduler routine', () => {
    expect(r.mac.job00).toEqual(['on', '06:00', 'Job Zero', "Does the zeroth thing, it's fine.", null]);
    expect(r.mac.job01[0]).toBe('off');
    expect(r.mac.prospecting[0]).toBe('parked');
    expect(r.mac['stay-awake'][1]).toBe('always on');
    expect(r.mac['daily-ops']).toEqual(['on', '0 7 * * *', 'Systems Check', 'The 07:00 routine.', 'Claude scheduler']);
    expect(Object.keys(r.mac)).not.toContain('ignored');   // a .bak plist is not a job
    expect(r.counts.macJobs).toBe(23);                     // 22 plists − job01 off + stay-awake + daily-ops
  });

  it('reads agents, skills (folded descriptions too), workers and GitHub timers', () => {
    expect(r.agents.ag03).toEqual(['live', 'Agent 3 does "work".']);
    expect(r.agents.ESTATE[0]).toBe('reference');
    expect(r.counts.agentFiles).toBe(12);
    expect(r.skills.sk02).toEqual(['global', 'Folded description 2.']);
    expect(r.skills.pk01[0]).toBe('project');
    expect(r.workers.w1).toEqual(['on', '* * * * * (UTC)', '']);
    expect(r.workers.w0[2]).toBe('Worker zero.');
    expect(r.workers['claude-proxy'][1]).toBe('on request');
    expect(Object.keys(r.workers)).not.toContain('NOT_THE_NAME');  // a section's name is not the worker's
    expect(r.timers).toEqual({ 'bump.yml': 'on push', 'sync.yml': 'timer' });
  });

  it('marks retired and absorbed instructions for what they are', () => {
    expect(r.tasks.t00).toBe('retired');
    expect(r.tasks.t01).toBe('inside daily-ops');
    expect(r.tasks.t05).toBe('on');
    expect(r.counts.scheduledTasks).toBe(11);
  });

  it('names what runs but the hand-kept lists do not mention', () => {
    expect(r.missing.automations).toContain('job02');
    expect(r.missing.automations).not.toContain('job00');
    expect(r.missing.automations).not.toContain('daily-ops');   // an agent row written key, agent, name
    expect(r.missing.workers).toContain('w1');
    expect(r.missing.skills).not.toContain('sk00');
    expect(r.missing.skills).toContain('sk01');
  });

  it('fits well inside the Airtable field', () => {
    expect(r.chars).toBeLessThan(90000);
  });
});

describe('a broken read fails loudly, never as a smaller estate', () => {
  it('an unreadable LaunchAgents folder raises with the reason', () => {
    const r = py(`
try:
    bi.build(); out["raised"] = False
except bi.SourceFailure as e:
    out["raised"] = True; out["msg"] = str(e)
`, { skipLaunchAgents: true });
    expect(r.raised).toBe(true);
    expect(r.msg).toMatch(/read 0 Mac jobs .*expected 20\+.*not an empty estate/);
  });

  it('every source carries a floor', () => {
    const r = py(`out["floors"] = bi.FLOORS`);
    for (const k of ['macJobs', 'scheduledTasks', 'agentFiles', 'skills', 'workers', 'githubTimers']) {
      expect(r.floors[k]).toBeGreaterThan(0);
    }
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
  it('writes a Worked row with the counts, and a Failed row with the reason', () => {
    const r = py(`
from datetime import datetime, timezone
es_spec = importlib.util.spec_from_file_location("es", ${JSON.stringify(ESTATE)})
es = importlib.util.module_from_spec(es_spec); es_spec.loader.exec_module(es)
now = datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)
ok = es.built_row(now, module_path=${JSON.stringify(MODULE)})
out["ok"] = {k: ok.get(k) for k in ("key", "kind", "status", "detail")}
out["okPayload"] = json.loads(ok["payload"])["counts"]
os.environ["BUILT_HOME"] = "/nonexistent-home"
bad = es.built_row(now, module_path=${JSON.stringify(MODULE)})
out["bad"] = {k: bad.get(k) for k in ("status", "detail")}
`);
    expect(r.ok.key).toBe('built-inventory');
    expect(r.ok.kind).toBe('report');
    expect(r.ok.status).toBe('Worked');
    expect(r.ok.detail).toMatch(/^23 Mac jobs, 12 agent files, 16 skills, 6 workers, 1 GitHub timers, 11 scheduled tasks; \d+ not yet on the hand-kept lists$/);
    expect(r.okPayload.macJobs).toBe(23);
    expect(r.bad.status).toBe('Failed');
    expect(r.bad.detail).toMatch(/Could not build the everything-built list: read 0 Mac jobs/);
  });
});
