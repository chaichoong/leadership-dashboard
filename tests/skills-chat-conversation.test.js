// One AI error must not kill a Skills Library chat for good.
//
// Regression origin: finding 20260824-drift-monitor-332 (24 Aug 2026).
// sendSkillMessage pushed the user turn into _skillConversation BEFORE the
// fetch and only pushed the assistant reply on success. A failed turn therefore
// left the array ending on a user turn. The next message appended a SECOND user
// turn and POSTed [user, user] to the Anthropic Messages API, which rejects
// non-alternating roles with a 400 — so the catch fired again, appended another
// user turn, and every later message in that modal failed the same way. One
// transient 529 killed the whole skill run, and the symptom read as a fresh
// "AI returned 400" rather than a consequence of the first blip.
//
// The real source is extracted and evaluated (tests/follow-up-init-errors.test.js
// pattern) so this can never pass against a stale copy of the function.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../js/skills.js'), 'utf8');

function extract(name) {
  const start = SRC.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/skills.js`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

// Everything sendSkillMessage reaches for from its enclosing IIFE, injected so
// the REAL function body runs rather than a copy of it.
function load({ responses }) {
  const conversation = [];
  const bubbles = [];
  const sent = [];
  let call = 0;
  const noopEl = () => ({
    style: {}, className: '', innerHTML: '',
    appendChild() {}, remove() {}, focus() {}, scrollTop: 0, scrollHeight: 0,
  });
  const document = {
    getElementById: () => null,
    createElement: () => noopEl(),
  };
  const fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body).messages.map((m) => m.role));
    const r = responses[call++];
    if (r === 'fail') return { ok: false, status: 529 };
    return { ok: true, status: 200, json: async () => ({ content: [{ text: 'reply ' + call }] }) };
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    '_skillConversation', 'document', 'fetch', 'AI_MODEL_DEFAULT', 'SKILL_PROXY',
    'appendSkillBubble', '_state',
    `let _skillBusy = false; ${extract('sendSkillMessage')}; return sendSkillMessage;`);
  const fn = factory(conversation, document, fetch, 'model-x', 'https://proxy.test',
    (role, text) => bubbles.push([role, text]), {});
  return { fn, conversation, bubbles, sent };
}

const alternates = (roles) => roles.every((r, i) => r === (i % 2 === 0 ? 'user' : 'assistant'));

describe('Skills Library chat history', () => {
  it('a failed turn leaves the conversation usable', async () => {
    const { fn, conversation, bubbles } = load({ responses: ['fail'] });
    await fn({ name: 'X' }, 'system', 'hello');
    expect(bubbles.some(([, t]) => String(t).startsWith('Error:'))).toBe(true);
    // The failed user turn must not be left behind.
    expect(conversation).toHaveLength(0);
  });

  it('the next message after a failure is a clean retry, not a 400', async () => {
    const { fn, conversation, sent } = load({ responses: ['fail', 'ok'] });
    await fn({ name: 'X' }, 'system', 'hello');
    await fn({ name: 'X' }, 'system', 'hello again');
    // CONTROL: reverting the fix makes this ['user','user'] and the API 400s.
    expect(sent[1]).toEqual(['user']);
    expect(alternates(conversation.map((m) => m.role))).toBe(true);
  });

  it('a healthy conversation still alternates and keeps its history', async () => {
    const { fn, conversation, sent } = load({ responses: ['ok', 'ok'] });
    await fn({ name: 'X' }, 'system', 'one');
    await fn({ name: 'X' }, 'system', 'two');
    expect(conversation.map((m) => m.role))
      .toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(sent[1]).toEqual(['user', 'assistant', 'user']);
  });
});
