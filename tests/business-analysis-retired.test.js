// The Business Analysis agent (the AI chat panel, js/ai-assistant.js) was retired on
// 18 Nov 2026 on Kevin's approval. Agent chats in Claude Code replace it.
//
// The chat script was a plain <script>, so everything it declared was a page global,
// and other files leaned on two of them: js/wealth.js called fetch(AI_PROXY) with no
// fallback, and js/pnl.js rendered model output through renderMarkdown(). Deleting the
// script would have turned the Wealth statement reader into a ReferenceError and the
// P&L analysis into unescaped model text in innerHTML, with no error on page load.
// These checks fail if a page still reaches for a name the retired script owned.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(resolve(root, f), 'utf8');

// Every global the retired script declared that another file ever called.
const RETIRED_GLOBALS = [
  'AI_PROXY', 'renderMarkdown', 'updateDashboardState', 'renderAIChips',
  'toggleAIPanel', 'sendAIMessage', 'openCmdPalette', 'closeCmdPalette', 'filterCmdPalette',
];

// The scripts index.html loads from js/, read off the page itself so a new one is covered.
const index = read('index.html');
const shellScripts = [...index.matchAll(/<script[^>]*\bsrc="(js\/[^"?]+)/g)].map((m) => m[1]);

describe('Business Analysis chat panel stays retired', () => {
  it('the script is gone and index.html no longer loads it', () => {
    expect(existsSync(resolve(root, 'js/ai-assistant.js'))).toBe(false);
    expect(index).not.toMatch(/ai-assistant\.js/);
  });

  it('the shell has no bubble, panel or command palette markup', () => {
    for (const id of ['aiBubble', 'aiPanel', 'aiInput', 'aiMessages', 'aiChips', 'aiCmdOverlay']) {
      expect(index, `#${id} is chat panel markup`).not.toContain(`id="${id}"`);
    }
  });

  it('the shell loads a sensible number of scripts (control)', () => {
    // If the regex stops matching, the next test checks nothing and passes.
    expect(shellScripts.length).toBeGreaterThan(20);
    expect(shellScripts).toContain('js/wealth.js');
    expect(shellScripts).toContain('js/pnl.js');
  });

  it('no script on the shell calls a name the retired script owned', () => {
    const offenders = [];
    for (const f of shellScripts) {
      const src = read(f);
      for (const g of RETIRED_GLOBALS) {
        if (new RegExp(`\\b${g}\\b`).test(src)) offenders.push(`${f}: ${g}`);
      }
    }
    expect(offenders).toEqual([]);
    // index.html inline handlers count too.
    for (const g of RETIRED_GLOBALS) expect(index, `index.html: ${g}`).not.toMatch(new RegExp(`\\b${g}\\b`));
  });

  it('the AI Brain page no longer posts questions to the retired panel', () => {
    expect(read('ai-brain.html')).not.toContain('od-ask-brain');
  });

  it('P&L and Wealth keep their own relay and the escaping renderer', () => {
    const pnl = read('js/pnl.js');
    const wealth = read('js/wealth.js');
    expect(pnl).toContain("const PNL_AI_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev'");
    expect(pnl).toMatch(/fetch\(PNL_AI_PROXY,/);
    expect(pnl).toMatch(/\$\{pnlRenderMarkdown\(text\)\}/);
    expect(wealth).toContain("const WEALTH_AI_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev'");
    expect((wealth.match(/fetch\(WEALTH_AI_PROXY,/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('pnlRenderMarkdown escapes model output before it adds markup', () => {
    const pnl = read('js/pnl.js');
    const start = pnl.indexOf('function pnlRenderMarkdown(');
    let i = pnl.indexOf('{', start), depth = 0, end = -1;
    for (; i < pnl.length; i++) {
      if (pnl[i] === '{') depth++;
      else if (pnl[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const fn = new Function(`${pnl.slice(start, end)}; return pnlRenderMarkdown;`)();
    const out = fn('**Net** <img src=x onerror=alert(1)>');
    expect(out).toContain('<strong>Net</strong>');
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<img');
  });
});
