#!/usr/bin/env python3
"""
GitHub Action script: auto-bumps pageVer in js/config.js PAGE_REGISTRY
when source files for a page are modified in a push.

Used by .github/workflows/auto-bump-pagever.yml
Also usable as a local pre-commit hook (falls back to git staged files).
"""

import os
import re
import subprocess
import sys

# Map of source files → PAGE_REGISTRY id.
# Keep in sync with the `paths:` filter in
# .github/workflows/auto-bump-pagever.yml — both should list the same
# files. Removed entries: os/index.html (Operating Systems Hub deleted),
# os/launch-plan.html (Launch Plan deleted, duplicated Strategy OS).
FILE_TO_PAGE = {
    'js/dashboard.js':      'overview',
    'js/cfv.js':            'cfv',
    'js/income.js':         'income',
    'js/costs.js':          'costs',
    'js/ar-variable.js':    'ar-variable',
    'js/invoices.js':       'invoices',
    'js/pnl.js':            'pnl',
    'js/fintable.js':       'fintable',
    'js/prospecting.js':    'prospecting',
    'js/sitemap.js':        'sitemap',
    'follow-up.html':       'comms',
    'compliance.html':      'compliance',
    'os/tasks/index.html':  'tasks',
    # Agent accuracy scoring is shared by the Task OS (AI Agents tab) and the
    # Leadership Dashboard (Agent Approvals card), so a change bumps both.
    'js/agent-accuracy.js': ['tasks', 'overview'],
    'js/kpi-library.js': 'kpi-library',
    'os/strategy/index.html': 'os-strategy',
    'os/strategy/strategy.js': 'os-strategy',
    'os/strategy/strategy.css': 'os-strategy',
    'os/operations/index.html': 'operations',
    'js/skills.js':             'skills',
    'js/skills-data.js':        'skills',
    'os/systemisation/index.html': 'systemisation',
    'os/team/index.html':          'os-team',
    'how-it-works.html':           'how-it-works',
    # Previously-unmapped registered pages (their versions never bumped)
    'js/money.js':          'money',
    'js/wealth.js':         'wealth',
    'js/wealth-ratios.js':  'wealth',
    'js/transactions.js':   'transactions',
    'js/coa.js':            'coa',
    'ai-brain.html':        'ai-brain',
    'js/ceo-brief.js':      'ceo-brief',
    # Supporting files that ship page behaviour but had no mapping
    'js/cashflow.js':       'overview',
    'js/arrears.js':        'cfv',
    'js/reconciliation.js': 'overview',
    # CRM ships as a Supabase-only page. Unmapped until 2026-08-01, so its
    # pageVer sat at 1.0 while the file changed — and every staleness signal
    # built on pageVer quietly read CRM as up to date.
    #
    # That 1 Aug fix did not work. Mapping a file here is only half of it: the
    # `paths:` filter in .github/workflows/auto-bump-pagever.yml decides whether the
    # workflow runs at all, and crm-supabase.html was never added there. So the CRM
    # page took a 14-step interactive walkthrough on 2026-08-04 (319b438) and pageVer
    # still read 1.0 two days later. Both lists, every time — enforced by
    # tests/constant-drift.test.js.
    'crm-supabase.html':    'crm',
    'js/crm-walkthrough.js': 'crm',
}

# DELIBERATELY UNMAPPED: 'content-machine' is registered as a page but its source
# lives in the separate chaichoong/content-machine repo, so no file in THIS repo
# can bump it. Its pageVer moves by hand. Do not "fix" this by inventing a path.

CONFIG_FILE = 'js/config.js'


def get_changed_files():
    """Get changed files.

    Modes:
    1. GitHub Action push event — diff GITHUB_BEFORE_SHA..HEAD.
       (Set fetch-depth: 0 on the checkout so full history is present.)
    2. Legacy CHANGED_FILES env — kept for back-compat but unreliable because
       GitHub's join() on commits.*.modified produces JSON-literal tokens
       like ["js/foo.js","js/bar.js"] instead of bare filenames.
       We parse those tokens here so existing runs don't silently no-op.
    3. Local pre-commit hook — diff staged files.
    """
    before_sha = os.environ.get('GITHUB_BEFORE_SHA', '').strip()
    if before_sha and before_sha != '0000000000000000000000000000000000000000':
        result = subprocess.run(
            ['git', 'diff', '--name-only', f'{before_sha}..HEAD'],
            capture_output=True, text=True
        )
        files = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        print(f"📂 {len(files)} files changed since {before_sha[:7]}:")
        for f in files:
            print(f"   - {f}")
        return files

    env_files = os.environ.get('CHANGED_FILES', '').strip()
    if env_files:
        # Strip JSON-literal noise: [ ] " , and split on whitespace/commas.
        cleaned = re.sub(r'[\[\]"]', '', env_files).replace(',', ' ')
        return [tok for tok in cleaned.split() if tok]

    # Fallback: local pre-commit hook mode
    result = subprocess.run(
        ['git', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'],
        capture_output=True, text=True
    )
    return result.stdout.strip().split('\n') if result.stdout.strip() else []


def bump_version(ver_str):
    """Bump patch version: '1.4' → '1.5', '2.0' → '2.1'"""
    parts = ver_str.split('.')
    if len(parts) == 2:
        return f"{parts[0]}.{int(parts[1]) + 1}"
    return ver_str


def main():
    changed = get_changed_files()

    # Find which pages need a version bump
    pages_to_bump = set()
    for f in changed:
        if f in FILE_TO_PAGE:
            # A value may be a single page or a list — a shared module (e.g.
            # js/agent-accuracy.js) feeds more than one page, and a set.add()
            # on a list would raise "unhashable type" and kill the whole hook.
            target = FILE_TO_PAGE[f]
            pages_to_bump.update(target if isinstance(target, list) else [target])

    if not pages_to_bump:
        print("No page files changed — nothing to bump.")
        return 0

    try:
        with open(CONFIG_FILE, 'r') as f:
            content = f.read()
    except FileNotFoundError:
        print(f"Config file {CONFIG_FILE} not found — skipping.")
        return 0

    modified = False
    for page_id in sorted(pages_to_bump):
        pattern = re.compile(
            r"(id:\s*'" + re.escape(page_id) + r"'[^}]*?pageVer:\s*')(\d+\.\d+)(')"
        )
        match = pattern.search(content)
        if match:
            old_ver = match.group(2)
            new_ver = bump_version(old_ver)
            if old_ver != new_ver:
                content = content[:match.start(2)] + new_ver + content[match.end(2):]
                modified = True
                print(f"  📦 Auto-bump: {page_id} pageVer {old_ver} → {new_ver}")

    if modified:
        with open(CONFIG_FILE, 'w') as f:
            f.write(content)
        # If running as a local pre-commit hook, re-stage config.js so the
        # bump goes into the same commit. In CI we let the workflow's
        # "Commit and push if changed" step handle it.
        in_ci = bool(os.environ.get('GITHUB_BEFORE_SHA') or os.environ.get('CHANGED_FILES') or os.environ.get('GITHUB_ACTIONS'))
        if not in_ci:
            subprocess.run(['git', 'add', CONFIG_FILE])

    return 0


if __name__ == '__main__':
    sys.exit(main())
