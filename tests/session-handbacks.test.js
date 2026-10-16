import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Do Claude Code sessions only ask Kevin for his four? (Kevin, 16 Oct 2026: approve, correct
// wrong work, pay, give access.) scripts/session_handbacks.py reads the chats on the Mac and
// scripts/ai_team_health.py judges the "Sessions only ask for your four" line from it.
// Every test drives the real functions over made-up transcripts written the way Claude Code writes
// them (compact JSON lines). The asks are shaped on the three real ones Kevin approved at the gate;
// their words are invented, because this repo is public.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

function py(code) {
  const script = `
import importlib.util, json, os, sys, tempfile
from datetime import datetime, timedelta, timezone
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
S = load("sh", "session_handbacks.py")
A = load("ath", "ai_team_health.py")
NOW = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
def at(**kw): return (NOW - timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
def row(**d): return json.dumps(d, separators=(",", ":"))
def prompt(text, when, ep="claude-desktop", side=False):
    return row(type="user", entrypoint=ep, isSidechain=side, timestamp=when, message={"role": "user", "content": text})
N = [0]
def mid():
    N[0] += 1; return "msg_%d" % N[0]
def say(text, when, ep="claude-desktop", side=False, stop="end_turn", id=None):
    return row(type="assistant", entrypoint=ep, isSidechain=side, timestamp=when,
               message={"id": id or mid(), "role": "assistant", "stop_reason": stop, "content": [{"type": "text", "text": text}]})
def tool(name, inp, when, ep="claude-desktop", id=None):
    return row(type="assistant", entrypoint=ep, isSidechain=False, timestamp=when,
               message={"id": id or mid(), "role": "assistant", "stop_reason": "tool_use", "content": [{"type": "tool_use", "name": name, "input": inp}]})
def meta(text, when):
    return row(type="user", entrypoint="claude-desktop", isSidechain=False, isMeta=True, timestamp=when, message={"role": "user", "content": text})
def write(root, name, lines):
    os.makedirs(os.path.join(root, "proj"), exist_ok=True)
    with open(os.path.join(root, "proj", name + ".jsonl"), "w") as fh:
        fh.write("\\n".join(lines) + "\\n")
def fixture(root):
    # A: a hand-back (the Evernote one), an option question, and "tell me what to change".
    write(root, "aaaa", [
        row(type="custom-title", customTitle="Tax pack"),
        prompt("Build the pack", at(days=1, hours=2)),
        say("Next: press send.", at(days=1, hours=2), id="msg_mid", stop="tool_use"),
        tool("Bash", {"command": "ls"}, at(days=1, hours=2), id="msg_mid"),
        meta("[Image: a screenshot]", at(days=1, hours=2)),
        say("Pack is 90 files.\\n**Next: open Evernote, search 1234, save those four PDFs to Downloads.**", at(days=1, hours=1)),
        prompt("done", at(days=1)),
        tool("AskUserQuestion", {"questions": [{"question": "Which cover letter?", "options": [{"label": "Short"}, {"label": "Long"}]}]}, at(hours=20)),
        say('Reply "use it", or tell me what to change.', at(hours=19)),
    ])
    # B: the model check (not counted) and a next-step box ask (a decision).
    write(root, "bbbb", [
        prompt("Fix the card", at(hours=10)),
        say("MODEL CHECK\\nSwitch in the model picker (terminal: /model claude-fable-5-1), then reply go.", at(hours=10)),
        prompt("go", at(hours=9)),
        say("Built and tested. Next: check the live page.", at(hours=8), id="msg_box", stop="tool_use"),
        tool("mcp__ccd_turn__wrap_up", {"recap": "Built.", "ask": "Merge it?", "actions": [{"label": "Merge"}]}, at(hours=8), id="msg_box"),
    ])
    # C: a scheduled run, D: a robot run, E: an ask older than the window, F: a helper's own thread.
    # C opens with a system note before its scheduled-task prompt: still a scheduled run.
    write(root, "cccc", [meta("Base directory for this skill: x", at(hours=5)), prompt("<scheduled-task name=x>do it</scheduled-task>", at(hours=5)),
        say("Next: press send.", at(hours=5))])
    write(root, "dddd", [prompt("You are a robot", at(hours=5), ep="sdk-cli"), say("Next: press send.", at(hours=5), ep="sdk-cli")])
    write(root, "eeee", [prompt("Old work", at(days=20)), say("Next: press send.", at(days=20))])
    write(root, "ffff", [prompt("Start", at(hours=3)), say("Next: press send.", at(hours=3), side=True)])
    # G: an option question that asks him to do a step.
    write(root, "gggg", [prompt("Check the tab", at(hours=2)),
        tool("AskUserQuestion", {"questions": [{"question": "Have you reloaded the AI Agents tab you opened yesterday?", "options": [{"label": "Done"}]}]}, at(hours=2))])
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

describe('which asks count (the three worked examples Kevin approved)', () => {
  it('counts a step the session could do, never his four, and never a model switch', () => {
    const out = py(`print(json.dumps([S.closing_asks(t) for t in (
        "Next: open Evernote, search 1234, save those four PDFs to Downloads.",
        'Reply "use it", or tell me what to change.',
        "Switch in the model picker (terminal: /model x), then reply go.",
        "Next: I merge it once the review is clean.",
        "Next: sign in to the site in the tab I left open.",
        "Next: tap the Monzo card.",
        "Next: open your approval queue and take the three cards.",
        "Next: approve those five, then download the statements.")]))`);
    const kinds = out.map(a => a.map(x => [x[1], x[2]]));
    expect(kinds).toEqual([
      [['handback', 'fetch a document']], [['correct', '']], [['model', '']], [],
      [['access', '']], [['pay', '']], [['approve', '']], [['handback', 'fetch a document']],
    ]);
  });

  it('reads an option question as a decision unless it asks for a step, and a sign-in button as access', () => {
    const out = py(`print(json.dumps([S.question_ask(t) for t in (
        "Which option should the form use?", "Have you reloaded the AI Agents tab?",
        'Can you click "Sign in as Kevin" there, then tell me?')]))`);
    expect(out).toEqual([['approve', ''], ['handback', 'check or test something'], ['access', '']]);
  });

  it('catches the two hand-backs the back-test found hiding: a command block to run, a menu path to click', () => {
    const out = py(`print(json.dumps([[k for _, k, _ in S.closing_asks(t)] for t in (
        "Run this:\\n\`\`\`\\nnode scripts/agent-browser.js login --url https://example.test\\n\`\`\`\\nWhile you do that, I am drafting the letters.",
        "To get the PDF: File → Download → PDF Document (.pdf).")]))`);
    expect(out).toEqual([['handback'], ['handback']]);
  });

  it('does not read the session\'s own plan, or its own command, as Kevin\'s step (review of the first build)', () => {
    const out = py(`print(json.dumps([[(k, w) for _, k, w in S.closing_asks(t)] for t in (
        "Next: run the full test suite and deploy.", "Next up for me: run the sweep.",
        "I'll run this next:\\n\`\`\`\\nnpm test\\n\`\`\`", "Export path: Settings → Data → Export (I did it myself).",
        "Next: click Approve on the card.", "Your one thing: sign the robot in to SpareRoom (one click).",
        "Next: run /model claude-opus-5-5, then reply go.", "Shall I set the check for 22 Oct?",
        "Next steps for you:\\n- Restart the Claude app.", "Next steps:\\n- Run merge-pr.py in the background\\n- Check the deploy is live",
        "Next steps for you:\\n1. Download the statement from the bank.\\n2. Drop it in the folder.",
        "Run this:\\n\`\`\`\\nnpm run test:sync\\n\`\`\`", "Next up for me: check the deploy is live.",
        "Next: open Settings, toggle the filter on, then review the inbox.", "Next: open the Barclays app and turn off payment notifications.")]))`);
    expect(out).toEqual([[], [], [], [], [['approve', '']], [['access', '']], [['model', '']], [['approve', '']],
      [['handback', 'a physical step']], [], [['handback', 'fetch a document'], ['handback', 'fetch a document']],
      [['handback', 'run a command']], [], [['handback', 'a step in an app']], [['handback', 'a step in an app']]]);
  });
});

describe('reading the chats', () => {
  it('scores only desktop sessions with an ask in the window, main thread, scheduled and robot runs left out', () => {
    const out = py(`d = tempfile.mkdtemp(); fixture(d)
f = S.facts(NOW, S.read_sessions(NOW, root=d, cache_path=os.path.join(d, "cache.json")))
print(json.dumps({k: f[k] for k in ("sessions", "back", "asks", "backAsks", "model", "reasons", "unread")} | {"items": [i["name"] for i in f["items"]]}))`);
    // A: the Evernote hand-back, a decision, a correction (its mid-turn "press send" and the image
    // note are not closings). B: the box's own reply hands back "check the live page", the box ask
    // is a decision, the model switch is not counted. G: a question asking for a step.
    expect(out).toEqual({ sessions: 3, back: 3, asks: 6, backAsks: 3, model: 1, unread: [],
      reasons: [['check or test something', 2], ['fetch a document', 1]],
      items: ['Untitled session', 'Untitled session', 'Tax pack'] });   // newest first: G, B, then A
  });

  it('re-reads only a chat that changed, and never trusts a stale cache entry', () => {
    const out = py(`d = tempfile.mkdtemp(); fixture(d); c = os.path.join(d, "cache.json")
first = S.read_sessions(NOW, root=d, cache_path=c)["parsed"]
second = S.read_sessions(NOW, root=d, cache_path=c)["parsed"]
p = os.path.join(d, "proj", "bbbb.jsonl")
with open(p, "a") as fh: fh.write(say("Next: press send.", at(hours=1)) + "\\n")
os.utime(p, (NOW.timestamp() + 60, NOW.timestamp() + 60))
r = S.read_sessions(NOW, root=d, cache_path=c)
f = S.facts(NOW, r)
print(json.dumps([first, second, r["parsed"], f["back"]]))`);
    expect(out).toEqual([7, 0, 1, 3]);   // B already came back; the append adds an ask, not a session
  });

  it('a moved transcript format reads as an error, never as a clean score (review of the first build)', () => {
    const out = py(`
def run(edit):
    d = tempfile.mkdtemp(); fixture(d)
    for p in [os.path.join(d, "proj", f) for f in os.listdir(os.path.join(d, "proj"))]:
        txt = open(p).read(); open(p, "w").write(edit(txt))
    return S.facts(NOW, S.read_sessions(NOW, root=d, cache_path=None)).get("error", "")[:30]
print(json.dumps([
    run(lambda t: t.replace('"entrypoint":"claude-desktop"', '"entrypoint":"desktop-app"')),
    run(lambda t: t.replace('"type":"user",', '"type":"user","tool_result":null,')),
    run(lambda t: t.replace('"type":"text"', '"type":"output_text"')),
    run(lambda t: t)]))`);
    // With no prompt read, the scheduled run can no longer be told apart, so it counts as a chat too.
    expect(out).toEqual(['none of the 7 chat files is a ', '6 desktop chats but no prompt ', '5 desktop chats but no reply t', '']);
  });

  it('keeps the words of an ask on the Mac: the line carries the chat title, the day and the reason only', () => {
    const out = py(`d = tempfile.mkdtemp(); fixture(d)
print(json.dumps(S.facts(NOW, S.read_sessions(NOW, root=d, cache_path=None))["items"]))`);
    expect(out.map(i => i.note)).toEqual(['16 Oct, check or test something', '16 Oct, check or test something', '15 Oct, fetch a document']);
    expect(JSON.stringify(out)).not.toContain('Evernote');
  });

  it('a reply line written twice is one ask, and an aside holding his own step still counts (review 3)', () => {
    const out = py(`d = tempfile.mkdtemp()
twice = row(type="assistant", entrypoint="claude-desktop", isSidechain=False, timestamp=at(hours=1), uuid="u-1",
            message={"id": "m-1", "role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": "Reply go."}]})
write(d, "iiii", [prompt("Go", at(hours=2)), twice, twice])
f = S.facts(NOW, S.read_sessions(NOW, root=d, cache_path=None))
print(json.dumps([f["asks"], [[(k, w) for _, k, w in S.closing_asks(t)] for t in (
    "Reply go (after you download the statement from the bank).",
    "These run in your terminal session automatically:\\n\`\`\`\\nnpm test\\n\`\`\`")]]))`);
    expect(out).toEqual([1, [[['handback', 'fetch a document']], []]]);
  });

  it('text before a tool call is mid-turn even when the lines carry no message id', () => {
    const out = py(`d = tempfile.mkdtemp()
noid = lambda stop, content: row(type="assistant", entrypoint="claude-desktop", isSidechain=False, timestamp=at(hours=1),
                                 message={"role": "assistant", "stop_reason": stop, "content": content})
write(d, "hhhh", [prompt("Go", at(hours=2)), noid(None, [{"type": "text", "text": "Next: press send."}]),
                  noid("tool_use", [{"type": "tool_use", "name": "Bash", "input": {}}]),
                  noid("end_turn", [{"type": "thinking", "thinking": "done"}]), say("All done.", at(minutes=30))])
print(json.dumps(S.facts(NOW, S.read_sessions(NOW, root=d, cache_path=None))))`);
    expect(out).toMatchObject({ sessions: 0, back: 0 });
  });

  it('a missing transcripts folder is an error, never an empty all-clear', () => {
    const out = py(`
try:
    S.read_sessions(NOW, root="/nonexistent/claude/projects", cache_path=None); print(json.dumps("read"))
except OSError as e:
    print(json.dumps("error"))`);
    expect(out).toBe('error');
  });
});

describe('the line (same thresholds as the agents\' hand-back line)', () => {
  it('is green at 95% or more, amber to 85%, red under; grey with nothing to judge; never green with a chat unread', () => {
    const j = (n, back, unread = '[]') => `A.judge_sessions({"sessions": ${n}, "back": ${back}, "asks": ${n}, "backAsks": ${back}, "unread": ${unread}})`;
    const out = py(`print(json.dumps([l["colour"] for l in [${j(100, 5)}, ${j(100, 6)}, ${j(100, 15)}, ${j(100, 16)},
        ${j(0, 0)}, A.judge_sessions({"error": "x"}), ${j(10, 0, '["a.jsonl (gone)"]')}]]))`);
    expect(out).toEqual(['green', 'amber', 'amber', 'red', 'grey', 'grey', 'amber']);
  });

  it('says how many sessions came back, why, and what was left out', () => {
    const out = py(`d = tempfile.mkdtemp(); fixture(d)
l = A.judge_sessions(S.facts(NOW, S.read_sessions(NOW, root=d, cache_path=None)))
print(json.dumps({k: l[k] for k in ("colour", "answer", "number", "group", "extra")}))`);
    expect(out).toMatchObject({ colour: 'red', answer: '3 of 3 sessions came back to you', number: 0, group: 'keep' });
    expect(out.extra).toContainEqual(['Asks to you', '6, 3 of them not one of your four']);
    expect(out.extra).toContainEqual(['Not counted', "1 model switch (only you can switch a session's model)"]);
  });
});
