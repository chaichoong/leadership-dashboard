#!/usr/bin/env python3
"""Do Claude Code sessions only ask Kevin for his four? (Kevin, 16 Oct 2026)

WHY THIS EXISTS
---------------
Kevin, 16 Oct 2026: "Too often, in too many sessions, you're coming back to me asking me to do
stuff that you're capable of doing, which is unacceptable." He does four things only: approve,
correct wrong work, pay and give access. The agents are scored on it (the hand-back line in
scripts/ai_team_health.py); this scores the Claude Code chats he works in.

WHAT IT COUNTS
--------------
The unit is an ask: something a session put to Kevin to answer or do. Three places hold one:
- an AskUserQuestion call (each question is one ask);
- a next-step box ask (mcp__ccd_turn__wrap_up's `ask`);
- the closing lines of a reply (its last 6 lines) that hand him a step: "Next: ...", "Your one
  thing: ...", "Can you ...", "Reply go".
Each ask is sorted into one of his four (approve, correct, pay, access) or a hand-back with a
reason (run a command, check or test something, fetch a document, find a value, send a message,
a physical step, a step in an app, tell you when something happens). A question with options is
a decision, so it is approval, unless it asks him to do a step ("Have you reloaded the tab?").
A model switch is not counted: the app refuses to let a session switch its own model.

The free-text half is the weak part. `backtest LABELS` scores the rules against asks labelled by
hand (the labels file lives outside the repo: it quotes his chats, and this repo is public).

Which chats: the desktop app's own (entrypoint claude-desktop), main thread only. Robot runs
(entrypoint sdk-cli) ask through cards, counted on the agents' line. Scheduled runs (first prompt
<scheduled-task>) have nobody to ask, so they are left out.

The score, for the AI team line: of the sessions that asked him anything in the last 14 days,
the share where every ask was one of his four.

Usage:
  python3 scripts/session_handbacks.py dry-run [--days N]   every ask counted, with its reason
  python3 scripts/session_handbacks.py backtest LABELS      accuracy against hand labels (JSON)
  python3 scripts/session_handbacks.py selftest
Reads ~/.claude/projects/*/*.jsonl only. The cache (~/knowledge-os/logs/session-handbacks/) keeps
what was read from each file, so a ten-minute pass re-reads only the chats that changed.
"""
import glob
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

LONDON = ZoneInfo("Europe/London")
PROJECTS = os.path.expanduser("~/.claude/projects")
CACHE = os.path.expanduser("~/knowledge-os/logs/session-handbacks/cache.json")
CACHE_VERSION = 4                   # bump when what is taken from a file changes
WINDOW_DAYS = 14
TAIL_LINES = 6                      # the closing lines of a reply

ALLOWED = ("approve", "correct", "pay", "access")
NOT_COUNTED = ("model",)

# ─── reading a transcript ─────────────────────────────────────────────
# Only these lines are parsed: a transcript is mostly tool results, and json-decoding every line
# of 1.8 GB a fortnight is the whole cost of this script.
WANTED = ('"type":"assistant"', '"type":"custom-title"', '"type":"ai-title"')


def _prompt_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return " ".join(str(b.get("text") or "") for b in content if isinstance(b, dict) and b.get("type") == "text")


def tail(text, n=TAIL_LINES):
    return "\n".join([ln for ln in str(text or "").split("\n") if ln.strip()][-n:])


def _dict(v):
    return v if isinstance(v, dict) else {}


def extract(path):
    """What one transcript holds for this measure: {desktop, scheduled, title, prompts, turns, raw:
    [{at, source, text}]}. `raw` is every ask place in the file, unjudged, so the cache never holds
    a verdict. A closing is the text of a reply that ended its turn (stop_reason end_turn): text
    written mid-turn, before a tool call or a system note, was never handed to Kevin as an ending
    (review of the first build). `prompts` and `turns` are the control: a desktop chat with neither
    means the transcript format moved, and the line must say so rather than read clean."""
    desktop = None
    first = None
    title = ai_title = ""
    raw = []
    prompts = turns = 0
    last_text = (None, None, None)      # (message key, at, text): a reply's blocks arrive as separate lines
    n = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            prompt = '"type":"user"' in ln and '"tool_result"' not in ln
            if not prompt and not any(w in ln for w in WANTED):
                continue
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            if not isinstance(d, dict):
                continue
            if desktop is None and d.get("entrypoint"):
                desktop = d["entrypoint"] == "claude-desktop"
            t = d.get("type")
            if t == "custom-title":
                title = str(d.get("customTitle") or "") or title
                continue
            if t == "ai-title":
                ai_title = str(d.get("aiTitle") or "") or ai_title
                continue
            if d.get("isSidechain"):
                continue
            m = _dict(d.get("message"))
            if t == "user":
                if d.get("isMeta"):
                    continue            # a skill load, an image note, a hook's words: not Kevin
                text = _prompt_text(m.get("content"))
                if not text.strip():
                    continue
                prompts += 1
                if first is None:
                    first = text[:40]
            elif t == "assistant":
                # Claude Code writes each block of a reply on its own line, every one carrying the
                # reply's final stop_reason (review 2: a text line before a box reads "tool_use").
                # Text is held per reply; a line with no id is a reply of its own.
                n += 1
                key = m.get("id") or "line-%d" % n
                if last_text[0] != key:
                    last_text = (None, None, None)
                blocks = m.get("content") if isinstance(m.get("content"), list) else []
                for b in blocks:
                    b = _dict(b)
                    if b.get("type") == "text" and str(b.get("text") or "").strip():
                        last_text = (key, d.get("timestamp"), str(b["text"]))
                    elif b.get("type") == "tool_use":
                        name = str(b.get("name") or "")
                        inp = _dict(b.get("input"))
                        if name == "AskUserQuestion":
                            qs = inp.get("questions") if isinstance(inp.get("questions"), list) else []
                            for q in qs:
                                raw.append({"at": d.get("timestamp"), "source": "question",
                                            "text": str(_dict(q).get("question") or "")})
                        elif name.endswith("__wrap_up"):
                            # The reply that carries the next-step box is the turn's message: the
                            # box ends the turn with no text after it.
                            if last_text[0] == key and last_text[2]:
                                raw.append({"at": last_text[1], "source": "closing", "text": tail(last_text[2])})
                                last_text = (None, None, None)
                            if inp.get("ask"):
                                raw.append({"at": d.get("timestamp"), "source": "box", "text": str(inp["ask"])})
                if m.get("stop_reason") == "end_turn":
                    turns += 1
                    if last_text[0] == key and last_text[2]:
                        raw.append({"at": last_text[1], "source": "closing", "text": tail(last_text[2])})
                        last_text = (None, None, None)
    return {"desktop": bool(desktop), "scheduled": str(first or "").startswith("<scheduled-task"),
            "title": title or ai_title, "prompts": prompts, "turns": turns, "raw": raw}


# ─── judging an ask ───────────────────────────────────────────────────
# A closing line is an ask when it is addressed to Kevin: a lead-in ("Next:", "Your one thing:"),
# a bare reply word ("Reply go."), or "can you / please / you need to".
LEAD = re.compile(
    r"(?i)^(?:[-*>\d.)\s]|\*\*)*(?:(?:next(?:[^:.]{0,40})?|your (?:next |one )?(?:step|turn|move|action|thing)"
    r"(?:[^:.]{0,30})?|one (?:thing|step) for you|action for you|for you|still waiting on you)"
    r"\s*(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*)")
BARE = re.compile(r"(?i)^(?:reply|say|answer|tell me|switch in the model picker)\b")
ASKS_YOU = re.compile(r"(?i)\b(?:can you|could you|would you|please|you(?:'ll| will)? need to|you have to|"
                      r"you must|i need you to|you'll want to)\b")
# A question with options is a decision unless it asks him to do something.
ASKS_A_STEP = re.compile(r"(?i)\b(?:can you|could you|have you|did you|will you|please|you need to|for you to)\b")
# "Next: I merge it" is the session's own plan, not an ask.
OWN = re.compile(
    r"(?i)^(?:i\b|i'll|i will|we\b|the (?:reviewer|review|build|robot|agent|job|sweep|merge|deploy|pr)\b|once\b|"
    r"when the\b|after the\b|nothing\b|none\b|no action\b|from me\b|on my side\b|merge\b|open the pr\b|fix\b|"
    r"commit\b|push\b|wait\b|review findings\b|act on\b|wave\b|phase\b|deploy\b|"
    r"(?:re-?)?run (?:the |a )?(?:full |whole |live )?(?:test|tests|suite|suites|sweep|gate|merge gate|dry[- ]run|back-?test)\b|"
    r"test it\b|open a (?:pr|pull request)\b|.*\bvia (?:send-email|scripts?/)|.*\bmyself\b)")
# A question the session asks about its own next move is an approval ask.
OFFER = re.compile(r"(?i)^(?:want me to|do you want me to|would you like me to|shall i|should i)\b")
# A lead-in alone on its line ("Next:", "What you need to do:") hands him the list that follows.
LEAD_ONLY = re.compile(r"(?i)^(?:next(?: steps?)? for you|(?:the )?steps? for you|your (?:next )?(?:steps?|turn)|"
                       r"what you need to do|for you)\s*:?$")
IMPERATIVE = re.compile(
    r"(?i)^(?:say|reply|tell|pick|choose|decide|approve|confirm|answer|review|read|go through|look|check|test|"
    r"open|click|tap|press|paste|run|type|send|forward|upload|download|install|plug|switch|sign|log|"
    r"re-?authenticate|enter|give|add|move|delete|rename|copy|find|call|ring|phone|text|email|visit|go to|"
    r"navigate|refresh|reload|restart|close|quit|enable|turn|grant|allow|connect|pay|buy|top up|share|drag|"
    r"select|scan|print|post|fill|complete|accept|set|do|let me know|keep|leave|hold|watch|wait|try|make|put|"
    r"update|edit|use|ask)\b")
FOUR = (
    ("pay", re.compile(r"(?i)\b(?:pay|payment|buy it now|checkout|check out|top[- ]?up|card details|press pay|"
                       r"purchase|tap (?:the )?(?:\w+ )?card)\b")),
    ("access", re.compile(r"(?i)\b(?:sign (?:\w+ ){0,3}in\b|log ?in|log (?:\w+ ){0,3}in\b|re-?authenticat\w*|verification code|"
                          r"one-time code|2fa|two-factor|passcode|password|authori[sz]e|"
                          r"(?:grant|give) (?:me |the robot )?access|allow access|add another account|"
                          r"connect (?:your|the) \w+ account)\b")),
)
CORRECT = re.compile(r"(?i)\b(?:tell me what (?:to|'s wrong|is wrong)|name what to change|what's wrong)\b")
APPROVE = re.compile(
    r"(?i)^(?:tell me|answer)\b|\btell me to (?:proceed|go|start|send)\b|"
    r"\b(?:(?:say|reply|type)\b[^.]{0,20}QUOTE|say the word|tap approve|read (?!the live)|(?:open )?(?:your |the )?(?:approval )?queue|"
    r"take the \w+ cards?|approve card|answer (?:that|the|question)|tell me (?:whether|which|if|about))\b|"
    r"\b(?:say|reply|type|answer|tell me)\b[^.]{0,40}(?:\"|“|'|go\b|yes\b|no\b|which|top-up|done\b)|"
    r"\b(?:approve|pick|choose|decide|confirm|review|go through|read through|tell me which|tell me yes|yes or no|"
    r"your call|your verdict|sign off)\b")
HANDBACK = (
    ("run a command", re.compile(r"(?i)\b(?:run|paste (?:the |this )?(?:command|prompt|line)|terminal|npm|"
                                 r"python3?|git)\b")),
    ("check or test something", re.compile(r"(?i)\b(?:confirm the deploy|read the live|(?:check|test|refresh|reload|"
                                           r"hard[- ]reload)(?:ed|ing)?|look at|see if|confirm (?:it|that|the)|"
                                           r"open (?:the|this) (?:page|link|dashboard|tab|chat)|try)\b")),
    ("fetch a document", re.compile(r"(?i)\b(?:download|save (?:those|the|them)|drop (?:it|them)|attach)\b")),
    ("find a value", re.compile(r"(?i)\b(?:find|look up|look in|dig out|send me (?:the|a|your)|"
                                r"paste (?:me )?(?:the|your)|what is the|tell me the)\b")),
    ("send a message", re.compile(r"(?i)\b(?:ask (?:each|them|him|her|the)|press send|send to|send it yourself|"
                                  r"forward|email|text|reply to)\b")),
    ("a physical step", re.compile(r"(?i)\b(?:plug|cable|switch (?:the \w+ )?on|turn (?:the \w+ )?on|restart|reboot|"
                                   r"install|press (?:cmd|ctrl|⌘)|drawer|print|scan)\b")),
    ("a step in an app", re.compile(r"(?i)\b(?:do its \w+ steps|click|tap|press|drag|select|open (?:the|your)? ?\w+ app|"
                                    r"open (?!the queue|your approval)|enable|turn on|turn off|toggle|settings|close)\b")),
)
BUTTON = re.compile(r"(?i)\b(?:click|press|tap|select|hit)\s+(?:on\s+)?(?:the\s+)?[\"“']?"
                    r"(approve|pay|buy|sign in|log in)\b")
QUEUE_STEP = re.compile(r"(?i)\bopen (?:your |the )?(?:approval queue|queue|ai agents page|dashboard)\b[^.]{0,40}\bapprove\b")
TELL_WHEN = re.compile(r"(?i)\btell me (?:when|once|after)\b|\b(?:after|once) [^.]{0,40}, tell me\b")
MODEL = re.compile(r"(?i)\bmodel picker\b|(?<!\w)/(?:model|effort)\b|\bswitch (?:to )?(?:opus|fable)\b|\beffort (?:to )?max\b")


def kevins_part(t):
    """The words that ask something of Kevin: quoted reply words become QUOTE, and the session's
    own half ("... and I will send it") is cut off."""
    t = re.sub(r"\([^)]{0,60}\)", " ", t)          # asides: "(one click)", "(about 2 minutes)"
    t = re.sub(r"[\"“][^\"”]{0,120}[\"”]", " QUOTE ", t)
    return re.split(r"(?i),? (?:and|so|then) (?:i|i'll|i will|the|they|it|all|both|we)\b|,? so (?:that|it|they)\b|"
                    r"\. then the only", t)[0]


def classify(t):
    """(kind, why): kind is one of ALLOWED, "model", "handback" (why says what he was handed) or
    "unclear" (addressed to him but no ask in it)."""
    raw = t
    t = kevins_part(t)
    if MODEL.search(t):
        return "model", ""
    if TELL_WHEN.search(t):
        return "handback", "tell you when something happens"
    rest = t
    for _, rx in FOUR:
        rest = rx.sub(" ", rest)
    rest = CORRECT.sub(" ", APPROVE.sub(" ", rest))
    # The four explain away only their own words: "approve those five, then download the
    # statements" is still a hand-back. Clicking the sign-in button is the sign-in itself, even
    # when its label is quoted ('click "Sign in as Kevin"').
    still = [why for why, rx in HANDBACK if rx.search(rest)]
    if still == ["a step in an app"]:
        # Pressing the button is the act itself: "click Approve", "press Pay", 'click "Sign in as
        # Kevin"', "open the AI Agents page and approve the card". Only the button word itself: "open
        # Settings, toggle the filter, then review the inbox" stays a hand-back (review 2).
        b = BUTTON.search(raw)
        if b:
            w = b.group(1).lower()
            return ("approve" if w.startswith("approve") else "pay" if w in ("pay", "buy") else "access"), ""
        if QUEUE_STEP.search(raw):
            return "approve", ""
    if still:
        return "handback", still[0]
    for kind, rx in FOUR:
        if rx.search(t):
            return kind, ""
    if CORRECT.search(t):
        return "correct", ""
    if APPROVE.search(t):
        return "approve", ""
    return "unclear", ""


def _sentences(text):
    out = []
    for raw in str(text or "").split("\n"):
        if not raw.strip() or re.match(r"\s*(?:>|#|\||```)", raw):
            continue                    # quotes, headings, tables and code are not asks
        raw = re.sub(r"^(\s*\d+)\.\s", r"\1) ", raw)   # "1. Download" stays one item
        for s in re.split(r"(?<=[.!?])\s+(?=[A-Z*\"“])", raw):
            s = re.sub(r"[*_`]+", "", s).strip()
            if s:
                out.append(s)
    return out


# Two hand-backs with no lead-in, found by the back-test: a command block given to him to run
# ("```node scripts/agent-browser.js login ...``` While you do that, I ..."), and a menu path to
# click through ("File → Download → PDF").
GIVEN_COMMAND = re.compile(r"(?i)\b(?:while you do that|once you(?:'ve| have) (?:run|done) (?:that|it|this)|"
                           r"run (?:this|it|the command)|in (?:your )?terminal|paste (?:this|it) into)\b")
SELF_START = re.compile(r"(?i)^(?:i\b|i'(?:ll|ve|m)\b|we\b|the\b)")
SELF = re.compile(r"(?i)^(?:i\b|i'(?:ll|ve|m)\b|we\b)|\b(?:i did|i'll|i will|i have|i've|myself)\b")
MENU_PATH = re.compile(r"(?i)\b\w+ → [^.]{0,60}\b(?:download|export|save)\b|\b(?:download|export|save)\b[^.]{0,40} → ")


def closing_asks(text):
    """[(sentence, kind, why)] for each ask in a reply's closing lines."""
    out = []
    t = tail(text)
    if "```" in t:
        given = next((s for s in _sentences(t) if GIVEN_COMMAND.search(s) and not SELF_START.search(s)), None)
        if given:
            out.append((given, "handback", "run a command"))
    led = False                         # the line before was a lead-in on its own
    for s in _sentences(t):
        if MENU_PATH.search(s) and not SELF.search(s):
            out.append((s, "handback", "fetch a document"))
            continue
        if LEAD_ONLY.match(s):
            led = True
            continue
        if OFFER.match(s):
            out.append((s, "approve", ""))
            continue
        if led and re.match(r"^(?:[-•]|\d+[.)])\s", s) or led and IMPERATIVE.match(s):
            body = re.sub(r"^(?:[-•]|\d+[.)])\s*", "", s)
            if not OWN.match(body):
                kind, why = classify(body)
                if kind != "unclear":
                    out.append((s, kind, why))
            continue
        led = False
        m = LEAD.match(s)
        if m and re.search(r"(?i)\b(?:once|when|after) (?:it|the|this)\b|\b(?:for me|mine|my side|my end)\b", m.group(0)):
            continue                    # "Next, once it merges:", "Next up for me:" are the session's own plan
        body = s[m.end():] if m else s
        lead = bool(m) or bool(BARE.match(s))
        you = bool(ASKS_YOU.search(s))
        if not (lead or you):
            continue
        if lead and not you and (OWN.match(body) or not IMPERATIVE.match(body)):
            continue
        kind, why = classify(body)
        if kind != "unclear":
            out.append((s, kind, why))
    return out


def question_ask(text):
    """(kind, why) for an option question or a next-step box ask: a decision, unless it asks him
    to do a step."""
    if ASKS_A_STEP.search(text or ""):
        for s in _sentences(text):
            if ASKS_A_STEP.search(s):
                kind, why = classify(s)
                if kind != "unclear":
                    return kind, why
    return "approve", ""


def judge(raw):
    """Every ask in one place of a transcript, as [{at, source, text, kind, why}]."""
    if raw["source"] == "closing":
        return [dict(raw, text=s, kind=k, why=w) for s, k, w in closing_asks(raw["text"])]
    kind, why = question_ask(raw["text"])
    return [dict(raw, kind=kind, why=why)]


# ─── reading every chat, with the cache ───────────────────────────────
def _aware(value):
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _load_cache(path):
    try:
        with open(path, encoding="utf-8") as fh:
            c = json.load(fh)
    except (OSError, ValueError):
        c = None
    if isinstance(c, dict) and c.get("v") == CACHE_VERSION and isinstance(c.get("files"), dict):
        return c
    return {"v": CACHE_VERSION, "files": {}}        # missing, old or the wrong shape: read afresh


def _save_cache(path, cache):
    """Written to a temp file and renamed over the real one, so a reader never sees half a file.
    A temp file left by a killed run is swept once it is an hour old."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for old in glob.glob(os.path.join(os.path.dirname(path), ".cache-*")):
        try:
            if os.stat(old).st_mtime < datetime.now().timestamp() - 3600:
                os.unlink(old)
        except OSError:
            pass
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".cache-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(cache, fh)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_sessions(now, days=WINDOW_DAYS, root=PROJECTS, cache_path=CACHE):
    """{sessions: [{id, title, asks}], files, parsed, unread: [why], cacheError, error} for the
    desktop chats with an ask in the window. Raises OSError only when the projects folder is
    missing. `error` is the control: chat files in the window but no desktop chat, or desktop chats
    with no prompt or no finished reply read, means the transcript format moved, and nothing read
    can be trusted as clean (review of the first build: a renamed field read green, 0 of 20)."""
    cut = now - timedelta(days=days)
    if not os.path.isdir(root):
        raise OSError("no transcripts folder at %s" % root)
    cache = _load_cache(cache_path) if cache_path else {"v": CACHE_VERSION, "files": {}}
    kept, sessions, unread, parsed = {}, [], [], 0
    desk = prompts = turns = texts = 0
    files = [p for p in glob.glob(os.path.join(root, "*", "*.jsonl"))]
    for path in sorted(files):
        try:
            st = os.stat(path)
        except OSError:
            continue                    # removed since the listing
        if st.st_mtime < cut.timestamp():
            continue                    # nothing in it can be inside the window
        key = "%d:%d" % (st.st_size, int(st.st_mtime))
        hit = cache["files"].get(path)
        if isinstance(hit, dict) and hit.get("key") == key and isinstance(hit.get("got"), dict):
            got = hit["got"]
        else:
            try:
                got = extract(path)
            except Exception as exc:  # noqa: BLE001 — one odd file is named, never the whole line lost
                unread.append("%s (%s)" % (os.path.basename(path), str(exc)[:60]))
                continue
            parsed += 1
        kept[path] = {"key": key, "got": got}
        if not got.get("desktop") or got.get("scheduled"):
            continue
        desk += 1
        prompts += int(got.get("prompts") or 0)
        turns += int(got.get("turns") or 0)
        texts += sum(1 for r in got.get("raw") or () if isinstance(r, dict) and r.get("source") == "closing")
        asks = []
        try:
            for raw in got.get("raw") or ():
                at = _aware(raw.get("at"))
                if at and at >= cut:
                    asks.extend(judge(dict(raw, at=at.isoformat(), text=str(raw.get("text") or ""))))
        except Exception as exc:  # noqa: BLE001
            unread.append("%s (%s)" % (os.path.basename(path), str(exc)[:60]))
            continue
        asks = [a for a in asks if a["kind"] not in NOT_COUNTED] + [a for a in asks if a["kind"] in NOT_COUNTED]
        if asks:
            sessions.append({"id": os.path.splitext(os.path.basename(path))[0], "title": got["title"], "asks": asks})
    cache_err = None
    if cache_path:
        try:
            _save_cache(cache_path, {"v": CACHE_VERSION, "files": kept})
        except OSError as exc:
            cache_err = str(exc)[:80]
    error = None
    if kept and not desk:
        error = "none of the %d chat files is a desktop chat (has the transcript format changed?)" % len(kept)
    elif desk and not prompts:
        error = "%d desktop chats but no prompt read in any (has the transcript format changed?)" % desk
    elif desk and not turns:
        error = "%d desktop chats but no finished reply read in any (has the transcript format changed?)" % desk
    elif desk and not texts:
        error = "%d desktop chats but no reply text read in any (has the transcript format changed?)" % desk
    return {"sessions": sessions, "files": len(kept), "desktop": desk, "parsed": parsed, "unread": unread,
            "cacheError": cache_err, "error": error}


def day_text(at):
    t = _aware(at)
    return t.astimezone(LONDON).strftime("%-d %b") if t else "?"


def facts(now, read=None):
    """The AI team line's facts. `read` is read_sessions' result (tests hand one in)."""
    r = read if read is not None else read_sessions(now)
    if r.get("error"):
        return {"error": r["error"]}
    asked = back = asks = back_asks = model = 0
    reasons, items = {}, []
    for s in r["sessions"]:
        counted = [a for a in s["asks"] if a["kind"] not in NOT_COUNTED]
        model += len(s["asks"]) - len(counted)
        if not counted:
            continue
        asked += 1
        asks += len(counted)
        hb = [a for a in counted if a["kind"] == "handback"]
        if not hb:
            continue
        back += 1
        back_asks += len(hb)
        for a in hb:
            reasons[a["why"]] = reasons.get(a["why"], 0) + 1
            # The chat's title, the day and the reason leave the Mac; the ask's own words stay in
            # the dry run (they can quote a private matter).
            items.append((a["at"], {"name": (s["title"] or "Untitled session")[:120],
                                    "note": "%s, %s" % (day_text(a["at"]), a["why"])}))
    items = [it for _, it in sorted(items, key=lambda x: x[0], reverse=True)]   # newest first
    return {"sessions": asked, "back": back, "asks": asks, "backAsks": back_asks, "model": model,
            "reasons": sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0])), "items": items,
            "unread": r["unread"], "files": r["files"], "cacheError": r.get("cacheError")}


# ─── commands ─────────────────────────────────────────────────────────
def cmd_dry_run(days=WINDOW_DAYS):
    now = datetime.now(timezone.utc)
    t0 = datetime.now()
    r = read_sessions(now, days=days, cache_path=CACHE if days == WINDOW_DAYS else None)
    if r.get("error"):
        print("CAN'T TELL: %s" % r["error"])
        return 1
    secs = (datetime.now() - t0).total_seconds()
    f = facts(now, r)
    print("SESSIONS (last %d days): %d asked you something, %d came back to you%s" % (
        days, f["sessions"], f["back"],
        (" (score %d%%)" % round(100.0 * (f["sessions"] - f["back"]) / f["sessions"])) if f["sessions"] else ""))
    print("ASKS: %d in all, %d not one of your four; %d model switches not counted" % (f["asks"], f["backAsks"], f["model"]))
    print("READ: %d chat files in the window, %d parsed now, %.1fs%s" % (
        r["files"], r["parsed"], secs, ("; cache not written: " + r["cacheError"]) if r["cacheError"] else ""))
    for u in r["unread"]:
        print("  could not read: %s" % u)
    for why, n in f["reasons"]:
        print("REASON: %-34s %d" % (why, n))
    kinds = {}
    for s in r["sessions"]:
        for a in s["asks"]:
            kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    print("BY KIND: %s" % ", ".join("%s %d" % kv for kv in sorted(kinds.items(), key=lambda kv: -kv[1])))
    for s in sorted(r["sessions"], key=lambda s: min(a["at"] for a in s["asks"])):
        hb = [a for a in s["asks"] if a["kind"] == "handback"]
        if not hb:
            continue
        print("\n%s  [%s]" % (s["title"] or "Untitled session", s["id"][:8]))
        for a in hb:
            print("  - %s %-8s %-30s %s" % (day_text(a["at"]), a["source"], a["why"], a["text"][:150]))
    return 0


def predict(item):
    """For a labelled ask: "handback", "ok" (one of his four) or "none" (no ask found)."""
    if item.get("source") == "closing":
        kinds = [k for _, k, _ in closing_asks(item["text"]) if k not in NOT_COUNTED]
    else:
        kinds = [question_ask(item["text"])[0]]
    if "handback" in kinds:
        return "handback"
    return "ok" if kinds else "none"


def cmd_backtest(path):
    """LABELS: a JSON list of {source: closing|question, text, truth: handback|ok|none}. Prints
    how often the rules agree, and every disagreement."""
    with open(path, encoding="utf-8") as fh:
        labels = json.load(fh)
    tp = fp = fn = agree = 0
    wrong = []
    for i, it in enumerate(labels, 1):
        p, t = predict(it), it["truth"]
        agree += p == t
        tp += p == "handback" and t == "handback"
        fp += p == "handback" and t != "handback"
        fn += p != "handback" and t == "handback"
        if p != t:
            wrong.append((i, t, p, it["text"].replace("\n", " / ")[:140]))
    n = len(labels)
    print("LABELLED: %d (hand-backs %d, your four %d, no ask %d)" % (
        n, sum(1 for x in labels if x["truth"] == "handback"), sum(1 for x in labels if x["truth"] == "ok"),
        sum(1 for x in labels if x["truth"] == "none")))
    print("AGREE: %d of %d (%d%%)" % (agree, n, round(100.0 * agree / n) if n else 0))
    print("HAND-BACKS: %d right, %d false positives, %d missed; precision %s, recall %s" % (
        tp, fp, fn, ("%d%%" % round(100.0 * tp / (tp + fp))) if tp + fp else "n/a",
        ("%d%%" % round(100.0 * tp / (tp + fn))) if tp + fn else "n/a"))
    for i, t, p, text in wrong:
        print("  #%d labelled %s, read as %s: %s" % (i, t, p, text))
    return 0


def selftest():
    cases = [
        ("Next: open Evernote, search 1234, save those four PDFs to Downloads.", ("handback", "fetch a document")),
        ('Reply "use it", or tell me what to change.', ("correct", "")),
        ("Next: open your approval queue and take the three cards.", ("approve", "")),
        ("Switch in the model picker (terminal: /model x), then reply go.", ("model", "")),
        ("Next: I merge it once the review is clean.", None),
        ("Next: sign in to SpareRoom in the tab I left open.", ("access", "")),
        ("Next: tap the Monzo card.", ("pay", "")),
        ("Next: run the command above, sign in, close the window.", ("handback", "run a command")),
        ('Next: reply "send it" and I will send it.', ("approve", "")),
    ]
    failed = []
    for text, want in cases:
        got = closing_asks(text)
        have = (got[0][1], got[0][2]) if got else None
        if have != want:
            failed.append("%r read as %r, not %r" % (text, have, want))
    if question_ask("Which option should the form use?") != ("approve", ""):
        failed.append("an option question is a decision")
    if question_ask("Have you reloaded the AI Agents tab?")[0] != "handback":
        failed.append("a question that asks for a step is a hand-back")
    if question_ask('Can you click "Sign in as Kevin" there, then tell me?')[0] != "access":
        failed.append("clicking the sign-in button is giving access")
    return {"checks": len(cases) + 3, "failed": failed}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else ""
    if cmd == "dry-run":
        return cmd_dry_run(int(argv[argv.index("--days") + 1]) if "--days" in argv[:-1] else WINDOW_DAYS)
    if cmd == "backtest" and len(argv) > 1:
        return cmd_backtest(argv[1])
    if cmd == "selftest":
        out = selftest()
        print(json.dumps(out))
        return 1 if out["failed"] else 0
    print(__doc__.split("Usage:")[1].split("Reads ")[0].strip())
    return 2


if __name__ == "__main__":
    sys.exit(main())
