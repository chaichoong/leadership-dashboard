#!/usr/bin/env python3
"""PreToolUse hook: refuse a bare PR merge, send it through the merge gate.

WHY THIS EXISTS (29 Sep 2026)
-----------------------------
405 of the 472 changes that reached main in the 30 days to 29 Sep 2026 arrived
by `gh pr merge --squash` from an interactive Claude session. Nothing tested
that route: scripts/pre-push gates only a direct push to main, and no GitHub
workflow runs the tests. So the route almost everything takes was the one route
with no gate at all.

scripts/merge-pr.py is the gate for that route. This hook is what makes it the
only route: when a Bash call would run `gh pr merge`, a `gh api` write to
/pulls/<n>/merge (or the GraphQL mergePullRequest mutation), or a curl / wget
write to that endpoint, the call is denied and Claude is told to run
merge-pr.py instead. It also runs on the desktop app's
mcp__ccd_pr__set_auto_merge tool and denies turning auto-merge ON: auto-merge
lands the PR on GitHub when its checks pass, and no check here runs the tests,
so it is a merge with no gate. Turning auto-merge off is allowed.

ALSO: SKIPPING THE GIT HOOKS (30 Sep 2026)
The same hook refuses a git commit, push, merge, pull, am or rebase that
carries `--no-verify` (or `git commit -n`, its short form; on push, merge and
pull `-n` means something else and passes), or that points core.hooksPath
somewhere else with `git -c`. This repo is PUBLIC: the pre-commit hook is the
only thing that stops a line naming someone on the private roster reaching it
(scripts/private-name-guard.py), the commit-msg hook checks messages for the
same, and the pre-push hook runs the test gate that SKIP_SYNC_TESTS=1, already
a deny rule, would skip. A replay of 103,276 past session commands on 30 Sep
2026 found 97 commits that skipped the hooks, in 14 sessions from 1 Jul to
29 Sep: 87 by `git -c core.hooksPath=/dev/null`, 10 by `--no-verify`, 5 of
them by helper agents, 3 after the name guard went live on 21 Sep. None of
the 194 commits on main since then names anyone on the roster, so no leak
yet. The same replay drew 0 false refusals. Source: a guide review of
khasky/awesome-agents-md ("never make a failing check pass by weakening it").

HOW IT DECIDES
It reads the command the way a shell would, far enough to know which words
sit in COMMAND POSITION: it splits on newlines, ; & && || | and ( ), follows
$( ), backticks, <( ) and ${...}, skips a heredoc's body, removes quotes, and
steps past leading VAR=value words and wrappers (command, builtin, exec, env,
time, sudo, nohup, nice, timeout, xargs, caffeinate, stdbuf, arch, watch,
script), with their option forms. `bash -c '...'`, `eval ...`, `watch '...'`,
`script -c '...'` and a heredoc fed straight to a shell are read as commands
too, because they run. Text that only MENTIONS a merge (a commit message, a
heredoc body, an echo) passes.

WHAT IT DOES NOT TRY TO CATCH, ON PURPOSE
It stops a habit, not an adversary. `echo 'gh pr merge 5' | bash`, a GraphQL
mutation read from a file (`gh api graphql -F query=@file`), a gh alias, or a
merge made from inside Python are left alone: each is deliberate evasion, and
chasing them would cost false denials on ordinary commands.

FAILURE MODES, ON PURPOSE
  * A command it cannot parse (an unbalanced quote) falls back to a regex for
    a merge at a command start, and is denied on a hit: fail closed, for merges.
  * Any other internal error ALLOWS the call. This hook runs before every Bash
    call in the session; a guard that blocks everything is an outage.
  * Malformed hook input, or a tool that is not Bash, is allowed.

Usage:  (as a hook) JSON on stdin, deny JSON on stdout, always exit 0
        python3 scripts/merge-guard.py --selftest    # built-in cases, exit 1 on a miss
Denials are logged to ~/knowledge-os/logs/merge-guard.log (outside the repo,
which is PUBLIC). Guarded by tests/merge-guard.test.js.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone


class ParseError(Exception):
    """The command is not shell the reader can follow (an unbalanced quote)."""


MAX_DEPTH = 8
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
# Words that come before a command without being one.
RESERVED = {"!", "{", "}", "then", "else", "elif", "do", "if", "while", "until",
            "fi", "done", "esac"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=")
# The REST merge endpoint, anchored, so a field value that mentions it is not it.
MERGE_ENDPOINT = re.compile(
    r"^(?:https?://[^/\s]+)?(?:/api/v3)?/?(?:repos/[^/\s]+/[^/\s]+/)?pulls/(\d+)/merge/?(?:\?.*)?$")
GRAPHQL_MERGE = re.compile(r"\b(mergePullRequest|enablePullRequestAutoMerge)\b")
PR_URL = re.compile(r"/pull/(\d+)")
# Fallback for text the reader cannot follow: a merge at a command start.
FALLBACK = re.compile(
    r"(?:^|[\n;&|(`]|\$\()\s*"
    r"(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*"
    r"(?:(?:command|builtin|exec|env|time|sudo|nohup|nice|timeout|xargs|caffeinate|stdbuf|arch|watch)\s+(?:-\S*\s+)*(?:\d+\S*\s+)?)*"
    r"(?:\S*/)?gh\s+(?:(?:-R|--repo)\s+\S+\s+)?"
    r"(?:pr\s+merge\b(?:\s+(\d+))?|api\b[^\n;&|]*?pulls/(\d+)/merge\b)")

# Wrappers that run the command after them, and which of their flags take a value.
WRAPPERS = {
    "command": set(), "builtin": set(), "exec": {"-a"}, "nohup": set(),
    "time": {"-f", "--format", "-o", "--output"},
    "env": {"-u", "--unset", "-C", "--chdir"},
    "sudo": {"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user",
             "--group", "--host", "--prompt", "--chdir", "--role", "--type",
             "--other-user", "--close-from", "--command-timeout"},
    "nice": {"-n", "--adjustment"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "xargs": {"-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args",
              "--replace", "--max-lines", "--max-procs", "--max-chars",
              "--delimiter", "--eof", "--arg-file"},
    "caffeinate": {"-t", "-w"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "arch": {"-arch", "-e", "-d"},
}
# watch and script take their command in their own ways; see inspect().
WATCH_VALUE = {"-n", "--interval", "-q", "--equexit"}
SCRIPT_VALUE = {"-t", "-T", "--log-timing", "-I", "--log-in", "-O", "--log-out",
                "-B", "--log-io", "-m", "--logging-format", "-E", "--echo"}
AUTO_MERGE_TOOL = "mcp__ccd_pr__set_auto_merge"
# git subcommands that run hooks `--no-verify` would skip. Only on commit is -n
# its short form: on push it is --dry-run, on merge and pull --no-stat.
HOOKED_GIT = {"commit", "push", "merge", "pull", "am", "rebase"}
GIT_GLOBAL_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                    "--exec-path", "--config-env", "--super-prefix"}
COMMIT_VALUE = {"-m", "-F", "-C", "-c", "-t", "--message", "--file",
                "--reuse-message", "--reedit-message", "--template", "--author",
                "--date", "--cleanup", "--fixup", "--squash", "--trailer",
                "--pathspec-from-file"}
NO_VERIFY = "--no-verify"
SKIP_TAG = "hooks:"          # judge() result for a hook skip, e.g. "hooks:commit --no-verify"
CURL_DATA = {"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
             "--data-ascii", "--json", "-F", "--form", "--form-string"}
# Redirection operators, longest first. `<(` and `>(` are process substitution.
REDIRECT = re.compile(r"(\d*)(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)")


class Shell:
    """Just enough of a POSIX shell reader to list the simple commands a string
    would run, at any depth. Each command is its list of words, quotes removed."""

    def __init__(self, text, depth=0, commands=None):
        if depth > MAX_DEPTH:
            raise ParseError("nested too deep")
        self.s = text
        self.n = len(text)
        self.i = 0
        self.depth = depth
        self.commands = commands if commands is not None else []
        self.heredocs = []   # pending [delimiter, strip_tabs, owner_words]

    def parse(self):
        self.parse_list(None)
        return self.commands

    # ── structure ────────────────────────────────────────────────────
    def skip_blanks(self):
        while self.i < self.n:
            c = self.s[self.i]
            if c in " \t\r":
                self.i += 1
            elif c == "\\" and self.s[self.i + 1:self.i + 2] == "\n":
                self.i += 2
            else:
                return

    def skip_comment(self):
        j = self.s.find("\n", self.i)
        self.i = self.n if j < 0 else j

    def parse_list(self, end):
        while True:
            self.skip_blanks()
            if self.i >= self.n:
                if end is not None:
                    raise ParseError("unclosed $( or (")
                return
            c = self.s[self.i]
            if end is not None and c == end:
                self.i += 1
                return
            if c == "\n":
                self.i += 1
                self.read_heredoc_bodies()
            elif c in ";&|":
                self.i += 1
            elif c == ")":
                self.i += 1          # a stray ) (a case pattern); nothing to run
            elif c == "#":
                self.skip_comment()
            elif c == "(":
                if self.s.startswith("((", self.i):
                    self.skip_parens(self.i)          # (( arithmetic ))
                else:
                    self.i += 1
                    self.parse_list(")")             # ( subshell )
            else:
                self.parse_command()

    def parse_command(self):
        words = []
        self.commands.append(words)
        while True:
            self.skip_blanks()
            if self.i >= self.n:
                return
            c = self.s[self.i]
            if c in "\n;|)":
                return
            if c == "&" and not self.s.startswith("&>", self.i):
                return
            if c == "#":
                self.skip_comment()
                return
            if c == "(":
                if words and words[-1].endswith("="):     # arr=( a b )
                    self.skip_parens(self.i)
                    continue
                return                                    # f() { ...; }
            two = self.s[self.i:self.i + 2]
            if two in ("<(", ">("):
                self.i += 2
                self.parse_list(")")
                words.append("<()")
                continue
            m = REDIRECT.match(self.s, self.i)      # "2>&1", "<<'EOF'", "> out"
            if m:
                self.i = m.end()
                op = m.group(2)
                self.skip_blanks()
                target = self.read_word()
                if op in ("<<", "<<-"):
                    self.heredocs.append([target, op == "<<-", words])
                continue
            words.append(self.read_word())

    def skip_parens(self, start):
        """Skip a balanced ( ... ) that holds no command we need, e.g. $(( 1+2 ))."""
        depth = 0
        j = start
        while j < self.n:
            c = self.s[j]
            if c == "\\":
                j += 2
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    self.i = j + 1
                    return
            j += 1
        raise ParseError("unbalanced (")

    def read_heredoc_bodies(self):
        pending, self.heredocs = self.heredocs, []
        for delim, strip_tabs, owner in pending:
            body = []
            while self.i < self.n:
                j = self.s.find("\n", self.i)
                line = self.s[self.i:j if j >= 0 else self.n]
                self.i = j + 1 if j >= 0 else self.n
                if (line.lstrip("\t") if strip_tabs else line) == delim:
                    break
                body.append(line)
            # A heredoc is text, unless it is fed straight to a shell, which runs it.
            if runs_stdin_as_shell(owner):
                Shell("\n".join(body), self.depth + 1, self.commands).parse()

    # ── words ────────────────────────────────────────────────────────
    def read_word(self):
        out = []
        while self.i < self.n:
            c = self.s[self.i]
            if c in " \t\r\n;&|<>()":
                break
            if c == "\\":
                nxt = self.s[self.i + 1:self.i + 2]
                self.i += 2
                if nxt and nxt != "\n":
                    out.append(nxt)
            elif c == "'":
                j = self.s.find("'", self.i + 1)
                if j < 0:
                    raise ParseError("unclosed '")
                out.append(self.s[self.i + 1:j])
                self.i = j + 1
            elif c == '"':
                out.append(self.read_dquote())
            elif c == "`":
                out.append(self.read_backtick())
            elif c == "$":
                out.append(self.read_dollar(in_dquote=False))
            else:
                out.append(c)
                self.i += 1
        return "".join(out)

    def read_dquote(self):
        self.i += 1
        out = []
        while self.i < self.n:
            c = self.s[self.i]
            if c == '"':
                self.i += 1
                return "".join(out)
            if c == "\\":
                nxt = self.s[self.i + 1:self.i + 2]
                if nxt in ("$", "`", '"', "\\", "\n"):
                    if nxt != "\n":
                        out.append(nxt)
                    self.i += 2
                else:
                    out.append("\\")
                    self.i += 1
            elif c == "`":
                out.append(self.read_backtick())
            elif c == "$":
                out.append(self.read_dollar(in_dquote=True))
            else:
                out.append(c)
                self.i += 1
        raise ParseError('unclosed "')

    def read_backtick(self):
        j = self.i + 1
        buf = []
        while j < self.n:
            c = self.s[j]
            if c == "\\" and self.s[j + 1:j + 2] in ("`", "$", "\\"):
                buf.append(self.s[j + 1])
                j += 2
                continue
            if c == "`":
                break
            buf.append(c)
            j += 1
        if j >= self.n:
            raise ParseError("unclosed `")
        self.i = j + 1
        Shell("".join(buf), self.depth + 1, self.commands).parse()
        return "``"

    def read_dollar(self, in_dquote):
        nxt = self.s[self.i + 1:self.i + 2]
        if nxt == "'" and not in_dquote:                  # $'ansi c'
            j = self.i + 2
            while j < self.n and self.s[j] != "'":
                j += 2 if self.s[j] == "\\" else 1
            if j >= self.n:
                raise ParseError("unclosed $'")
            text = self.s[self.i + 2:j]
            self.i = j + 1
            return text
        if nxt == '"' and not in_dquote:                  # $"locale"
            self.i += 1
            return self.read_dquote()
        if nxt == "(":
            if self.s.startswith("$((", self.i):
                self.skip_parens(self.i + 1)
                return "$(())"
            self.i += 2
            self.parse_list(")")
            return "$()"
        if nxt == "{":
            self.skip_brace()
            return "${}"
        self.i += 1
        return "$"

    def skip_brace(self):
        """${...}: its default value can hold a $( ) that runs, so read inside."""
        self.i += 2
        depth = 1
        while self.i < self.n:
            c = self.s[self.i]
            if c == "\\":
                self.i += 2
            elif c == "'":
                j = self.s.find("'", self.i + 1)
                if j < 0:
                    raise ParseError("unclosed ' in ${")
                self.i = j + 1
            elif c == '"':
                self.read_dquote()
            elif c == "`":
                self.read_backtick()
            elif c == "$" and self.s[self.i + 1:self.i + 2] in ("(", "{"):
                if self.s[self.i + 1] == "{":
                    self.i += 2
                    depth += 1
                else:
                    self.read_dollar(in_dquote=True)
            elif c == "}":
                depth -= 1
                self.i += 1
                if depth == 0:
                    return
            else:
                self.i += 1
        raise ParseError("unclosed ${")


# ─── what a command IS, once the wrappers are off ─────────────────────

def skip_flags(words, i, takes_value):
    while i < len(words) and words[i].startswith("-") and words[i] != "-":
        w = words[i]
        i += 1
        if w == "--":
            break
        if w in takes_value:
            i += 1
    return i


def strip_wrappers(words):
    i = 0
    while i < len(words):
        w = words[i]
        base = os.path.basename(w)
        if ASSIGN.match(w) or w in RESERVED:
            i += 1
        elif base in WRAPPERS:
            i = skip_flags(words, i + 1, WRAPPERS[base])
            if base == "env":
                while i < len(words) and ASSIGN.match(words[i]):
                    i += 1
            elif base == "timeout" and i < len(words):
                i += 1                                   # the duration
            elif base == "nice" and i < len(words) and re.match(r"^-\d+$", words[i]):
                i += 1
        else:
            break
    return words[i:]


def shell_c_arg(words):
    """For `bash [-o x] -c 'cmd'`, the command string, else None."""
    k = 1
    while k < len(words):
        w = words[k]
        if w in ("-o", "+o", "-O", "+O"):
            k += 2
            continue
        if w == "--" or not (w.startswith("-") or w.startswith("+")):
            return None
        if w.startswith("-") and not w.startswith("--") and "c" in w[1:]:
            return words[k + 1] if k + 1 < len(words) else None
        k += 1
    return None


def runs_stdin_as_shell(words):
    """A heredoc fed to `bash` or `sh -s` (no -c, no script) is run as commands."""
    w = strip_wrappers(list(words))
    if not w or os.path.basename(w[0]) not in SHELLS:
        return False
    if shell_c_arg(w) is not None:
        return False
    rest = [x for x in w[1:] if not (x.startswith("-") or x.startswith("+"))]
    return not rest


def pr_number(args):
    for a in args:
        if a.startswith("-"):
            continue
        if a.isdigit():
            return a
        m = PR_URL.search(a)
        if m:
            return m.group(1)
    return None


def gh_merge(args):
    """The PR number (or "?") when these gh arguments merge a PR, else None."""
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in ("-R", "--repo") else 1
    if i >= len(args):
        return None
    sub, rest = args[i], args[i + 1:]
    if sub == "pr":
        j = 0
        while j < len(rest) and rest[j].startswith("-"):
            j += 2 if rest[j] in ("-R", "--repo") else 1
        if j < len(rest) and rest[j] == "merge":
            tail = rest[j + 1:]
            # Help and switching auto-merge OFF merge nothing.
            if any(t in ("-h", "--help", "--disable-auto") for t in tail):
                return None
            return pr_number(tail) or "?"
        return None
    if sub == "api":
        method, fields, number, graphql = None, False, None, False
        k = 0
        while k < len(rest):
            a = rest[k]
            if a in ("-X", "--method"):
                method = rest[k + 1] if k + 1 < len(rest) else ""
                k += 2
                continue
            if a.startswith("--method="):
                method = a.split("=", 1)[1]
            elif a.startswith("-X") and len(a) > 2:
                method = a[2:].lstrip("=")
            elif a in ("-f", "-F", "--field", "--raw-field", "--input") or \
                    a.startswith(("--field=", "--raw-field=", "--input=")) or \
                    (a[:2] in ("-f", "-F") and len(a) > 2):
                fields = True
            m = MERGE_ENDPOINT.match(a)
            if m:
                number = m.group(1)
            if a == "graphql":
                graphql = True
            elif GRAPHQL_MERGE.search(a):
                graphql = graphql or "mutation"
            k += 1
        if method is None:
            method = "POST" if fields else "GET"
        if number and method.upper() != "GET":
            return number                                # GET only reads merge status
        if graphql is True and any(GRAPHQL_MERGE.search(a) for a in rest):
            return "?"
    return None


def http_merge(tool, args):
    """The PR number when a curl or wget call WRITES to /pulls/<n>/merge. A GET
    only reads whether the PR is merged, so it passes."""
    method, implied, number = None, None, None
    i = 0
    while i < len(args):
        a = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else ""
        m = MERGE_ENDPOINT.match(a)
        if m:
            number = m.group(1)
        name, eq, val = a.partition("=")
        if tool == "wget":
            if name == "--method":
                method = val if eq else nxt
            elif name in ("--post-data", "--post-file"):
                implied = implied or "POST"
        elif a.startswith("--"):
            if name == "--request":
                method = val if eq else nxt
            elif name in CURL_DATA:
                implied = implied or "POST"
            elif name == "--upload-file":
                implied = "PUT"
            elif name == "--url" and MERGE_ENDPOINT.match(val if eq else nxt):
                number = MERGE_ENDPOINT.match(val if eq else nxt).group(1)
        elif a.startswith("-") and len(a) > 1:
            cluster = a[1:]
            for k, ch in enumerate(cluster):     # -sSX PUT, -XPUT, -sd @body
                if ch in "XdFT":
                    value = cluster[k + 1:] or nxt
                    if ch == "X":
                        method = value
                    elif ch == "T":
                        implied = "PUT"
                    else:
                        implied = implied or "POST"
                    break
        i += 1
    verb = (method or implied or "GET").upper()
    return number if number and verb not in ("GET", "HEAD") else None


def is_no_verify(word):
    """--no-verify, or an abbreviation git would accept for it (--no-veri...)."""
    return len(word) >= len("--no-veri") and NO_VERIFY.startswith(word)


def git_skip(args):
    """"hooks:<sub> <flag>" when these git arguments skip the hooks, else None."""
    i, hooks_path = 0, False
    while i < len(args) and args[i].startswith("-"):
        a = args[i]
        value = None
        if a in GIT_GLOBAL_VALUE:
            value = args[i + 1] if i + 1 < len(args) else ""
            i += 2
        else:
            if a.startswith("-c") and len(a) > 2:
                value = a[2:]
            i += 1
        if a.startswith("-c") and value and value.lower().startswith("core.hookspath="):
            hooks_path = True
    if i >= len(args) or args[i] not in HOOKED_GIT:
        return None
    sub, rest = args[i], args[i + 1:]
    if hooks_path:
        return "%s%s -c core.hooksPath" % (SKIP_TAG, sub)
    k = 0
    while k < len(rest):
        a = rest[k]
        k += 1
        if a == "--":
            break
        if is_no_verify(a):
            return "%s%s %s" % (SKIP_TAG, sub, NO_VERIFY)
        if sub != "commit" or not a.startswith("-") or a == "-":
            continue
        if a.startswith("--"):
            if "=" not in a and a in COMMIT_VALUE:
                k += 1                                   # --message "text"
            continue
        # A short cluster: -anm "msg" is -a -n -m. After m, F, C, c or t the
        # rest of the cluster (or the next word) is that option's value.
        for pos, ch in enumerate(a[1:]):
            if ch == "n":
                return "%s%s -n" % (SKIP_TAG, sub)
            if ch in "mFCct":
                if pos == len(a) - 2:
                    k += 1
                break
            if ch in "Su":                               # -S<keyid>, -u<mode>
                break
    return None


def inspect(words, depth):
    words = strip_wrappers(words)
    if not words:
        return None
    base = os.path.basename(words[0])
    if base == "git":
        return git_skip(words[1:])
    if base in SHELLS:
        inner = shell_c_arg(words)
        return scan_or_fallback(inner, depth + 1) if inner is not None else None
    if base == "eval":
        return scan_or_fallback(" ".join(words[1:]), depth + 1)
    if base == "watch":
        # watch joins what follows its options and hands it to sh -c.
        i = skip_flags(words, 1, WATCH_VALUE)
        return scan_or_fallback(" ".join(words[i:]), depth + 1) if i < len(words) else None
    if base == "script":
        # util-linux: script -c 'cmd' [file]. BSD and macOS: script [file [cmd ...]].
        k = 1
        while k < len(words) and words[k].startswith("-") and words[k] != "-":
            w = words[k]
            if w in ("-c", "--command"):
                return scan_or_fallback(words[k + 1], depth + 1) if k + 1 < len(words) else None
            if w.startswith("--command="):
                return scan_or_fallback(w.split("=", 1)[1], depth + 1)
            k += 2 if w in SCRIPT_VALUE else 1
        return inspect(words[k + 1:], depth) if k + 1 < len(words) else None
    if base == "gh":
        return gh_merge(words[1:])
    if base in ("curl", "wget"):
        return http_merge(base, words[1:])
    return None


def scan(text, depth=0):
    """The PR number (or "?") if the command string merges a PR, else None.
    Raises ParseError on shell it cannot follow."""
    for words in Shell(text, depth).parse():
        hit = inspect(words, depth)
        if hit:
            return hit
    return None


def scan_or_fallback(text, depth):
    try:
        return scan(text, depth)
    except ParseError:
        return fallback(text)


def fallback(text):
    m = FALLBACK.search(text)
    if not m:
        return None
    return m.group(1) or m.group(2) or "?"


def judge(command):
    """PR number (or "?") to deny, or None to allow. Never raises."""
    try:
        return scan(command)
    except ParseError:
        pass
    except Exception as exc:        # a bug here must not block every Bash call
        print("merge-guard: reader failed (%s); using the fallback" % exc, file=sys.stderr)
    try:
        return fallback(command)
    except Exception as exc:
        print("merge-guard: fallback failed (%s); allowing" % exc, file=sys.stderr)
        return None


def reason(pr):
    n = pr if pr and pr != "?" else "<N>"
    return (
        "Blocked by the merge gate: PRs are not merged with a bare `gh pr merge` "
        "or a `gh api` merge call. Run `python3 scripts/merge-pr.py --pr %s` "
        "instead, with run_in_background (it takes 5 to 15 minutes). It builds "
        "origin/main with the PR merged in, runs vitest and the browser suite on "
        "that tree, walks the pages the PR touches, and merges only when all of "
        "that is green. If it refuses because main itself is red, the fix is to "
        "repair main first in its own PR, not to go around the gate." % n)


def auto_merge_reason(pr):
    n = pr or "<N>"
    return (
        "Blocked by the merge gate: turning auto-merge ON lands the PR on GitHub as "
        "soon as its checks pass, and no check on this repo runs the tests, so it "
        "is a merge with no gate. Run `python3 scripts/merge-pr.py --pr %s` "
        "instead, with run_in_background (it takes 5 to 15 minutes). Turning "
        "auto-merge OFF is allowed." % n)


def skip_reason(what):
    return (
        "Blocked: `git %s` skips this repo's git hooks. The repo is PUBLIC, and "
        "the pre-commit hook (scripts/private-name-guard.py) is the only thing "
        "that stops a private name reaching it; the commit-msg hook checks the "
        "message for the same; the pre-push hook runs the test gate, which "
        "SKIP_SYNC_TESTS=1 is already denied for skipping. Run the command "
        "without it. If a hook refuses, read what it says and fix the cause. If "
        "you believe the hook itself is wrong, stop: name the hook, say why, and "
        "ask Kevin. Do not look for another way round it." % what)


def log_denial(command):
    try:
        path = os.path.join(os.path.expanduser("~"), "knowledge-os", "logs", "merge-guard.log")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        text = re.sub(r"\b([A-Za-z_]*(?:TOKEN|KEY|SECRET|PAT|PASSWORD)[A-Za-z_]*)=\S+",
                      r"\1=[REDACTED]", command, flags=re.I)
        text = re.sub(r"[\t\r\n]+", " ", text)[:120]
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(path, "a") as fh:
            fh.write("%s\t%s\n" % (stamp, text))
    except Exception as exc:
        print("merge-guard: could not write the denial log: %s" % exc, file=sys.stderr)


def main():
    try:
        data = json.loads(sys.stdin.read())
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0
    tool = data.get("tool_name")
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    if tool == AUTO_MERGE_TOOL:
        # Turning auto-merge ON is a merge with no gate; turning it off is not.
        enabled = tool_input.get("enabled")
        if enabled is True or str(enabled).strip().lower() in ("true", "1", "yes"):
            url = str(tool_input.get("url") or "")
            m = PR_URL.search(url)
            log_denial("%s enabled=true %s" % (AUTO_MERGE_TOOL, url))
            deny(auto_merge_reason(m.group(1) if m else None))
        return 0
    if tool != "Bash":
        return 0
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        return 0
    pr = judge(command)
    if pr:
        log_denial(command)
        deny(skip_reason(pr[len(SKIP_TAG):]) if pr.startswith(SKIP_TAG) else reason(pr))
    return 0


def deny(why):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": why,
    }}))


# ─── selftest ─────────────────────────────────────────────────────────

HEREDOC_COMMIT = """git commit -m "$(cat <<'EOF'
Fix: stop using a bare merge

gh pr merge 5 --squash
) still inside the body
EOF
)\""""

CASES = [
    # (command, denied?)
    ("gh pr merge 5 --squash --delete-branch", True),
    ("gh pr merge --auto --squash 12", True),
    ("cd /tmp && gh pr merge 5", True),
    ("git status\ngh pr merge 5 --squash", True),
    ("echo $(gh pr merge 5)", True),
    ('echo "done: $(gh pr merge 5)"', True),
    ("x=`gh pr merge 5`", True),
    ("GH_DEBUG=1 FOO=bar gh pr merge 5", True),
    ("command gh pr merge 5", True),
    ("env GH_PROMPT_DISABLED=1 gh pr merge 5", True),
    ("time gh pr merge 5", True),
    ("sudo -u kevin gh pr merge 5", True),
    ("timeout 600 gh pr merge 5", True),
    ("/opt/homebrew/bin/gh pr merge 5", True),
    ("gh -R chaichoong/leadership-dashboard pr merge 5", True),
    ("gh pr -R chaichoong/leadership-dashboard merge 5", True),
    ("if true; then gh pr merge 5; fi", True),
    ("{ gh pr merge 5; }", True),
    ("(gh pr merge 5)", True),
    ("git push && gh pr merge 5 || echo failed", True),
    ("gh pr view 5 | gh pr merge 5", True),
    ("bash -c 'gh pr merge 5'", True),
    ("bash -lc \"cd x && gh pr merge 5\"", True),
    ("eval gh pr merge 5", True),
    ("bash <<EOF\ngh pr merge 5\nEOF", True),
    ("gh api -X PUT repos/chaichoong/leadership-dashboard/pulls/5/merge", True),
    ("gh api --method PUT repos/o/r/pulls/5/merge -f merge_method=squash", True),
    ("gh api -XPUT /repos/o/r/pulls/5/merge", True),
    ("gh api --method=PUT repos/{owner}/{repo}/pulls/5/merge", True),
    ("gh api repos/o/r/pulls/5/merge -f merge_method=squash", True),
    ("gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'", True),
    ("caffeinate -i -t 600 gh pr merge 5", True),
    ("stdbuf -oL gh pr merge 5", True),
    ("stdbuf -o L gh pr merge 5", True),
    ("arch -arm64 gh pr merge 5", True),
    ("arch -arch arm64 gh pr merge 5", True),
    ("nice -n 10 gh pr merge 5", True),
    ("nohup gh pr merge 5 &", True),
    ("timeout --foreground -k 5 600 gh pr merge 5", True),
    ("watch -n 60 gh pr merge 5", True),
    ("watch 'gh pr merge 5'", True),
    ("script -q /dev/null gh pr merge 5", True),
    ("script -c 'gh pr merge 5' /dev/null", True),
    ("curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/5/merge", True),
    ("curl -sSX PUT https://api.github.com/repos/o/r/pulls/5/merge", True),
    ("curl --request=PUT https://api.github.com/repos/o/r/pulls/5/merge -d '{}'", True),
    ("curl -d '{\"merge_method\":\"squash\"}' https://api.github.com/repos/o/r/pulls/5/merge", True),
    ("wget --method=PUT https://api.github.com/repos/o/r/pulls/5/merge", True),
    ("wget --method PUT -O- https://api.github.com/repos/o/r/pulls/5/merge", True),
    ('gh pr merge 5 --body "unterminated', True),
    ("echo 'x' ; gh pr merge 7 --subject \"oops", True),
    # allowed
    ("gh pr view 5 --json state,mergedAt", False),
    ("gh pr create --title 'Fix' --body 'body'", False),
    ("gh pr merge 5 --help", False),
    ("gh pr merge 5 --disable-auto", False),
    ('git commit -m "Fix: stop using gh pr merge 5 by hand"', False),
    ("git commit -m 'gh pr merge 5'", False),
    (HEREDOC_COMMIT, False),
    ("cat <<'EOF' > notes.txt\ngh pr merge 5\nEOF", False),
    ("cat <<-EOF\n\tgh pr merge 5\n\tEOF\necho ok", False),
    ("python3 scripts/merge-pr.py --pr 5", False),
    ("python3 scripts/merge-pr.py --pr 5 --dry-run 2>&1 | tail -5", False),
    ("echo gh pr merge 5", False),
    ("grep -rn 'gh pr merge' CLAUDE.md", False),
    ("grep -n gh\\ pr\\ merge x", False),
    ("# gh pr merge 5\nls", False),
    ("gh api repos/o/r/pulls/5/merge", False),
    ("gh api -X GET repos/o/r/pulls/5/merge", False),
    ("gh api -X DELETE repos/chaichoong/leadership-dashboard/git/refs/heads/feature/x", False),
    ("gh api repos/o/r/pulls/5 -f body='see pulls/5/merge'", False),
    ("gh api graphql -f query='query { repository(owner:\"o\", name:\"r\") { id } }'", False),
    ("git log --oneline -5", False),
    ("echo \"it's fine\" && ls", False),
    ("a=(one two); echo ${a[0]}", False),
    ("echo $((1 + 2))", False),
    ("echo ${X:-default}", False),
    ("command -v gh", False),
    ("curl -s https://api.github.com/repos/o/r/pulls/5/merge", False),
    ("curl -I https://api.github.com/repos/o/r/pulls/5/merge", False),
    ("curl -X PUT https://api.github.com/repos/o/r/pulls/5", False),
    ("wget -qO- https://api.github.com/repos/o/r/pulls/5/merge", False),
    ("caffeinate -i npx vitest run", False),
    ("watch -n 5 'gh pr view 5'", False),
    ("script -q /dev/null ls", False),
    ("echo 'gh pr merge 5' | bash", False),   # deliberate evasion: left alone (header)
    # skipping the git hooks: denied
    ("git commit --no-verify -m 'x'", True),
    ("git commit -q --amend --no-edit --no-verify", True),
    ("cd /tmp/wt && git commit --no-verify -F msg.txt", True),
    ("git commit -n -m 'x'", True),
    ("git commit -anm 'x'", True),
    ("git commit --no-veri -m x", True),
    ("git -C /tmp/wt commit --no-verify -m x", True),
    ("git -c user.name=x commit --no-verify", True),
    ("git -c core.hooksPath=/dev/null commit -m x", True),
    ("git -c core.hookspath=/dev/null push", True),
    ("git push --no-verify origin HEAD:main", True),
    ("git push -u origin fix/x --no-verify", True),
    ("git merge --no-verify origin/main", True),
    ("git pull --no-verify", True),
    ("git am --no-verify < x.patch", True),
    ("git rebase --no-verify origin/main", True),
    ("bash -c 'git commit --no-verify -m x'", True),
    ('echo "$(git commit --no-verify -m x)"', True),
    # skipping the git hooks: allowed
    ("git commit -m 'x'", False),
    ("git commit -am 'fix -n handling'", False),
    ("git commit -m --no-verify", False),
    ('git commit -m "why we never use --no-verify"', False),
    ("git commit -m -n", False),
    ("git commit -F notes.txt", False),
    ("git commit -S -m x", False),
    ("git commit --amend --no-edit", False),
    ("git commit --author 'n <e>' -m x", False),
    ("git commit -- --no-verify", False),
    ("git push -n origin HEAD", False),
    ("git push -u origin chore/x", False),
    ("git merge -n origin/main", False),
    ("git pull -n", False),
    ("git log -n 5", False),
    ("git log --oneline -- --no-verify", False),
    ("git -c user.name=x commit -m y", False),
    ("git config core.hooksPath", False),
    ("grep -rn -- '--no-verify' scripts/", False),
    ("echo git commit --no-verify", False),
    ("supabase functions deploy onboarding-submit --no-verify-jwt", False),
    ("python3 scripts/sync-master-plan.py", False),
]


def selftest():
    failures = 0
    for command, want in CASES:
        got = bool(judge(command))
        if got != want:
            failures += 1
            print("MISS: expected %s, got %s: %r" % (
                "deny" if want else "allow", "deny" if got else "allow", command))
    print("%d cases, %d failed" % (len(CASES), failures))
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:     # never block a Bash call on our own bug
        print("merge-guard: %s" % exc, file=sys.stderr)
        sys.exit(0)
