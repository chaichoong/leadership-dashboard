import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SETUP_QUESTIONS, SETUP_STEPS, BOARD_SEATS, WORKERS, defaultConfig, mergeConfig, missingForGoLive, setPath, getPath } from '../js/ceo-brief-defaults.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(resolve(ROOT, 'docs/ceo-brief-client-onboarding.md'), 'utf8');

// The onboarding document is the thing Kevin reads to judge whether a client can
// be onboarded. It must list EVERY question the setup screen asks, in full, so the
// document can never quietly fall behind the code.

describe('the onboarding document prints every setup question', () => {
  it('has at least one question (control)', () => {
    expect(SETUP_QUESTIONS.length).toBeGreaterThan(20);
  });

  for (const q of SETUP_QUESTIONS) {
    it(`lists "${q.label}"`, () => {
      expect(DOC).toContain(q.label);
    });
  }

  for (const s of SETUP_STEPS) {
    it(`has a heading for step ${s.step}: ${s.title}`, () => {
      expect(DOC).toContain(`Step ${s.step}: ${s.title}`);
    });
  }

  it('names every default board seat and its head', () => {
    for (const s of BOARD_SEATS) {
      expect(DOC).toContain(s.seat);
      expect(DOC).toContain(s.head);
    }
  });

  it('names the blocking answers exactly as missingForGoLive reports them', () => {
    const blank = defaultConfig();
    const flat = DOC.toLowerCase().replace(/\s+/g, ' ');   // the doc wraps at 90 columns
    for (const label of missingForGoLive(blank)) {
      expect(flat).toContain(label.toLowerCase());
    }
  });
});

describe('config helpers', () => {
  it('mergeConfig fills gaps and keeps saved values', () => {
    const c = mergeConfig({ founder: { name: 'Sam' }, board: [{ seat: 'Strategy', head: 'X', enabled: true }] });
    expect(c.founder.name).toBe('Sam');
    expect(c.founder.tone).toBe('straight');
    expect(c.board).toHaveLength(1);           // arrays are replaced whole
    expect(c.workers).toHaveLength(WORKERS.length);
  });

  it('missingForGoLive is empty for a complete config and lists the delivery address when Slack is chosen', () => {
    const c = defaultConfig();
    setPath(c, 'founder.name', 'Sam'); setPath(c, 'founder.business', 'Acme'); setPath(c, 'founder.what_it_sells', 'Widgets, £10');
    setPath(c, 'quarter.context', 'Ship v1'); setPath(c, 'founder.wheelhouse', ['decisions']);
    expect(missingForGoLive(c)).toEqual([]);
    setPath(c, 'delivery.channel', 'slack_webhook');
    expect(missingForGoLive(c)).toEqual(['Slack webhook address']);
  });

  it('every question path resolves inside the default config', () => {
    const c = defaultConfig();
    for (const q of SETUP_QUESTIONS) {
      expect(getPath(c, q.path), q.path).not.toBeUndefined();
    }
  });

  it('question ids are unique', () => {
    const ids = SETUP_QUESTIONS.map(q => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
