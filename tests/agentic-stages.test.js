import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The AGENTIC framework (Kevin's ruling 25 Aug 2026): seven stages, the
// acronym unchanged, reasoning folded INTO Navigate, C carrying the score.
//
// Since the AI Agents page moved out of Systemisation (25 Aug 2026), the
// framework lives in TWO pages: os/agents/index.html (the register readiness
// check and the guided creation form) and os/systemisation/index.html (the
// workflow/SOP readiness check). The AGENTS page is canonical — every
// behavioural test below extracts the REAL constant and the REAL normaliser
// from it — and a dedicated block asserts the Systemisation copies are
// byte-identical, so the two routes cannot drift apart.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'os/agents/index.html'), 'utf8');
const sysSrc = readFileSync(resolve(root, 'os/systemisation/index.html'), 'utf8');

function extractConst(source, name) {
  // Handles array ([...]) and object ({...}) literals alike.
  let open = '[', close = ']';
  let start = source.indexOf(`const ${name} = [`);
  if (start === -1) {
    start = source.indexOf(`const ${name} = {`);
    open = '{'; close = '}';
  }
  if (start === -1) throw new Error(`${name} not found`);
  let i = source.indexOf(open, start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return source.slice(start, end) + ';';
}

function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return source.slice(start, end);
}

const stagesCode = extractConst(src, 'AGENTIC_STAGES');
const STAGES = new Function(`${stagesCode} return AGENTIC_STAGES;`)();
const normalise = new Function(
  `${stagesCode} ${extractFn(src, 'stageNaAllowed')} ${extractFn(src, 'normaliseReadiness')} return normaliseReadiness;`
)();

const allClear = (letters) => letters.map(l => ({ letter: l, status: 'Clear', reason: '' }));

describe('AGENTIC stages (the framework constant)', () => {
  it('has exactly seven stages spelling A-G-E-N-T-I-C in order', () => {
    expect(STAGES.map(s => s.letter).join('')).toBe('AGENTIC');
  });

  it('Navigate carries the reasoning: decision rules AND the when-unsure behaviour', () => {
    const n = STAGES.find(s => s.letter === 'N');
    expect(n.prompt.toLowerCase()).toContain('how you decide');
    expect(n.prompt.toLowerCase()).toMatch(/guess.*skip.*ask/);
  });

  it('there is no separate Reasoning stage', () => {
    expect(STAGES.some(s => s.name === 'Reasoning' || s.letter === 'R')).toBe(false);
  });

  it('N/A per mode: only I, in both modes', () => {
    expect(STAGES.filter(s => s.naAllowed.agent).map(s => s.letter)).toEqual(['I']);
    expect(STAGES.filter(s => s.naAllowed.human).map(s => s.letter)).toEqual(['I']);
  });

  it('C carries the score', () => {
    const c = STAGES.find(s => s.letter === 'C');
    expect(c.name).toBe('Conclusion & Score');
    expect(c.prompt.toLowerCase()).toContain('score');
  });

  it('G names the no-blanket-schedule rule', () => {
    const g = STAGES.find(s => s.letter === 'G');
    expect(g.prompt.toLowerCase()).toContain('no blanket schedule');
  });
});

describe('normaliseReadiness N/A rules', () => {
  it('NA on I survives in both modes; NA on N never survives', () => {
    const parsed = {
      stages: allClear(['A', 'G', 'E', 'T', 'C']).concat([
        { letter: 'I', status: 'NA', reason: 'nothing to check' },
        { letter: 'N', status: 'NA', reason: 'should be impossible' },
      ]),
      questions: [],
    };
    for (const human of [true, false]) {
      const out = normalise(parsed, {}, null, human);
      expect(out.stages.find(s => s.letter === 'I').status).toBe('NA');
      expect(out.stages.find(s => s.letter === 'N').status).toBe('Missing');
    }
  });

  it('all seven Clear derives Ready; one Thin derives Needs input', () => {
    const clear = { stages: allClear(STAGES.map(s => s.letter)), questions: [] };
    expect(normalise(clear, {}, null, false).state).toBe('Ready');
    const thin = { stages: allClear(STAGES.map(s => s.letter)).map(s => s.letter === 'N' ? { ...s, status: 'Thin' } : s), questions: [] };
    expect(normalise(thin, {}, null, false).state).toBe('Needs input');
  });
});

describe('accuracy bands (guardrailBand)', () => {
  const bandOf = (rows) => {
    // GUARDRAIL_ORDER is extracted from the page, never copied here: a test
    // that carries its own copy of a page constant certifies nothing when
    // the page's copy changes (review finding, 24 Aug 2026).
    const fn = new Function(
      `let _agentAccuracyRows = ${JSON.stringify(rows)}; ${extractConst(src, 'GUARDRAIL_ORDER')} ${extractFn(src, 'guardrailBand')} return guardrailBand('tm1');`
    );
    return fn();
  };

  it('needs a 20-piece sample before banding at all', () => {
    expect(bandOf([{ agentId: 'tm1', taskType: 'Drafting', total: 19, rate: 0.5, recentRejections: 0 }])).toBeNull();
  });

  it('bands on the WORST job type: below 70 = Approval, 70-90 = Hybrid, 90+ clean = Autonomous', () => {
    expect(bandOf([
      { agentId: 'tm1', taskType: 'Drafting', total: 40, rate: 0.95, recentRejections: 0 },
      { agentId: 'tm1', taskType: 'Analysis', total: 25, rate: 0.60, recentRejections: 0 },
    ]).level).toBe('Approval required');
    expect(bandOf([{ agentId: 'tm1', taskType: 'Drafting', total: 40, rate: 0.85, recentRejections: 0 }]).level).toBe('Hybrid escalation');
    expect(bandOf([{ agentId: 'tm1', taskType: 'Drafting', total: 40, rate: 0.95, recentRejections: 0 }]).level).toBe('Autonomous');
  });

  it('a recent rejection blocks Autonomous even at 90%+', () => {
    expect(bandOf([{ agentId: 'tm1', taskType: 'Drafting', total: 40, rate: 0.95, recentRejections: 1 }]).level).toBe('Hybrid escalation');
  });
});

describe('shared check wording (no drift between the two routes)', () => {
  it('the agents page uses agenticPassRules for the register check and the form check', () => {
    const calls = src.split('agenticPassRules(').length - 1;
    // 1 definition + at least 2 call sites (register check, form stage check)
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('the systemisation page still uses agenticPassRules for the workflow check', () => {
    const calls = sysSrc.split('agenticPassRules(').length - 1;
    // 1 definition + at least 1 call site (workflow/SOP check)
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('no eight-stage or AGENTRIC wording is left on either page', () => {
    for (const s of [src, sysSrc]) {
      expect(s).not.toMatch(/AGENTRIC/i);
      expect(s).not.toMatch(/eight AGENTI?C/i);
    }
  });
});

// The framework exists in both pages because a plain <script> page cannot
// import from another page. Copies drift — that is this platform's oldest
// failure class — so the copies are held byte-identical here. A deliberate
// change to the framework must land in BOTH files in the same commit.
describe('the agents page and the systemisation page carry identical framework copies', () => {
  it.each([
    ['AGENTIC_STAGES', 'const'],
    ['stageNaAllowed', 'fn'],
    ['normaliseReadiness', 'fn'],
    ['agenticStageListText', 'fn'],
    ['agenticNaRule', 'fn'],
    ['agenticCheckIntro', 'fn'],
    ['agenticPassRules', 'fn'],
    ['agenticResultShape', 'fn'],
    ['callClaudeJson', 'fn'],
    // Added 24 Aug 2026 (review finding): legacyReadinessBanner had already
    // diverged at birth — the one framework copy outside this list was the
    // one that drifted. Every shared framework symbol belongs here.
    ['legacyReadinessBanner', 'fn'],
    ['agenticSopText', 'fn'],
    ['readinessRowsHtml', 'fn'],
    ['AGENTIC_STATUS', 'const'],
  ])('%s is byte-identical in both pages', (name, kind) => {
    const grab = kind === 'const' ? extractConst : extractFn;
    expect(grab(sysSrc, name)).toBe(grab(src, name));
  });
});
