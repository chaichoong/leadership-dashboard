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

# Map of source files → PAGE_REGISTRY id
FILE_TO_PAGE = {
    'js/dashboard.js':      'overview',
    'js/cfv.js':            'cfv',
    'js/invoices.js':       'invoices',
    'js/pnl.js':            'pnl',
    'js/fintable.js':       'fintable',
    'js/sitemap.js':        'sitemap',
    'follow-up.html':       'comms',
    'compliance.html':      'compliance',
    'os/tasks/index.html':  'tasks',
    'os/index.html':        'os-hub',
    'os/business-plan-builder/index.html': 'os-bplan',
    'os/strategy/index.html': 'os-strategy',
    'os/strategy/strategy.js': 'os-strategy',
    'os/strategy/strategy.css': 'os-strategy',
}

CONFIG_FILE = 'js/config.js'


def get_changed_files():
    """Get changed files from environment (GitHub Action) or git staging (local hook)."""
    env_files = os.environ.get('CHANGED_FILES', '').strip()
    if env_files:
        return env_files.split()

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
            pages_to_bump.add(FILE_TO_PAGE[f])

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
        # If running as local hook, re-stage config.js
        if not os.environ.get('CHANGED_FILES'):
            subprocess.run(['git', 'add', CONFIG_FILE])

    return 0


if __name__ == '__main__':
    sys.exit(main())
