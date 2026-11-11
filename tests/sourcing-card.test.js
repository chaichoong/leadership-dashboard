import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// THE SOURCING CARD (Kevin, 11 Nov 2026). On 2 Nov 2026 a sourcing card for four fridge freezers
// (task reck5ZY5MoXulxJz8) reached him with ten listing links and a wall of text, and he had to vet
// every link himself. A sourcing card now offers one pick per unit needed and two reserves, with the
// facts on fixed lines (scripts/agent_sourcing_format.py). `submit` refuses a card that does not meet
// it, and `complete` closes a sourcing card only once the buy is on the Preferred Products list or the
// agent says why nothing was bought. Every case drives the real Python; no network, no Airtable.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const FORMAT = resolve(SCRIPTS, 'agent_sourcing_format.py');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const RESPONSE = 'recJ8J8idWE8d97tH';

function py(path, body, payload = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(path)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
P = json.loads(sys.argv[1])
${body}
`, JSON.stringify(payload)], { encoding: 'utf8', env: { ...process.env, SIGNIN_SKIP_WALK: '1' } });
  return JSON.parse(out.trim().split('\n').pop());
}

const problem = (output) => py(FORMAT, 'print(json.dumps(m.sourcing_problem(P["o"])))', { o: output });
const backstop = (output) => py(FORMAT, 'print(json.dumps(m.listing_without_shape_problem(P["o"])))', { o: output });
const parse = (output) => py(FORMAT, 'print(json.dumps(m.parse_sourcing(P["o"])))', { o: output });

const fb = (n) => `https://www.facebook.com/marketplace/item/${1000000000000000 + n}/`;
const CLOSING = '**Carrying this out will involve:** the robot messages the sellers of the picks. Nothing is bought.';

// (a) Task reck5ZY5MoXulxJz8, four fridge freezers for the Haverhill HMOs, written in the new shape.
const FRIDGES = [
  'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=kevin-asked',
  '',
  '**Approve: the robot messages the four sellers to confirm height and delivery. Nothing is bought.**',
  '',
  'SOURCING: Fridge freezer, full height x 4 for 13 Chedburgh Place and three more Haverhill HMOs',
  'BASELINE: none on the list',
  `PICK 1: Hoover low frost, 176 cm | second-hand | £70 | ${fb(1)}`,
  `PICK 2: Beko frost free, 182 cm | second-hand | £60 | ${fb(2)}`,
  `PICK 3: Hotpoint First Edition, 177 cm | second-hand | £55 | ${fb(3)}`,
  `PICK 4: Bush, 180 cm | second-hand | £75 | ${fb(4)}`,
  `RESERVE 1: Logik LFC55W12, 172.5 cm | second-hand | £70 | ${fb(5)}`,
  `RESERVE 2: Samsung, 177 cm | second-hand | £75 | ${fb(6)}`,
  'NEW FOR COMPARISON: Beko full height fridge freezer | £399 | https://www.currys.co.uk/products/beko-fridge-freezer-10000000.html',
  'CASHBACK: n/a',
  'PROVEN: every pick is £75 or under, 175 cm or taller and still for sale at 00:40',
  'NOT PROVEN: clean inside is not stated on pick 2',
  'SAVING: £1,336 against four new at £399',
  'PAY BY: seller: cash on collection',
  'SEARCHED: Facebook Marketplace and Gumtree within 40 km of Haverhill; eBay NOT CHECKED: the robot refused it',
  'SPEND: £260 (one-off)',
  '',
  'TRACK RECORD: nothing new since 30 Oct.',
  '',
  CLOSING,
].join('\n');

// (b) The ACTUAL 2 Nov 2026 card for that task, trimmed and with every name and contact taken out.
// Its structure is kept: one pick, eight reserves, ten listing links, a SPEND line, no SOURCING line.
const NOV2 = [
  'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=kevin-asked',
  '',
  '**Approve: the robot messages four Facebook sellers (the one pick and three reserves). Nothing is bought.**',
  '',
  'Plainly: only ONE listing met all three rules this morning.',
  '',
  '## The links (click to check)',
  'The one that meets all three rules:',
  '1. Hoover, £70, Royston, 176 cm: https://www.facebook.com/marketplace/item/1314188080468782/',
  'Reserves (height not proven, best first):',
  '- Logik frost free, £70, Cambridge (Gumtree): https://www.gumtree.com/p/fridges-freezers/fridge-freezer-frost-free-white-logik/1803479475',
  '- Beko, £50, no height: https://www.facebook.com/marketplace/item/2072596373345335/',
  '- Hotpoint, £40, no height: https://www.facebook.com/marketplace/item/1860473992069477/',
  '- Bush, £70 (Gumtree): https://www.gumtree.com/p/fridges-freezers/bush-fridge-freezer-white-good-condition/1803910202',
  '- Hotpoint silver, £70 (Gumtree): https://www.gumtree.com/p/fridges-freezers/free-standing-hotpoint-fridge-freezer-/1804219245',
  '- Free, seller delivers: https://www.facebook.com/marketplace/item/4515659538685058/',
  '- Hotpoint large, £60, needs a clean: https://www.facebook.com/marketplace/item/1866345527879676/',
  '- Over £75, height proven: Samsung, £100: https://www.facebook.com/marketplace/item/1478808194312212/',
  '',
  'SPEND: £70 for the one pick (one-off). If three reserves are confirmed tall, the four would cost £180 to £280.',
  '',
  'TRACK RECORD: nothing new on fridge freezers since 30 Oct.',
  '',
  '## Not done, and why',
  '- eBay NOT CHECKED. The robot browser refuses it.',
  '',
  'KEVIN ONLY: purchase: 1. open each confirmed listing 2. pay each seller',
  '',
  '**Carrying this out will involve:** the robot messages four Facebook sellers from your account. Nothing is bought.',
].join('\n');

// (c) A bulk new order from a shop.
const FENCE = [
  'SOURCING: Fence posts and postcrete x 1 for 4 Abington Place',
  'BASELINE: none on the list',
  'PICK: 10 fence posts 2.4 m and 10 bags of postcrete | new | £148.90 | https://www.screwfix.com/c/outdoor-gardening/fence-posts/cat000000',
  'RESERVE 1: Same order from Toolstation | new | £152.40 | https://www.toolstation.com/fence-posts/c000',
  'RESERVE 2: none found',
  'CASHBACK: TopCashback 2% at Screwfix, about £3, expected not guaranteed',
  'PROVEN: 2.4 m posts, 10 in stock for collection at the Haverhill branch, price includes VAT',
  'NOT PROVEN: nothing',
  'SAVING: no baseline',
  'PAY BY: shop checkout',
  'SEARCHED: Screwfix, Toolstation, B&Q',
  'SPEND: £148.90 (one-off)',
  '',
  CLOSING,
].join('\n');

const drop = (text, prefix) => text.split('\n').filter((l) => !l.startsWith(prefix)).join('\n');
const swap = (text, prefix, line) => text.split('\n').map((l) => (l.startsWith(prefix) ? line : l)).join('\n');

describe('the sourcing card shape', () => {
  it('a fully valid card passes, and parses to its picks and reserves', () => {
    expect(problem(FRIDGES)).toBe('');
    const p = parse(FRIDGES);
    expect(p.qty).toBe(4);
    expect(p.picks).toHaveLength(4);
    expect(p.picks[0]).toMatchObject({ kind: 'second-hand', price: 70 });
    expect(p.reserves).toHaveLength(2);
    expect(p.any_second_hand).toBe(true);
    expect(p.any_new).toBe(false);
    expect(p.spend).toBe(260);
  });

  it('the bulk new order passes; the same with CASHBACK n/a is refused', () => {
    expect(problem(FENCE)).toBe('');
    expect(parse(FENCE).reserves[1]).toBeNull();
    expect(problem(swap(FENCE, 'CASHBACK:', 'CASHBACK: n/a'))).toMatch(/CASHBACK cannot be n\/a when a pick is new/);
  });

  it.each([
    ['BASELINE:', /BASELINE line is missing/],
    ['PROVEN:', /PROVEN line is missing/],
    ['NOT PROVEN:', /NOT PROVEN line is missing/],
    ['SAVING:', /SAVING line is missing/],
    ['PAY BY:', /PAY BY line is missing/],
    ['SEARCHED:', /SEARCHED line is missing/],
    ['RESERVE 1:', /RESERVE 1 line is missing/],
    ['RESERVE 2:', /RESERVE 2 line is missing/],
    ['NEW FOR COMPARISON:', /second-hand pick needs a NEW FOR COMPARISON line/],
    ['CASHBACK:', /CASHBACK line is missing/],
    ['SPEND:', /no SPEND line/],
    ['PICK', /no PICK line/],
  ])('removing the %s line is refused, naming it', (prefix, msg) => {
    expect(problem(drop(FRIDGES, prefix))).toMatch(msg);
  });

  it('an empty required line is refused like a missing one', () => {
    expect(problem(swap(FRIDGES, 'PROVEN:', 'PROVEN:'))).toMatch(/PROVEN line is missing or empty/);
  });

  it('the SOURCING line must carry the quantity', () => {
    expect(problem(swap(FENCE, 'SOURCING:', 'SOURCING: Fence posts for 4 Abington Place')))
      .toMatch(/SOURCING line must say how many/);
    expect(problem(swap(FENCE, 'SOURCING:', 'SOURCING: Fence posts x 0 for 4 Abington Place')))
      .toMatch(/1 or more/);
  });

  it.each([
    ['a link that is not http', 'PICK: Posts | new | £148.90 | www.screwfix.com/posts', /link on PICK must be one http or https address/],
    ['a zero price', 'PICK: Posts | new | £0 | https://www.screwfix.com/p/1', /more than £0/],
    ['a price with no £', 'PICK: Posts | new | 148.90 | https://www.screwfix.com/p/1', /written as £ and a number/],
    ['a bad kind', 'PICK: Posts | refurbished | £148.90 | https://www.screwfix.com/p/1', /must be new or second-hand/],
    ['three fields', 'PICK: Posts | new | £148.90', /four parts split by ' \| '.*has 3/],
  ])('a PICK with %s is refused', (_label, line, msg) => {
    expect(problem(swap(FENCE, 'PICK:', line))).toMatch(msg);
  });

  it('more PICK lines than the quantity is refused', () => {
    const two = FENCE.replace(/^PICK: /m, 'PICK 1: ').replace(/^(PICK 1: .*)$/m,
      '$1\nPICK 2: Posts again | new | £150 | https://www.diy.com/p/1');
    expect(problem(two)).toMatch(/2 PICK lines for a quantity of 1/);
  });

  it('a malformed reserve or comparison is refused; none found and not found: why are accepted', () => {
    expect(problem(swap(FENCE, 'RESERVE 1:', 'RESERVE 1: Toolstation | new | £152'))).toMatch(/RESERVE 1 must have four parts/);
    expect(problem(swap(FRIDGES, 'NEW FOR COMPARISON:', 'NEW FOR COMPARISON: not found: no shop lists a full height model under £500'))).toBe('');
    expect(problem(swap(FRIDGES, 'NEW FOR COMPARISON:', 'NEW FOR COMPARISON: not found'))).toMatch(/must say why/);
    expect(problem(swap(FRIDGES, 'NEW FOR COMPARISON:', 'NEW FOR COMPARISON: Beko | £399'))).toMatch(/three parts/);
  });

  it('the nine-link rule: qty + 3 listing links pass, qty + 4 are refused', () => {
    // Qty 4: four picks, two reserves = 6 links. One more is 7 (= qty + 3), two more is 8.
    const plus = (n) => FRIDGES.replace('TRACK RECORD:', Array.from({ length: n }, (_, i) =>
      `Also seen: ${fb(100 + i)}`).join('\n') + '\nTRACK RECORD:');
    expect(problem(plus(1))).toBe('');
    expect(problem(plus(2))).toMatch(/8 listing links and a quantity of 4 allows 7/);
    expect(problem(plus(2))).toMatch(/the rest is your working, not Kevin's/);
    // The same listing written twice, or with a different query string, is one link.
    expect(problem(FRIDGES.replace('TRACK RECORD:', `Again: ${fb(1)}\nAgain: ${fb(1).replace('www.', '')}?ref=search\nTRACK RECORD:`))).toBe('');
    // Gumtree, eBay and Vinted count; a shop link does not.
    const mixed = FENCE.replace('PAY BY:', [
      'Seen: https://www.gumtree.com/p/a/1', 'Seen: https://www.ebay.co.uk/itm/2', 'Seen: https://www.vinted.co.uk/items/3',
      'Seen: https://www.diy.com/p/4', 'PAY BY:'].join('\n'));
    expect(problem(mixed)).toBe('');
    const four = mixed.replace('PAY BY:', 'Seen: https://www.gumtree.com/p/a/5\nPAY BY:');
    expect(problem(four)).toBe('');                         // qty 1: four listing links is the limit
    expect(problem(four.replace('PAY BY:', 'Seen: https://www.gumtree.com/p/a/6\nPAY BY:')))
      .toMatch(/5 listing links and a quantity of 1 allows 4/);
  });

  it('the SPEND pattern is the same one agent-dispatch.py uses', () => {
    const r = py(DISPATCH, `
spec2 = importlib.util.spec_from_file_location("f", ${JSON.stringify(FORMAT)})
f = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(f)
print(json.dumps([m.SPEND_LINE_RE.pattern == f.SPEND_LINE_RE.pattern, m.SPEND_LINE_RE.flags == f.SPEND_LINE_RE.flags]))`);
    expect(r).toEqual([true, true]);
  });
});

describe('a listing to buy without the shape', () => {
  it('the real 2 Nov card is refused by the backstop', () => {
    expect(backstop(NOV2)).toMatch(/must use the SOURCING card shape/);
    expect(problem(NOV2)).toBe('');                         // not a sourcing card, so the shape gate is quiet
  });
  it('fires for a marketplace link and a SPEND line', () => {
    expect(backstop(`Found one: ${fb(9)}\nSPEND: £40 (one-off)\n${CLOSING}`)).not.toBe('');
  });
  it('does not fire for a room advert link with no SPEND line', () => {
    expect(backstop('Advert is live: https://www.gumtree.com/p/rooms-to-rent/double-room-haverhill/1800000000\n' + CLOSING)).toBe('');
  });
  it('does not fire for a sourcing card', () => {
    expect(backstop(FRIDGES)).toBe('');
  });
});

// cmd_submit is driven for real. It reads the task twice before the sourcing gate (the report gate
// and the alert probe) and a third time straight after it (who approves), so a card that reaches the
// third read has passed every gate up to and including this one.
function submit(output, agent = RESPONSE) {
  return py(DISPATCH, `
import tempfile, os, types
m.require_role_agent_live = lambda *a, **k: None
class Reached(Exception): pass
reads = []
def reached(task):
    reads.append(task)
    if len(reads) >= 3:
        raise Reached("past the sourcing gate")
    return {"id": task, "fields": {}}
m.get_task = reached
m.patch_task = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("write in a test"))
fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(P["o"]); fh.close()
agent = P["agent"] or sorted(m.AGENTS)[0]
args = types.SimpleNamespace(task="recSourcingTest01", agent=agent, type="Admin", output_file=fh.name, tier1=False)
try:
    m.cmd_submit(args)
    out = {"result": "submitted"}
except SystemExit as e:
    out = {"result": "refused", "error": str(e)}
except Reached:
    out = {"result": "passed"}
finally:
    os.unlink(fh.name)
print(json.dumps(out))`, { o: output, agent });
}

describe('cmd_submit runs the sourcing gate', () => {
  it('refuses a bad sourcing card, printing the shape', () => {
    const r = submit(drop(FRIDGES, 'RESERVE 2:'));
    expect(r.result).toBe('refused');
    expect(r.error).toMatch(/refusing to submit recSourcingTest01: its SOURCING card is not in Kevin's shape: the RESERVE 2 line is missing/);
    expect(r.error).toMatch(/NEW FOR COMPARISON: <item>/);
  });
  it('a good sourcing card passes the gate', () => {
    expect(submit(FRIDGES).result).toBe('passed');
    expect(submit(FENCE).result).toBe('passed');
  });
  it('a sourcing card is judged whichever agent submits it', () => {
    expect(submit(drop(FENCE, 'SEARCHED:'), '').error).toMatch(/SEARCHED line is missing/);
  });
  it('the listing backstop applies to the Inbox Response agent only', () => {
    const r = submit(NOV2);
    expect(r.result).toBe('refused');
    expect(r.error).toMatch(/must use the SOURCING card shape/);
    expect(submit(NOV2, '').result).toBe('passed');        // another agent: the backstop is not its rule
  });
});

// cmd_complete is driven for real with get_task, patch_task and the list read stubbed.
function complete({ output, rows = [], readError = '', notBought = '', keepOpen = false }) {
  return py(DISPATCH, `
import types, io, contextlib
AF = m.AF
state = {AF["name"]: "INBOUND: Fridge freezers for Haverhill", AF["status"]: "Today",
         AF["approvalOutcome"]: "Approved as-is", AF["taskType"]: "Admin", AF["notes"]: "",
         AF["agentOutput"]: P["output"]}
m.get_task = lambda t: {"id": t, "createdTime": "2026-11-11T09:00:00.000Z", "fields": dict(state)}
def patch(t, f):
    state.update(f)
    return {"id": t}
m.patch_task = patch
m.ledger_append = lambda *a, **k: None
m.task_owes_certificate = lambda *a, **k: ""
m.task_owes_cost = lambda *a, **k: []
calls = []
def rows(task):
    calls.append(task)
    if P["readError"]:
        raise RuntimeError(P["readError"])
    return P["rows"]
m._preferred_rows_for_task = rows
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_complete(types.SimpleNamespace(task="reck5ZY5MoXulxJz8", keep_open=P["keepOpen"], note="", no_certificate="",
                                             evidence="", not_signed="", diary_not_written="", cost_not_written="",
                                             not_bought=P["notBought"]))
    print(json.dumps({"status": state.get(AF["status"]), "notes": state.get(AF["notes"]), "calls": calls}))
except SystemExit as e:
    print(json.dumps({"exit": str(e), "calls": calls}))`, { output, rows, readError, notBought, keepOpen });
}

describe('cmd_complete closes a sourcing card only once the buy is on the list', () => {
  it('refuses with no list row, giving the exact record command', () => {
    const r = complete({ output: FRIDGES });
    expect(r.exit).toMatch(/sourcing card and the Preferred Products list has no bought row from this task/);
    expect(r.exit).toMatch(/python3 scripts\/preferred-list\.py record --task reck5ZY5MoXulxJz8 --item "<item>" --bought-as <new\|second-hand> --price <n> --supplier "<who>" --link <url>/);
    expect(r.exit).toMatch(/--not-bought "<why>"/);
    expect(r.calls).toEqual(['reck5ZY5MoXulxJz8']);
  });
  it('closes with a bought row from this task', () => {
    for (const as of ['New', 'Second-hand']) {
      expect(complete({ output: FRIDGES, rows: [{ id: 'recPref1', fields: { 'Source Task': 'reck5ZY5MoXulxJz8', 'Bought As': as } }] }).status)
        .toBe('Completed');
    }
  });
  // The live list's first row is exactly this: the fridge freezer RULES, saved from the task before
  // anything was bought. A rules-only row must never close the card as if the buy had happened.
  it('a rules-only row ("Not bought yet") is not a buy and does not close the card', () => {
    const r = complete({ output: FRIDGES, rows: [{ id: 'recPref1', fields: { 'Source Task': 'reck5ZY5MoXulxJz8', 'Bought As': 'Not bought yet' } }] });
    expect(r.exit).toMatch(/no bought row from this task/);
    expect(complete({ output: FRIDGES, rows: [{ id: 'recPref1', fields: { 'Source Task': 'reck5ZY5MoXulxJz8' } }] }).exit)
      .toMatch(/no bought row from this task/);
  });
  it('closes with --not-bought and the reason on the record, without reading the list', () => {
    const r = complete({ output: FRIDGES, notBought: 'every seller sold before Kevin approved' });
    expect(r.status).toBe('Completed');
    expect(r.notes).toMatch(/NOT BOUGHT: every seller sold before Kevin approved/);
    expect(r.calls).toEqual([]);
  });
  it('refuses on a list read error and says the read failed', () => {
    const r = complete({ output: FRIDGES, readError: 'HTTP 503 from Airtable' });
    expect(r.exit).toMatch(/Preferred Products list could not be read.*HTTP 503 from Airtable/);
  });
  it('is untouched for a non-sourcing task', () => {
    const r = complete({ output: 'A plain report.\n' + CLOSING });
    expect(r.status).toBe('Completed');
    expect(r.calls).toEqual([]);
  });
  it('is untouched for a non-closing call, and refuses --not-bought with --keep-open', () => {
    const r = complete({ output: FRIDGES, keepOpen: true });
    expect(r.status).toBe('Today');
    expect(r.calls).toEqual([]);
    expect(complete({ output: FRIDGES, keepOpen: true, notBought: 'why' }).exit).toMatch(/--not-bought close a task, and --keep-open leaves it open/);
  });
});
