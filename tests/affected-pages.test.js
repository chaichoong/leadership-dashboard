// 29 Sep 2026: the merge gate (scripts/merge-pr.py) walks only the pages a PR
// can affect, by running scripts/prod-walk.js --only <ids>. The ids come from
// scripts/affected-pages.py. The two ways that goes wrong are both silent: a
// shared file read as one page walks too little, and an unreadable map read as
// "nothing affected" walks nothing and passes. Every case here drives the real
// script with python3, against the real maps or a fixture checkout (--root).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/affected-pages.py');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** Run the real script; returns { code, out } whatever the exit code. */
function run(argv, input) {
  try {
    const out = execFileSync('python3', [SCRIPT, ...argv], { cwd: ROOT, encoding: 'utf8', input, timeout: 20000 });
    return { code: 0, out: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, out: e.stdout ? JSON.parse(e.stdout) : null, err: String(e.stderr || '') };
  }
}
const why = (res, file) => (res.out.files.find(f => f.file === file) || {}).why;

describe('affected-pages.py against the real maps', () => {
  it('a mapped js/ file the app shell does not load walks its own page', () => {
    // index.html loads no js/growth-plan-model.js; only growth-plan.html does.
    expect(read('index.html')).not.toMatch(/src=["'][^"']*growth-plan-model\.js/);
    const res = run(['js/growth-plan-model.js']);
    expect(res.code).toBe(0);
    expect(res.out).toMatchObject({ scope: 'some', pages: ['growth-plan'] });
    expect(why(res, 'js/growth-plan-model.js')).toBe('mapped in FILE_TO_PAGE');
  });

  // 29 Sep 2026, caught in review: FILE_TO_PAGE says which page's version to
  // bump, not what a shell script can break. js/dashboard.js is mapped to
  // overview alone, yet it fills allTenancies, allCosts and allAccounts for
  // every tab, so its PR walked one page of 31.
  it('a mapped js/ file the app shell loads walks everything: shell globals reach every tab', () => {
    for (const f of ['js/dashboard.js', 'js/reconciliation.js', 'js/cashflow.js']) {
      const res = run([f]);
      expect(res.out, f).toMatchObject({ scope: 'all', pages: [] });
      expect(why(res, f), f).toBe('loaded by the app shell');
    }
  });

  it('js/agent-accuracy.js walks everything, because index.html loads it (line 906), not just overview, tasks and agents', () => {
    expect(read('index.html')).toMatch(/<script[^>]*src="js\/agent-accuracy\.js/);
    const res = run(['js/agent-accuracy.js']);
    expect(res.out).toMatchObject({ scope: 'all', pages: [] });
    expect(why(res, 'js/agent-accuracy.js')).toBe('loaded by the app shell');
  });

  it('a shared file walks everything, and says why', () => {
    for (const f of ['js/shared.js', 'js/config.js', 'index.html', 'css/styles.css', 'css/tokens.css']) {
      const res = run([f]);
      expect(res.out.scope, f).toBe('all');
      expect(res.out.pages, f).toEqual([]);
      expect(why(res, f), f).toBe('shared file');
    }
  });

  it('an SOP walks nothing: the walk never opens one', () => {
    for (const f of ['sop-cfvs.html', 'sop.html', 'os/tasks/sop.html']) {
      const res = run([f]);
      expect(res.out.scope, f).toBe('none');
      expect(why(res, f), f).toBe('SOP document, the walk never visits SOPs');
    }
  });

  it('scripts, tests and docs walk nothing', () => {
    const res = run(['scripts/agent-dispatch.py', 'tests/x.test.js', 'docs/incident-lessons.md', '.github/workflows/x.yml', 'workers/x/worker.js']);
    expect(res.out).toMatchObject({ scope: 'none', pages: [] });
    expect(res.out.files.every(f => f.why === 'not a page file')).toBe(true);
  });

  it('a front-end file no map knows walks everything: a gap costs time, never coverage', () => {
    const res = run(['js/zzz-unknown.js']);   // does not exist: classified by path, as a deleted file is
    expect(res.out.scope).toBe('all');
    expect(why(res, 'js/zzz-unknown.js')).toBe('front-end file not in any map, walking everything');
    expect(run(['os/zzz/new-page.html']).out.scope).toBe('all');
  });

  it('a .js file in any folder no rule names walks everything; build configs and non-page folders do not', () => {
    const res = run(['lib/zzz.js']);
    expect(res.out).toMatchObject({ scope: 'all', pages: [] });
    expect(why(res, 'lib/zzz.js')).toBe('front-end file not in any map, walking everything');
    for (const f of ['playwright.config.js', 'lib/vite.config.js', 'scripts/x.js', 'tests/x.js',
                     'workers/x/worker.js', 'cloudflare-worker/anthropic-proxy.js', 'docs/x.js',
                     'node_modules/x/index.js', '.claude/x.js']) {
      expect(run([f]).out.scope, f).toBe('none');
    }
  });

  it('a js/ file only standalone pages load walks those pages, resolved from each page\'s folder', () => {
    // js/kpi-sources.js is loaded by os/tasks/index.html as ../../js/kpi-sources.js.
    const res = run(['js/kpi-sources.js']);
    expect(res.out).toMatchObject({ scope: 'some', pages: ['tasks'] });
  });

  it('a mix of a mapped file and a script walks just the mapped page', () => {
    const res = run(['js/growth-plan-model.js', 'scripts/agent-dispatch.py']);
    expect(res.out).toMatchObject({ scope: 'some', pages: ['growth-plan'] });
    expect(res.out.files).toHaveLength(2);
  });

  it('one shared file in the mix walks everything', () => {
    expect(run(['js/growth-plan-model.js', 'js/shared.js']).out).toMatchObject({ scope: 'all', pages: [] });
  });

  it('reads newline-separated files from --stdin, skipping blank lines and repeats', () => {
    const res = run(['--stdin'], 'js/growth-plan-model.js\n\ncompliance.html\njs/growth-plan-model.js\nscripts/x.py\n');
    expect(res.code).toBe(0);
    expect(res.out).toMatchObject({ scope: 'some', pages: ['compliance', 'growth-plan'] });
    expect(res.out.files.map(f => f.file)).toEqual(['js/growth-plan-model.js', 'compliance.html', 'scripts/x.py']);
  });

  it('refuses to judge no files at all, rather than calling it "nothing affected"', () => {
    const res = run([]);
    expect(res.code).toBe(2);
    expect(res.out.scope).toBe('error');
    // merge-pr.py reports stderr on exit 2, so the reason must be there too.
    expect(res.err).toMatch(/cannot judge: no files given/);
    expect(run(['--stdin'], '\n\n').code).toBe(2);
  });
});

describe('affected-pages.py against a fixture checkout (--root)', () => {
  let dir;
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  const REGISTRY = `// ── header ──
    const BASE_ID = 'appX';
    // A mention in a comment is not the declaration: PAGE_REGISTRY = [ { id: 'ghost' } ];
    const PAGE_REGISTRY = [
        { id: 'alpha', name: 'Alpha', standalone: 'index.html#alpha', sopFile: 'sop-alpha.html' },
        // Kevin's page, with a brace { in the comment and a URL-looking // inside
        { id: 'beta',  name: "Beta's page", standalone: 'beta.html', sopFile: 'guides/beta.html' },
        /* { id: 'ghost', standalone: 'ghost.html' } */
        { id: 'gamma', name: 'Gamma', standalone: 'os/gamma/index.html#tab' },
        { id: 'ext',   name: 'Elsewhere', standalone: 'https://example.invalid/app/' },
    ];
    const LATER = { id: 'not-a-page', standalone: 'later.html' };
`;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'affected-pages-'));
    write('scripts/pre-commit-action.py',
      "FILE_TO_PAGE = {'js/alpha.js': 'alpha', 'js/both.js': ['gamma', 'alpha'], 'js/mapped-and-loaded.js': 'alpha'}\n");
    write('js/config.js', REGISTRY);
    write('index.html', '<script src="js/config.js?v=1"></script><script src="js/shell.js"></script>' +
      '<script src="js/alpha.js"></script><script src="https://cdn.example/x.js"></script>');
    write('beta.html', '<script src="js/only-beta.js?v=3"></script><script src="js/mapped-and-loaded.js"></script>');
    write('os/gamma/index.html', "<script src='../../js/only-beta.js'></script><script src=\"gamma.js\"></script>");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const at = (...files) => run(['--root', dir, ...files]);

  it('a standalone registry page not in FILE_TO_PAGE walks its own id', () => {
    const res = at('beta.html');
    expect(res.out).toMatchObject({ scope: 'some', pages: ['beta'] });
    expect(why(res, 'beta.html')).toBe('standalone page in PAGE_REGISTRY');
  });

  it('a js/ file loaded by standalone pages walks each of them, relative paths resolved', () => {
    expect(at('js/only-beta.js').out).toMatchObject({ scope: 'some', pages: ['beta', 'gamma'] });
  });

  it('a js/ file the app shell loads walks everything', () => {
    const res = at('js/shell.js');
    expect(res.out.scope).toBe('all');
    expect(why(res, 'js/shell.js')).toBe('loaded by the app shell');
  });

  it('a mapped js/ file walks its mapped pages AND the standalone pages that load it', () => {
    const res = at('js/mapped-and-loaded.js');
    expect(res.out).toMatchObject({ scope: 'some', pages: ['alpha', 'beta'] });
    expect(why(res, 'js/mapped-and-loaded.js')).toBe('mapped in FILE_TO_PAGE, plus the standalone registry pages that load it');
  });

  it('a mapped js/ file the shell loads walks everything: the shell outranks FILE_TO_PAGE', () => {
    const res = at('js/alpha.js');
    expect(res.out).toMatchObject({ scope: 'all', pages: [] });
    expect(why(res, 'js/alpha.js')).toBe('loaded by the app shell');
  });

  it('a list value in FILE_TO_PAGE walks every page in it', () => {
    expect(at('js/both.js').out).toMatchObject({ scope: 'some', pages: ['alpha', 'gamma'] });
  });

  it('comments can neither hide an entry nor invent one', () => {
    expect(at('ghost.html').out.scope).toBe('all');                 // not a registry page: unknown front-end
    expect(why(at('ghost.html'), 'ghost.html')).toBe('front-end file not in any map, walking everything');
    expect(at('later.html').out.scope).toBe('all');                 // an object after the registry is not an entry
    expect(at('guides/beta.html').out.scope).toBe('none');          // a registry sopFile is an SOP
  });

  it('exits 2 when the registry parses to zero entries: empty must never read as "nothing affected"', () => {
    write('js/config.js', 'const PAGE_REGISTRY = [\n  // every page removed\n];\n');
    try {
      const res = at('scripts/x.py');
      expect(res.code).toBe(2);
      expect(res.out).toMatchObject({ scope: 'error', pages: [] });
      expect(res.out.error).toMatch(/zero entries/);
    } finally {
      write('js/config.js', REGISTRY);
    }
  });

  it('exits 2 when a map is missing, never guessing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'affected-pages-empty-'));
    try {
      const res = run(['--root', empty, 'js/growth-plan-model.js']);
      expect(res.code).toBe(2);
      expect(res.out.error).toMatch(/pre-commit-action\.py not found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
