import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// An approved arrears card whose text was refused by the email parser (18 Nov 2026).
// They drive the real scripts/agent_email_format.py. Names, numbers and amounts are invented.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function py(body) {
  const out = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
import agent_email_format as f
${body}`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('finding 20261118-agent-dispatch-1355: the rent lane arrears card may be texted', () => {
  it('a RENT ARREARS card is a rent lane tenant card; other cards still are not', () => {
    const r = py(`print(json.dumps([
  f.text_card(name="RENT ARREARS: Unit 2 – 1 Example Place, rent due 31 Oct unpaid"),
  f.text_card(name="RENT LATE: Flat 1 – 2 Example Road"),
  f.text_card(name="INBOUND: tenant asks about arrears"),
  f.text_card(name="Chase: RENT ARREARS: written mid-name")]))`);
    expect(r).toEqual([true, true, false, false]);
  });
});
