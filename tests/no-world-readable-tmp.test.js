// Nothing in scripts/ writes working content to the shared temp directory.
//
// Finding 20260828-agent-slot-run-391 (approved build rec4XX7XgT3xZIQUk). /tmp on
// this Mac is drwxrwxrwt: world-readable and world-listable. Agent runs handle
// tenant records, creditor correspondence and material from Kevin's private legal
// matter, and files written there landed -rw-r--r--, readable by anything running
// on the machine. Four one-off scripts had already done it, and post-mail-send.sh
// — the script that emails Kevin his scanned legal and creditor post — captured
// osascript's stderr to one fixed world-readable path on every attempt.
//
// The rule now has teeth in two places, and this test holds both:
//   1. No script writes to a hard-coded /tmp (or /private/tmp) path. Everything
//      uses $TMPDIR / tempfile.gettempdir(), the per-user 0700 directory, or a
//      private directory under the user's own home.
//   2. scripts/agent-settings.json DENIES Write and Edit into those directories,
//      so an agent that ignores the prose instruction is refused by the harness.
//
// A test-only literal (a fake path inside a selftest assertion) is not a write and
// is not matched: the patterns below look for writes, not for the characters.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SCRIPTS = resolve(__dirname, '../scripts');
const SETTINGS = join(SCRIPTS, 'agent-settings.json');
const EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|applescript|scpt)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

// Write-shaped uses of the shared temp directory. Each one puts bytes there.
const WRITES = [
  { why: 'shell redirect into the shared temp directory', re: />>?\s*["']?\/(private\/)?tmp\// },
  { why: 'mktemp rooted in the shared temp directory', re: /mktemp[^\n]*?\s["']?\/(private\/)?tmp\// },
  { why: 'open() on a hard-coded shared temp path', re: /\bopen\(\s*(f?["'])\/(private\/)?tmp\// },
  { why: 'image or file write to a hard-coded shared temp path', re: /\b(imwrite|savefig|to_csv|write_text|copyfile|copy2|rename)\(\s*(f?["'])\/(private\/)?tmp\// },
  { why: 'a variable assigned a hard-coded shared temp path', re: /(?<![=!<>])=\s*(f?["'])\/(private\/)?tmp\// },
  { why: 'tee into the shared temp directory', re: /\btee\s+-?a?\s*["']?\/(private\/)?tmp\// },
];

describe('no script writes working content to the shared temp directory', () => {
  const files = walk(SCRIPTS);

  it('finds the scripts to check (control: the scan is not empty)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no write-shaped /tmp path anywhere in scripts/', () => {
    const hits = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(#|\/\/|--)/.test(line)) return; // a comment is prose, not a write
        for (const { why, re } of WRITES) {
          if (re.test(line)) hits.push(`${relative(SCRIPTS, f)}:${i + 1} ${why}\n    ${line.trim().slice(0, 160)}`);
        }
      });
    }
    expect(hits, `write to a world-readable temp path:\n${hits.join('\n')}`).toEqual([]);
  });

  it('the four one-off scripts that did this are gone', () => {
    const gone = ['_imsg_step2b.py', '_stranded_batch_31aug.py', '_stranded_dedupe.py', '_fix_fylde_task.py'];
    const names = new Set(files.map((f) => relative(SCRIPTS, f)));
    for (const g of gone) expect(names.has(g), `${g} is back in scripts/`).toBe(false);
  });
});

describe('agent-settings.json refuses a write into the shared temp directory', () => {
  const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  const deny = settings.permissions.deny;

  it('denies Write and Edit into /tmp and /private/tmp', () => {
    for (const rule of ['Write(/tmp/**)', 'Write(/private/tmp/**)', 'Edit(/tmp/**)', 'Edit(/private/tmp/**)']) {
      expect(deny, `${rule} missing from the deny list`).toContain(rule);
    }
  });

  it('denies a shell redirect into /tmp and /private/tmp', () => {
    for (const rule of ['Bash(*>/tmp/*)', 'Bash(*> /tmp/*)', 'Bash(*>/private/tmp/*)', 'Bash(*> /private/tmp/*)']) {
      expect(deny, `${rule} missing from the deny list`).toContain(rule);
    }
  });
});
