#!/usr/bin/env python3
"""Rework rate: how much of the recent work on origin/main went on fixing what had just shipped.

Why (29 Sep 2026): 405 of 472 changes in 30 days reached main by PR merge with no test
gate, and many fixes repaired something built days before. This is the measure that
shows whether the merge gate (scripts/merge-pr.py) and the worked example at the build
gate bring that down. Read-only: it runs `git fetch`, `git log`, `git diff` and
`git blame`, nothing else.

Usage:
    python3 scripts/rework-rate.py [--days 30] [--until YYYY-MM-DD] [--json] [--repo DIR]

Each definition reproduces a shell command, so any number can be checked by hand:
  changes   git log origin/main --since="30 days ago" --no-merges --oneline | grep -v "auto-bump"
  fixes     changes whose subject matches ^(fix|hotfix), any case
  area      from `git show --name-only --format="" <fix>` after dropping
            ^tests/ ^docs/ \\.md$ ^\\.claude/ : frontend if a path matches
            \\.(html|css)$|^js/|^os/, scripts if one matches \\.(py|sh)$|^scripts/|^workers/,
            both, or other
  line rework (the headline)
            for each fix F, `git diff -U0 F^ F -- <its files>` (dropping ^tests/ \\.md$
            config\\.js$ ^\\.claude/ ^docs/, first 20 files) gives the lines F removed or
            changed: `-a,b` in each hunk header, b > 0 only (a pure addition changed no old
            line). `git blame -w --porcelain -L a,+b F^ -- <file>` names who wrote them. F is
            line rework when one of those commits is not an auto-bump, not a fix, and was
            committed in the 7 days before F. At most 40 ranges per fix are blamed, so one
            huge fix cannot stall the run, and the output says when that cap was hit
  fix of a fix
            the same, where the commit that wrote the lines IS a fix: the fix that broke again
  file rework (blunt)
            a fix counts when a file it touched (same drop list) had a commit in the 7 days
            before the fix that is not the fix itself, not an auto-bump and not itself a fix.
            A busy file almost always has one, so this reads high (91% in Sep 2026)
  finder    from subject plus body: robot if it matches
            queue-fixer|finding [0-9]|finding 20|daily-ops-|sweep|invariant (any case),
            else person if it names Kevin or a team member, else review if review|audit,
            else unclear
  top files the 5 files fixed most often (dropping tests, docs, .md, .claude, logs,
            config.js, .json)

--until ends the window at 23:59:59 local time on that day, so a past month reproduces.
Checking file rework by hand in zsh: loop over the files with `for f in ${(f)files}`. A bare
`$files` is not split in zsh, so a multi-file fix is never checked and the count comes
out low (the 29 Sep brief's 40 matches the count over single-file fixes only).

Exit: 0 report printed, 1 git failed or the window held no changes (a wrong ref or a
failed fetch, never a quiet month on this repo).
"""

import argparse
import collections
import concurrent.futures
import datetime
import json
import os
import re
import subprocess
import sys
import time

REF = 'origin/main'
LOOKBACK_DAYS = 7
MAX_FILES = 20
MAX_RANGES = 40
BLAME_WORKERS = 4
TOP_N = 5

FIX = re.compile(r'^(fix|hotfix)', re.I)
AUTO_BUMP = 'auto-bump'
AREA_DROP = re.compile(r'^tests/|^docs/|\.md$|^\.claude/')
FRONTEND = re.compile(r'\.(html|css)$|^js/|^os/')
SCRIPTS = re.compile(r'\.(py|sh)$|^scripts/|^workers/')
REWORK_DROP = re.compile(r'^tests/|\.md$|config\.js$|^\.claude/|^docs/')
TOP_DROP = re.compile(r'^tests/|^docs/|\.md$|^\.claude/|(^|/)logs/|config\.js$|\.json$')
ROBOT = re.compile(r'queue-fixer|finding [0-9]|finding 20|daily-ops-|sweep|invariant', re.I)
# Case-sensitive: "roy-assistant" is a script, not Roy finding a bug.
PERSON = re.compile(r'\b(Kevin|Roy|Mica|Ericamae)\b')
REVIEW = re.compile(r'review|audit', re.I)

# Field and record separators for one `git log` call carrying subject, body and files.
REC, FLD, END = '\x1e', '\x1f', '\x1d'
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@')
BLAME_HEAD = re.compile(r'^([0-9a-f]{40}) \d+ \d+')


class GitError(Exception):
    pass


def git(repo, *args):
    r = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, errors='replace')
    if r.returncode != 0:
        raise GitError(f"git {' '.join(args[:2])} failed: {r.stderr.strip()}")
    return r.stdout


def fetch(repo):
    """Refresh origin/main. A failure (offline, no remote) is reported and the run goes on
    with the ref as it stands."""
    try:
        r = subprocess.run(['git', '-C', repo, 'fetch', 'origin', '-q'],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print(f"rework-rate: fetch failed, using {REF} as it stands", file=sys.stderr)
    except (OSError, subprocess.TimeoutExpired):
        print(f"rework-rate: fetch failed, using {REF} as it stands", file=sys.stderr)


def read_commits(repo, since, until, with_body):
    """Non-merge commits on origin/main with since <= commit time <= until (epoch seconds,
    until None = no upper bound), newest first, each with its changed files."""
    fmt = REC + FLD.join(['%h', '%ct', '%p', '%s'] + (['%b'] if with_body else [])) + END
    args = ['log', REF, '--no-merges', f'--since=@{since}', '--name-only', f'--format={fmt}']
    if until is not None:
        args.insert(3, f'--until=@{until}')
    commits = []
    for block in git(repo, *args).split(REC)[1:]:
        head, _, files = block.partition(END)
        fields = head.split(FLD)
        commits.append({
            'hash': fields[0],
            'time': int(fields[1]),
            'parents': fields[2].split(),
            'subject': fields[3],
            'body': fields[4] if with_body else '',
            'files': [f for f in files.splitlines() if f],
        })
    return commits


def area_of(files):
    kept = [f for f in files if not AREA_DROP.search(f)]
    front = any(FRONTEND.search(f) for f in kept)
    back = any(SCRIPTS.search(f) for f in kept)
    return 'both' if front and back else 'frontend' if front else 'scripts' if back else 'other'


def finder_of(subject, body):
    text = f'{subject}\n{body}'
    if ROBOT.search(text):
        return 'robot'
    if PERSON.search(text):
        return 'person'
    if REVIEW.search(text):
        return 'review'
    return 'unclear'


def rework_files(fix):
    return [f for f in fix['files'] if not REWORK_DROP.search(f)][:MAX_FILES]


def file_rework(fix, by_file):
    """The first earlier non-fix commit on a file this fix touched, or None."""
    files = rework_files(fix)
    earliest = fix['time'] - LOOKBACK_DAYS * 86400
    for path in files:
        for c in by_file.get(path, ()):
            if c['hash'] == fix['hash'] or AUTO_BUMP in c['subject'] or FIX.search(c['subject']):
                continue
            if earliest <= c['time'] <= fix['time']:
                return {'file': path, 'commit': c['hash'], 'subject': c['subject']}
    return None


def old_ranges(repo, fix):
    """{path: [(start, count)]} for the lines this fix removed or changed in its parent,
    in diff order, capped at MAX_RANGES in total. Returns (ranges, capped)."""
    files = rework_files(fix)
    if not files or not fix['parents']:
        return {}, False
    diff = git(repo, 'diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/',
               '--dst-prefix=b/', f"{fix['hash']}^", fix['hash'], '--', *files)
    ranges, total, path, in_header = collections.OrderedDict(), 0, None, False
    for line in diff.splitlines():
        if line.startswith('diff --git '):
            in_header, path = True, None
        elif in_header and line.startswith('--- '):
            old = line[4:].rstrip('\t')
            path = old[2:] if old.startswith('a/') else None
        elif line.startswith('@@'):
            in_header = False
            m = HUNK.match(line)
            count = int(m.group(2)) if m and m.group(2) is not None else 1
            if not m or not path or count == 0:
                continue
            total += 1
            if total <= MAX_RANGES:
                ranges.setdefault(path, []).append((int(m.group(1)), count))
    return ranges, total > MAX_RANGES


def blame_origins(repo, rev, path, ranges):
    """The commits that wrote the given line ranges of path at rev, each with its
    committer time and subject, read from `git blame --porcelain`."""
    args = ['blame', '-w', '--porcelain']
    for start, count in ranges:
        args += ['-L', f'{start},+{count}']
    info, current = {}, None
    for line in git(repo, *args, rev, '--', path).splitlines():
        m = BLAME_HEAD.match(line)
        if m:
            current = info.setdefault(m.group(1), {'sha': m.group(1), 'time': None, 'subject': ''})
        elif current is not None and line.startswith('committer-time '):
            current['time'] = int(line.split(' ', 1)[1])
        elif current is not None and line.startswith('summary '):
            current['subject'] = line.split(' ', 1)[1]
    return list(info.values())


def line_rework(repo, fix):
    """Blame the lines this fix changed. Returns the first origin that is a recent non-fix
    (line rework), the first that is a recent fix (fix of a fix), whether the range cap cut
    the check short, and any file that could not be blamed."""
    out = {'line_rework': None, 'fix_of_fix': None, 'blame_capped': False, 'blame_errors': []}
    try:
        ranges, out['blame_capped'] = old_ranges(repo, fix)
    except GitError as e:
        out['blame_errors'].append(f'diff: {e}')
        return out
    earliest = fix['time'] - LOOKBACK_DAYS * 86400
    for path, spans in ranges.items():
        try:
            origins = blame_origins(repo, f"{fix['hash']}^", path, spans)
        except GitError as e:
            out['blame_errors'].append(f'{path}: {e}')
            continue
        for o in origins:
            if o['time'] is None or AUTO_BUMP in o['subject'] or o['sha'].startswith(fix['hash']):
                continue
            if not earliest <= o['time'] <= fix['time']:
                continue
            key = 'fix_of_fix' if FIX.search(o['subject']) else 'line_rework'
            if out[key] is None:
                out[key] = {'file': path, 'commit': o['sha'][:8], 'subject': o['subject']}
        if out['line_rework'] and out['fix_of_fix']:
            break
    return out


def window(days, until):
    """(since, until) in epoch seconds. No --until: the last `days` days to now, exactly
    what git reads as --since="<days> days ago"."""
    if until:
        day = datetime.datetime.strptime(until, '%Y-%m-%d')
        end = int(day.replace(hour=23, minute=59, second=59).timestamp())
        return end - days * 86400, end
    return int(time.time()) - days * 86400, None


def measure(repo, days, until):
    since, end = window(days, until)
    changes = [c for c in read_commits(repo, since, end, with_body=True)
               if AUTO_BUMP not in c['subject']]
    if not changes:
        raise GitError(f"no changes on {REF} in the window: check the ref and the fetch")
    fixes = [c for c in changes if FIX.search(c['subject'])]

    pool_since = min((f['time'] for f in fixes), default=since) - LOOKBACK_DAYS * 86400
    by_file = collections.defaultdict(list)
    for c in read_commits(repo, pool_since, end, with_body=False):
        for path in c['files']:
            by_file[path].append(c)

    with concurrent.futures.ThreadPoolExecutor(BLAME_WORKERS) as pool:
        lines = list(pool.map(lambda f: line_rework(repo, f), fixes))

    rows = []
    for f, ln in zip(fixes, lines):
        rows.append({
            'hash': f['hash'],
            'date': datetime.datetime.fromtimestamp(f['time']).strftime('%Y-%m-%d'),
            'subject': f['subject'],
            'area': area_of(f['files']),
            'finder': finder_of(f['subject'], f['body']),
            **ln,
            'file_rework': file_rework(f, by_file),
        })

    fixed_files = collections.Counter(
        p for f in fixes for p in set(f['files']) if not TOP_DROP.search(p))
    top = sorted(fixed_files.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_N]

    return {
        'ref': REF,
        'days': days,
        'since': datetime.datetime.fromtimestamp(since).isoformat(timespec='minutes'),
        'until': datetime.datetime.fromtimestamp(end if end else time.time()).isoformat(timespec='minutes'),
        'changes': len(changes),
        'fixes': len(fixes),
        'area': {k: sum(r['area'] == k for r in rows) for k in ('scripts', 'frontend', 'both', 'other')},
        'line_rework': sum(r['line_rework'] is not None for r in rows),
        'fix_of_fix': sum(r['fix_of_fix'] is not None for r in rows),
        'file_rework': sum(r['file_rework'] is not None for r in rows),
        'blame_capped': sum(r['blame_capped'] for r in rows),
        'blame_errors': sum(len(r['blame_errors']) for r in rows),
        'finder': {k: sum(r['finder'] == k for r in rows) for k in ('person', 'robot', 'review', 'unclear')},
        'top_files': [{'path': p, 'fixes': n} for p, n in top],
        'fix_list': rows,
    }


def pct(part, whole):
    return f'{round(100 * part / whole)}%' if whole else '0%'


def render(m):
    a, f = m['area'], m['finder']
    lines = [
        f"Rework rate on {m['ref']}, {m['days']} days, {m['since']} to {m['until']}",
        f"Changes: {m['changes']} (auto-bump commits left out)",
        f"Fixes: {m['fixes']} ({pct(m['fixes'], m['changes'])} of changes)",
        f"Line rework: {m['line_rework']} of {m['fixes']} fixes changed lines a non-fix commit wrote "
        f"in the {LOOKBACK_DAYS} days before ({pct(m['line_rework'], m['fixes'])})",
        f"Fix of a fix: {m['fix_of_fix']} of {m['fixes']} (changed lines a fix wrote in the "
        f"{LOOKBACK_DAYS} days before)",
        f"File rework (blunt, file level): {m['file_rework']} of {m['fixes']} fixes touched a file a "
        f"non-fix commit changed in the {LOOKBACK_DAYS} days before ({pct(m['file_rework'], m['fixes'])})",
    ]
    if m['blame_capped']:
        n = m['blame_capped']
        lines.append(f"Blame cap hit on {n} fix{'es' if n != 1 else ''}: only the first {MAX_RANGES} "
                     "changed ranges of each were checked")
    if m['blame_errors']:
        lines.append(f"Could not blame {m['blame_errors']} files: see --json")
    lines += [
        f"Fix area: scripts {a['scripts']}, frontend {a['frontend']}, both {a['both']}, other {a['other']}",
        f"Found by: person {f['person']}, robot {f['robot']}, review {f['review']}, unclear {f['unclear']}",
        'Most-fixed files:',
    ]
    lines += [f"  {t['fixes']:>3}  {t['path']}" for t in m['top_files']]
    lines.append('Per-fix evidence: add --json')
    return '\n'.join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Rework rate over origin/main (read-only).')
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--until', help='end the window on this day (YYYY-MM-DD), 23:59:59 local')
    ap.add_argument('--json', action='store_true', help='print JSON with every fix and its evidence')
    ap.add_argument('--repo', default=os.path.dirname(os.path.dirname(os.path.realpath(__file__))),
                    help='repository to read (default: this repo)')
    args = ap.parse_args(argv)
    if args.days < 1:
        ap.error('--days must be 1 or more')
    if args.until:
        try:
            datetime.datetime.strptime(args.until, '%Y-%m-%d')
        except ValueError:
            ap.error('--until must be YYYY-MM-DD')

    fetch(args.repo)
    try:
        m = measure(args.repo, args.days, args.until)
    except GitError as e:
        print(f'rework-rate: {e}', file=sys.stderr)
        return 1
    print(json.dumps(m, indent=2) if args.json else render(m))
    return 0


if __name__ == '__main__':
    sys.exit(main())
