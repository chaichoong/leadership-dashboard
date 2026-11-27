import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// 27 Nov 2026. The AI Brain page's "Needs your call" box shows a sensitive item
// with a View button. The nightly publisher (~/knowledge-os/publish_brain_today.py,
// outside git) pointed that button at constraints-and-red-lines.md for EVERY
// escalation, whatever the daily review was about. That day the review escalated
// a reply and linked the note holding its facts, and View still opened the
// red-lines file.
//
// The fix: each escalated line points at the note it links; a person's note is
// skipped; a line with no note of its own points at the daily note itself.
// These tests drive the REAL publisher against a throwaway vault with invented
// notes, in the style of tests/brain-vault-twins.test.js.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = join(homedir(), 'knowledge-os', 'publish_brain_today.py');

const BOX = mkdtempSync(join(tmpdir(), 'brain-sensitive-'));
afterAll(() => rmSync(BOX, { recursive: true, force: true }));
let n = 0;

const MATTER = '2031-03-13 Supplier dispute, the facts for the reply';
const CONTRACT = '2031-03-12 Contract note';
const NOTES = [
  `Decisions/${MATTER}.md`,
  `Knowledge/${CONTRACT}.md`,
  'People/Sam Example.md',
  'Knowledge/Unit 4 Example Road.md',
  'constraints-and-red-lines.md',
];

function vault(daily, extra = {}) {
  const root = join(BOX, String(++n));
  const put = (rel, body = '# note\nFirst real line.\n') => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put('_system/brain-questions.md', '# Brain questions\n');
  for (const f of NOTES) put(f);
  for (const [f, body] of Object.entries(extra)) put(f, body || '# note\n');
  put('Daily/2031-03-13.md', '# 13 Mar\n- Quiet day.\n');
  put('Daily/2031-03-14.md', daily);
  return root;
}

// What the publisher would put in the sensitive rows, plus the names it hands
// the Drive resolver. The link cache is faked so no real Drive id is read.
function pointers(daily, extra) {
  const root = vault(daily, extra);
  const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('pbt', ${JSON.stringify(PUBLISH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.VAULT = ${JSON.stringify(root)}
m._ID_CACHE = {${JSON.stringify(MATTER)}: 'https://drive.google.com/file/d/MATTER/view'}
s = m.sensitive_flag()
names = m.resolver_names({'captured': [], 'questions': [], 'sensitive': s, 'index': []})
print(json.dumps({'docs': [x['docName'] for x in s], 'links': [x['docLink'] for x in s], 'names': names}))
`;
  return JSON.parse(execFileSync('python3', ['-c', py],
    { encoding: 'utf8', env: { ...process.env, OD_REPO: ROOT, PYTHONDONTWRITEBYTECODE: '1' } }));
}

beforeAll(() => {
  if (!existsSync(PUBLISH)) throw new Error(`missing ${PUBLISH}: this test checks the live brain publisher`);
});

describe('the sensitive View button points at the note the review escalated', () => {
  it('BACK-TEST: an escalated line opens the note it links, not the red-lines file', () => {
    const r = pointers(`# 14 Mar\n- Supplier reply due today. See [[${MATTER}]]. ESCALATE TO KEVIN.\n`);
    expect(r.docs).toEqual([`${MATTER}.md`]);
    expect(r.links).toEqual(['https://drive.google.com/file/d/MATTER/view']);
    expect(r.docs).not.toContain('constraints-and-red-lines.md');
  });

  it('a heading block escalates every line under it, skips people, and stops at the next heading', () => {
    const r = pointers([
      '# 14 Mar',
      '### ESCALATE TO KEVIN',
      `- Agreement signed in [[Sam Example]]'s name ([[${CONTRACT}|the contract]]).`,
      `- Same matter again: [[${CONTRACT}#Terms]].`,
      '### Deadlines',
      '- 15 Mar: [[Unit 4 Example Road]] gas booking.',
      '',
    ].join('\n'));
    expect(r.docs).toEqual([`${CONTRACT}.md`]);
  });

  it('a line with no note of its own points at the daily note, once', () => {
    const r = pointers([
      '# 14 Mar',
      `- Supplier reply due today. See [[${MATTER}]]. ESCALATE TO KEVIN.`,
      '- A private matter needs a read today. ESCALATE TO KEVIN (private matter).',
      '- Still open: the supplier reply (ESCALATE TO KEVIN).',
      '- Only a person here: [[Sam Example]]. ESCALATE TO KEVIN.',
      '',
    ].join('\n'));
    expect(r.docs).toEqual([`${MATTER}.md`, '2031-03-14.md']);
  });

  it('a link to a note that does not exist falls back to the daily note', () => {
    const r = pointers('# 14 Mar\n- See [[A note nobody wrote]]. ESCALATE TO KEVIN.\n');
    expect(r.docs).toEqual(['2031-03-14.md']);
  });

  it('the Drive resolver is asked for the bare name, so a daily note gets an exact link', () => {
    const r = pointers('# 14 Mar\n- A private matter. ESCALATE TO KEVIN.\n');
    expect(r.names).toEqual(['2031-03-14']);
  });

  it('a link in the escalating heading itself counts', () => {
    const r = pointers(`# 14 Mar\n### ESCALATE TO KEVIN: [[${MATTER}]]\n### Deadlines\n- None.\n`);
    expect(r.docs).toEqual([`${MATTER}.md`]);
  });

  it('an escalating heading with nothing linked still shows the daily note', () => {
    const r = pointers('# 14 Mar\n### ESCALATE TO KEVIN\n### Deadlines\n- None.\n');
    expect(r.docs).toEqual(['2031-03-14.md']);
  });

  it('a bold label escalates the lines under it, down to a blank line', () => {
    const r = pointers(`# 14 Mar\n**Escalate to Kevin:**\n- [[${MATTER}]]\n\n- Gas booking at [[Unit 4 Example Road]].\n`);
    expect(r.docs).toEqual([`${MATTER}.md`]);
  });

  it('intro lines, sub-bullets and rules under a linked item add no extra row', () => {
    const r = pointers([
      '# 14 Mar',
      '### ESCALATE TO KEVIN',
      '- These need your call:',
      `- Supplier reply due today. See [[${MATTER}]].`,
      '  - Ten of the answers need your words.',
      '---',
      '### Deadlines',
      '',
    ].join('\n'));
    expect(r.docs).toEqual([`${MATTER}.md`]);
  });

  it('links resolve whatever their case, with dots in the name, or inside a table', () => {
    const DOTTED = 'Estate v1.2 plan';
    const root = pointers([
      '# 14 Mar',
      '### ESCALATE TO KEVIN',
      `- See [[${MATTER.toLowerCase()}]].`,
      `| matter | [[${CONTRACT}\\|the contract]] |`,
      `- See [[${DOTTED}]] and [[Legal MOC]].`,
      '',
    ].join('\n'), { [`Knowledge/${DOTTED}.md`]: '', 'Knowledge/Estate v1.md': '', 'Maps of Content/Legal MOC.md': '' });
    expect(root.docs).toEqual([`${MATTER}.md`, `${CONTRACT}.md`, `${DOTTED}.md`]);
    expect(root.names).toContain(DOTTED);
  });

  it('a sub-bullet under a flagged line, outside any heading, joins that line', () => {
    const r = pointers(`# 14 Mar\n- Supplier reply. ESCALATE TO KEVIN.\n  - See [[${MATTER}]].\n- Filed [[${CONTRACT}]].\n`);
    expect(r.docs).toEqual([`${MATTER}.md`]);
  });

  it('a blank line straight after a bold label does not end its list', () => {
    const r = pointers(`# 14 Mar\n**Escalate to Kevin:**\n\n- [[${MATTER}]]\n\n- Filed [[${CONTRACT}]].\n`);
    expect(r.docs).toEqual([`${MATTER}.md`]);
  });

  it('an empty bold label does not take in the next paragraph', () => {
    const r = pointers(`# 14 Mar\n**Escalate to Kevin:**\n\n**Indexed:** [[${MATTER}]].\n`);
    expect(r.docs).toEqual(['2031-03-14.md']);
  });

  it('Home and _system notes are never the matter', () => {
    const r = pointers(`# 14 Mar\n- [[Home]], [[brain-questions]] and [[${MATTER}]]. ESCALATE TO KEVIN.\n`,
      { 'Home.md': '' });
    expect(r.docs).toEqual([`${MATTER}.md`]);
  });

  it('CONTROL: the red-lines file still shows when the review links it', () => {
    const r = pointers('# 14 Mar\n- Sensitive matters live in [[constraints-and-red-lines]].\n');
    expect(r.docs).toEqual(['constraints-and-red-lines.md']);
  });

  it('CONTROL: no escalation, no sensitive item', () => {
    const r = pointers(`# 14 Mar\n- Filed [[${MATTER}]] today.\n### Deadlines\n- None.\n`);
    expect(r.docs).toEqual([]);
  });
});
