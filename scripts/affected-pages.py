#!/usr/bin/env python3
"""
affected-pages.py: which PAGE_REGISTRY pages a set of changed files can affect.

WHY THIS EXISTS (29 Sep 2026)
-----------------------------
The merge gate (scripts/merge-pr.py) serves the merged code locally and runs
scripts/prod-walk.js --only <ids> against it, so a PR is walked on the pages it
touches instead of all of them. This script turns the PR's changed files into
those ids. A gap here costs time, never coverage: a front-end file no map
knows about means "walk everything", and an unreadable map means "cannot
judge" (exit 2), never "nothing affected".

Rules, per file, first match wins:
  1. js/config.js, js/shared.js, index.html, css/**       -> all (shared file)
  2. any script index.html loads by <script src>          -> all (app shell), whatever
     FILE_TO_PAGE says: script globals are shared across the shell, so a shell
     file can break any tab (js/dashboard.js fills allTenancies, allCosts and
     allAccounts for every tab)
  3. FILE_TO_PAGE in scripts/pre-commit-action.py        -> those ids, and for a
     js/ file also every standalone registry page that loads it by <script src>
  4. an .html file that is a PAGE_REGISTRY standalone      -> that id
  5. a js/ file loaded only by standalone registry pages  -> those ids
  6. sop*.html, or a PAGE_REGISTRY sopFile               -> none (the walk never visits SOPs)
  7. any other front-end file                             -> all
     (anything in js/ or css/; .html and .css outside the non-page folders; a
     .js file anywhere that is not a *.config.js and not under scripts/,
     tests/, workers/, cloudflare-worker/, docs/, node_modules/ or .claude/)
  8. everything else (scripts/, tests/, docs/, .claude/,
     .github/, workers/, *.md, *.py, *.sh, *.json ...)     -> none
A file that no longer exists (deleted in the PR) is classified by its path.

Usage:  python3 scripts/affected-pages.py FILE...
        git diff --name-only A...B | python3 scripts/affected-pages.py --stdin
        --root DIR reads the maps from another checkout (default: this repo).
Prints: {"scope": "none"|"some"|"all", "pages": [ids], "files": [{"file", "pages", "why"}]}
        pages is empty when scope is all or none.
Exit:   0 judged; 2 cannot judge (a map unreadable, an empty registry, no files).
Guarded by tests/affected-pages.test.js.
"""

import importlib.util
import json
import os
import posixpath
import re
import sys

HERE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SHARED_FILES = {'js/config.js', 'js/shared.js', 'index.html'}
# Folders that hold no page the walk visits, for .html and .css. Checked before
# rule 7 so a fixture page under tests/ is not mistaken for a front-end file.
NON_PAGE_DIRS = ('scripts/', 'tests/', 'docs/', '.claude/', '.github/', 'workers/',
                 'cloudflare-worker/', 'node_modules/')
# A .js file is front-end unless it sits in one of these (29 Sep 2026: lib/x.js
# walked nothing before; a gap costs time, never coverage).
# cloudflare-worker/ and docs/ added 29 Sep 2026: a Worker and a docs script are never
# loaded by a registry page, so a change there has no page to walk.
JS_NON_PAGE_DIRS = ('scripts/', 'tests/', 'workers/', 'cloudflare-worker/', 'docs/',
                    'node_modules/', '.claude/')
# Build and test configs (playwright.config.js, vitest.config.js): never loaded by a page.
CONFIG_JS_RE = re.compile(r'\.config\.(js|cjs|mjs)$')
SCRIPT_SRC_RE = re.compile(r'<script\b[^>]*?\bsrc\s*=\s*(["\'])(.*?)\1', re.I | re.S)


class MapError(Exception):
    """A map could not be read; the caller must treat the answer as unknown."""


def strip_js_comments(src):
    """Drop // and /* */ comments, leaving strings (and the // inside a URL
    string) alone, so a comment can never hide or invent a registry entry."""
    out, i, n, quote = [], 0, len(src), None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ('"', "'", '`'):
            quote = c
            out.append(c)
            i += 1
            continue
        if src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def _matching(text, start, open_ch, close_ch):
    """Index of the bracket closing text[start] (comments already stripped)."""
    depth, i, quote = 0, start, None
    while i < len(text):
        c = text[i]
        if quote:
            if c == '\\':
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in ('"', "'", '`'):
            quote = c
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _field(block, name):
    m = re.search(r'\b' + name + r'\s*:\s*(["\'`])(.*?)\1', block, re.S)
    return m.group(2) if m else None


def parse_registry(config_src):
    """[{id, standalone}] for every PAGE_REGISTRY entry in js/config.js."""
    # The declaration itself, never a mention in a comment. Comments are stripped
    # from there on, so nothing earlier in the file can upset the quote tracking.
    decl = re.search(r'^[ \t]*(?:const|let|var)\s+PAGE_REGISTRY\s*=\s*\[', config_src, re.M)
    if not decl:
        raise MapError('PAGE_REGISTRY declaration not found in js/config.js')
    src = strip_js_comments(config_src[decl.start():])
    m = re.search(r'\bPAGE_REGISTRY\s*=\s*\[', src)
    if not m:
        raise MapError('PAGE_REGISTRY not found in js/config.js')
    start = m.end() - 1
    end = _matching(src, start, '[', ']')
    if end < 0:
        raise MapError('PAGE_REGISTRY array never closes in js/config.js')
    body = src[start + 1:end]
    entries, i = [], 0
    while True:
        j = body.find('{', i)
        if j < 0:
            break
        k = _matching(body, j, '{', '}')
        if k < 0:
            raise MapError('a PAGE_REGISTRY entry never closes in js/config.js')
        block = body[j:k + 1]
        pid = _field(block, 'id')
        if not pid:
            raise MapError('a PAGE_REGISTRY entry has no readable id: ' + block[:80].replace('\n', ' '))
        entries.append({'id': pid, 'standalone': _field(block, 'standalone') or '',
                        'sopFile': _field(block, 'sopFile') or ''})
        i = k + 1
    if not entries:
        # An empty registry must never read as "nothing affected".
        raise MapError('PAGE_REGISTRY parsed to zero entries')
    return entries


def load_file_to_page(root):
    path = os.path.join(root, 'scripts', 'pre-commit-action.py')
    if not os.path.isfile(path):
        raise MapError('scripts/pre-commit-action.py not found')
    spec = importlib.util.spec_from_file_location('pre_commit_action_for_affected_pages', path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # a broken map is "cannot judge", never "nothing"
        raise MapError('scripts/pre-commit-action.py would not load: %s' % e)
    ftp = getattr(mod, 'FILE_TO_PAGE', None)
    if not isinstance(ftp, dict) or not ftp:
        raise MapError('FILE_TO_PAGE missing or empty in scripts/pre-commit-action.py')
    return {k: ([v] if isinstance(v, str) else list(v)) for k, v in ftp.items()}


def local_page(standalone):
    """The repo path of a standalone page, or '' for an outside URL."""
    s = (standalone or '').split('#')[0].split('?')[0].strip()
    if not s or re.match(r'^[a-z][a-z0-9+.-]*:', s, re.I) or s.startswith('//'):
        return ''
    return posixpath.normpath(s.lstrip('/'))


def scripts_of(root, page):
    """Repo paths of every local <script src> in a page, resolved from its folder."""
    with open(os.path.join(root, page), encoding='utf-8', errors='replace') as fh:
        html = fh.read()
    out = set()
    for _, src in SCRIPT_SRC_RE.findall(html):
        s = src.split('#')[0].split('?')[0].strip()
        if not s or re.match(r'^[a-z][a-z0-9+.-]*:', s, re.I) or s.startswith('//'):
            continue
        path = s.lstrip('/') if s.startswith('/') else posixpath.join(posixpath.dirname(page), s)
        out.add(posixpath.normpath(path))
    return out


def load_maps(root):
    ftp = load_file_to_page(root)
    try:
        with open(os.path.join(root, 'js', 'config.js'), encoding='utf-8') as fh:
            registry = parse_registry(fh.read())
    except OSError as e:
        raise MapError('js/config.js unreadable: %s' % e)
    standalone, sops = {}, set()
    for e in registry:
        p = local_page(e['standalone'])
        if p and p.endswith('.html'):
            standalone.setdefault(p, []).append(e['id'])
        s = local_page(e['sopFile'])
        if s:
            sops.add(s)
    try:
        shell = scripts_of(root, 'index.html')
    except OSError as e:
        raise MapError('index.html unreadable: %s' % e)
    if not shell:
        raise MapError('index.html loads no local scripts: the shell map is unreadable')
    loaders = {}
    for page, ids in standalone.items():
        if page == 'index.html' or not os.path.isfile(os.path.join(root, page)):
            continue  # the shell is its own rule; a missing page loads nothing
        for js in scripts_of(root, page):
            loaders.setdefault(js, set()).update(ids)
    return {'ftp': ftp, 'standalone': standalone, 'shell': shell, 'loaders': loaders, 'sops': sops}


def normalise(path, root):
    p = str(path).strip().replace('\\', '/')
    if os.path.isabs(p):
        rel = os.path.relpath(p, root).replace('\\', '/')
        if not rel.startswith('../'):
            p = rel
    while p.startswith('./'):
        p = p[2:]
    return posixpath.normpath(p) if p else p


def is_front_end(f):
    ext = posixpath.splitext(f)[1].lower()
    if f.startswith(('js/', 'css/')):
        return True
    if ext == '.js':
        return not f.startswith(JS_NON_PAGE_DIRS) and not CONFIG_JS_RE.search(posixpath.basename(f))
    if f.startswith(NON_PAGE_DIRS):
        return False
    if ext in ('.html', '.htm', '.css'):
        return True
    if ext in ('.mjs', '.cjs'):
        return (f.startswith(('os/', 'property-manager/')) or '/' not in f) and not CONFIG_JS_RE.search(f)
    return False


def classify(f, maps):
    """(pages, why): pages is a sorted id list, 'all', or []."""
    if f in SHARED_FILES or f.startswith('css/'):
        return 'all', 'shared file'
    # Ahead of FILE_TO_PAGE on purpose: that map says which page's version to
    # bump, not what a shell script can break. js/dashboard.js is mapped to
    # overview but fills the data every tab reads.
    if f in maps['shell']:
        return 'all', 'loaded by the app shell'
    if f in maps['ftp']:
        ids = set(maps['ftp'][f])
        # Nor is it a map of who loads the file, so a js/ file also walks every
        # standalone registry page that loads it.
        extra = maps['loaders'].get(f, set()) if f.startswith('js/') and f.endswith('.js') else set()
        if extra - ids:
            return sorted(ids | extra), 'mapped in FILE_TO_PAGE, plus the standalone registry pages that load it'
        return sorted(ids), 'mapped in FILE_TO_PAGE'
    if f in maps['standalone']:
        return sorted(set(maps['standalone'][f])), 'standalone page in PAGE_REGISTRY'
    if f.startswith('js/') and f.endswith('.js') and f in maps['loaders']:
        return sorted(maps['loaders'][f]), 'loaded by <script src> in its standalone registry pages'
    # sop*.html, plus the SOPs the registry names elsewhere (inbound-comms-sop.html,
    # guides/*.html): the walk opens no SOP, so walking every page for one checks nothing.
    if re.match(r'^sop[^/]*\.html?$', posixpath.basename(f), re.I) or f in maps['sops']:
        return [], 'SOP document, the walk never visits SOPs'
    if is_front_end(f):
        return 'all', 'front-end file not in any map, walking everything'
    return [], 'not a page file'


def judge(files, maps, root):
    seen, rows = set(), []
    for raw in files:
        f = normalise(raw, root)
        if not f or f in seen:
            continue
        seen.add(f)
        pages, why = classify(f, maps)
        rows.append({'file': f, 'pages': pages, 'why': why})
    if any(r['pages'] == 'all' for r in rows):
        scope, ids = 'all', []
    else:
        ids = sorted({i for r in rows for i in r['pages']})
        scope = 'some' if ids else 'none'
    return {'scope': scope, 'pages': ids, 'files': rows}


def fail(reason):
    # The JSON for a reader of stdout, the reason on stderr for a caller that
    # only reports stderr on exit 2 (scripts/merge-pr.py does).
    print(json.dumps({'scope': 'error', 'pages': [], 'files': [], 'error': reason}, indent=2))
    sys.stderr.write('affected-pages: cannot judge: %s\n' % reason)
    return 2


def main(argv):
    root, files, use_stdin, i = HERE_ROOT, [], False, 0
    while i < len(argv):
        a = argv[i]
        if a == '--stdin':
            use_stdin = True
        elif a == '--root':
            i += 1
            if i >= len(argv):
                return fail('--root needs a folder')
            root = os.path.abspath(argv[i])
        elif a in ('-h', '--help'):
            print(__doc__)
            return 0
        else:
            files.append(a)
        i += 1
    if use_stdin:
        files += [l for l in sys.stdin.read().splitlines() if l.strip()]
    if not files:
        # No files is not "nothing affected": the caller's diff failed or was empty.
        return fail('no files given: nothing to judge (pass FILE... or --stdin)')
    try:
        maps = load_maps(root)
    except MapError as e:
        return fail(str(e))
    print(json.dumps(judge(files, maps, root), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
