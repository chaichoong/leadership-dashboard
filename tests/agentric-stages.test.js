import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The AGENTRIC framework (24 Aug 2026): eight stages, R (Reasoning) added and
// C carrying the score. These tests pull the REAL constant and the REAL
// normaliser out of os/systemisation/index.html, so a stage quietly dropped,
// reordered, or given the wrong N/A rule fails here rather than in production.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'os/systemisation/index.html'), 'utf8');

function extractConst(name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`${name} not found`);
  let i = src.indexOf('[', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end) + ';';
}

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const stagesCode = extractConst('AGENTIC_STAGES');
const STAGES = new Function(`${stagesCode} return AGENTIC_STAGES;`)();
const normalise = new Function(
  `${stagesCode} ${extractFn('stageNaAllowed')} ${extractFn('normaliseReadiness')} return normaliseReadiness;`
)();

const allClear = (letters) => letters.map(l => ({ letter: l, status: 'Clear', reason: '' }));

describe('AGENTRIC stages (the framework constant)', () => {
  it('has exactly eight stages spelling A-G-E-N-T-R-I-C in order', () => {
    expect(STAGES.map(s => s.letter).join('')).toBe('AGENTRIC');
  });

  it('R (Reasoning) exists: never N/A for an agent, N/A allowed for a human task', () => {
    const r = STAGES.find(s => s.letter === 'R');
    expect(r.name).toBe('Reasoning');
    expect(r.naAllowed).toEqual({ agent: false, human: true });
    expect(r.prompt.length).toBeGreaterThan(20);
  });

  it('N/A per mode: only I for agents; only I and R for humans', () => {
    expect(STAGES.filter(s => s.naAllowed.agent).map(s => s.letter)).toEqual(['I']);
    expect(STAGES.filter(s => s.naAllowed.human).map(s => s.letter)).toEqual(['R', 'I']);
  });

  it('C carries the score', () => {
    const c = STAGES.find(s => s.letter === 'C');
    expect(c.name).toBe('Conclusion & Score');
    expect(c.prompt.toLowerCase()).toContain('score');
  });
});

describe('normaliseReadiness N/A rules per mode', () => {
  it('NA on R survives for a HUMAN task but becomes Missing for an agent', () => {
    const parsed = { stages: allClear('AGENTIC'.split('')).concat([{ letter: 'R', status: 'NA', reason: 'human judgement' }]), questions: [] };
    const human = normalise(parsed, {}, null, true);
    expect(human.stages.find(s => s.letter === 'R').status).toBe('NA');
    const agent = normalise(parsed, {}, null, false);
    expect(agent.stages.find(s => s.letter === 'R').status).toBe('Missing');
  });

  it('NA on I survives in both modes; NA on N never survives', () => {
    const parsed = {
      stages: allClear(['A', 'G', 'E', 'T', 'R', 'C']).concat([
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

  it('all eight Clear derives Ready; one Thin derives Needs input', () => {
    const clear = { stages: allClear(STAGES.map(s => s.letter)), questions: [] };
    expect(normalise(clear, {}, null, false).state).toBe('Ready');
    const thin = { stages: allClear(STAGES.map(s => s.letter)).map(s => s.letter === 'R' ? { ...s, status: 'Thin' } : s), questions: [] };
    expect(normalise(thin, {}, null, false).state).toBe('Needs input');
  });
});

describe('shared check wording (no drift between the two routes)', () => {
  it('the workflow check, the register check, and the form check all use agentricPassRules', () => {
    const calls = src.split('agentricPassRules(').length - 1;
    // 1 definition + at least 3 call sites (workflow check, register check, form stage check)
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it('no hardcoded seven-stage wording is left in the check prompts', () => {
    expect(src).not.toMatch(/seven AGENTI?C/i);
    expect(src).not.toMatch(/seven entries for/);
  });
});
