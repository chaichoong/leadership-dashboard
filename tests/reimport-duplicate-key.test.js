// The no-reimport-duplicates invariant must key on the BANK's transaction id,
// never on the feed provider's.
//
// Regression origin: 20 Aug 2026. The guard written after the July re-import
// incident keyed on the suffix of **Plaid TX ID ("<accountId>--<providerTxId>"),
// assuming a re-import changes only the account-id prefix. Fintable then migrated
// Santander onto a "gocardless_v3_<sha256>" id scheme, which changed the suffix
// too. Both halves were different, so the two copies of one payment hashed to two
// different keys and the check reported 0 violations while 201 duplicates sat in
// the Transactions table — £31,443.90 in and £31,650.67 out, across Feb, Mar, May
// and Jun 2026. Nothing errored. It read as a clean pass.
//
// The bank's own transactionId inside **Raw was byte-identical on both copies.
//
// These tests drive the real check_reimport_duplicates() against a local stub
// serving the exact shape of that pair. Back-tested: restoring the Plaid-suffix
// key makes the first test return 0 violations and this file goes red.

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = resolve(__dirname, '../scripts/check-data-invariants.py');

const raw = (bankTxId, amount, date) =>
  JSON.stringify({
    transactionId: bankTxId,
    bookingDate: date,
    transactionAmount: { amount: String(amount), currency: 'GBP' },
    normalized_tx_id: bankTxId,
  });

// The real 27 Feb 2026 Admiral Insurance pair: same bank transactionId, and a
// **Plaid TX ID whose account id AND provider tx id both differ.
const REIMPORT_PAIR = [
  {
    id: 'recORIGINAL0001',
    fields: {
      '**Raw': raw('8b4c0205-3183-3999-9948-f66a0a2c2c3b', -66.73, '2026-02-27'),
      '**Plaid TX ID': '3841395802969376057--8b4c0205-3183-3999-9948-f66a0a2c2c3b',
      'Account Alias (from **Account)': ['Santander'],
      '**GBP': -66.73,
      '**Date': '2026-02-27',
    },
  },
  {
    id: 'recREIMPORT0001',
    fields: {
      '**Raw': raw('8b4c0205-3183-3999-9948-f66a0a2c2c3b', -66.73, '2026-02-27'),
      '**Plaid TX ID':
        '2455566022641499009--gocardless_v3_b5218439e25706c0e0277d110cc2bbe09f7c138adeb0e66cc9847c375a820368',
      'Account Alias (from **Account)': ['Santander'],
      '**GBP': -66.73,
      '**Date': '2026-02-27',
    },
  },
];

// Two real £56.99 Amazon charges on the same day — same date, same amount,
// different bank transaction ids. A date+amount key would call these duplicates.
const GENUINE_SAME_DAY_PAIR = [
  {
    id: 'recAMAZON0001',
    fields: {
      '**Raw': raw('aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', -56.99, '2026-03-20'),
      '**Plaid TX ID': '3841395802969376057--aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
      'Account Alias (from **Account)': ['Santander'],
      '**GBP': -56.99,
      '**Date': '2026-03-20',
    },
  },
  {
    id: 'recAMAZON0002',
    fields: {
      '**Raw': raw('bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', -56.99, '2026-03-20'),
      '**Plaid TX ID': '3841395802969376057--bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
      'Account Alias (from **Account)': ['Santander'],
      '**GBP': -56.99,
      '**Date': '2026-03-20',
    },
  },
];

let payload = [];

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ records: payload }));
});
const listening = new Promise((r) => server.listen(0, '127.0.0.1', r));
afterAll(() => server.close());

async function checkAgainst(records) {
  await listening;
  payload = records;
  const port = server.address().port;
  const py = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("cdi", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
violations, control = m.check_reimport_duplicates("fake-pat")
print(json.dumps({"violations": violations, "control": control}))
`;
  const { stdout } = await run('python3', ['-c', py], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, AIRTABLE_API_BASE: `http://127.0.0.1:${port}` },
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

describe('no-reimport-duplicates keys on the bank transaction id', () => {
  it('catches a re-import whose feed id changed on BOTH sides of the --', async () => {
    const r = await checkAgainst(REIMPORT_PAIR);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].copies).toBe(2);
    expect(r.violations[0].ids.sort()).toEqual(['recORIGINAL0001', 'recREIMPORT0001']);
    // The evidence a human needs: one bank payment, two provider ids.
    expect(r.violations[0].bank_transaction_id).toBe('8b4c0205-3183-3999-9948-f66a0a2c2c3b');
    expect(r.violations[0].feed_ids).toHaveLength(2);
  });

  it('does not flag two real payments of the same value on the same day', async () => {
    const r = await checkAgainst(GENUINE_SAME_DAY_PAIR);
    expect(r.violations).toHaveLength(0);
  });

  it('counts every record carrying a bank id as control, so a blind check fails loudly', async () => {
    const r = await checkAgainst([...REIMPORT_PAIR, ...GENUINE_SAME_DAY_PAIR]);
    expect(r.control).toBe(4);
    expect(r.violations).toHaveLength(1);
  });

  it('ignores records with no raw feed payload rather than pairing them up', async () => {
    const manual = [
      { id: 'recMANUAL0001', fields: { '**GBP': -10, '**Date': '2026-03-01' } },
      { id: 'recMANUAL0002', fields: { '**GBP': -10, '**Date': '2026-03-01' } },
    ];
    const r = await checkAgainst(manual);
    expect(r.violations).toHaveLength(0);
    expect(r.control).toBe(0);
  });
});
