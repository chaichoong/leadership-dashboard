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

  it('the SOURCING line must carry the quantity as x <N> for', () => {
    expect(problem(swap(FENCE, 'SOURCING:', 'SOURCING: Fence posts for 4 Abington Place')))
      .toMatch(/SOURCING line must read <item> x <number> for <property>/);
    expect(problem(swap(FENCE, 'SOURCING:', 'SOURCING: Fence posts x 1')))
      .toMatch(/SOURCING line must read <item> x <number> for <property>/);
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

  it('the quantity is the first x <N> for, never a later size', () => {
    const rug = swap(FENCE, 'SOURCING:', 'SOURCING: Rug x 1 for lounge, 160 x 230');
    expect(problem(rug)).toBe('');
    expect(parse(rug).qty).toBe(1);
    expect(parse(rug).item).toBe('Rug');
  });

  const addBefore = (text, anchor, lines) => text.replace(anchor, lines.join('\n') + '\n' + anchor);

  it('the link cap: qty + 3 links pass, qty + 4 are refused, with the new sentence', () => {
    // Qty 4: four picks, two reserves and one comparison = 7 links (= qty + 3). One more is 8.
    expect(problem(FRIDGES)).toBe('');
    const over = addBefore(FRIDGES, 'TRACK RECORD:', [`Also seen: ${fb(100)}`]);
    expect(problem(over)).toMatch(/8 links and a quantity of 4 allows 7/);
    expect(problem(over)).toMatch(/name the sites you searched in words, and keep ruled-out items as words without links/);
  });

  it('the cap counts shop links too', () => {
    // FENCE (qty 1) has two links; two more shop links reach 4, a third is 5.
    const four = addBefore(FENCE, 'PAY BY:', ['Seen: https://www.diy.com/p/4', 'Seen: https://www.argos.co.uk/product/5']);
    expect(problem(four)).toBe('');
    expect(problem(addBefore(four, 'PAY BY:', ['Seen: https://ao.com/product/6'])))
      .toMatch(/5 links and a quantity of 1 allows 4/);
  });

  it('the cap ignores Gmail, Airtable and TopCashback links, and counts one page once', () => {
    const refs = addBefore(FENCE, 'PAY BY:', [
      'Thread: https://mail.google.com/mail/u/0/#all/1a0496b9df667238',
      'Task: https://airtable.com/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/reck5ZY5MoXulxJz8',
      'Rate page: https://www.topcashback.co.uk/screwfix/',
      'Again: https://www.screwfix.com/c/outdoor-gardening/fence-posts/cat000000?tc=search#reviews.',
      'Again: https://screwfix.com/c/outdoor-gardening/fence-posts/cat000000/',
      'Seen: https://www.diy.com/p/4', 'Seen: https://www.argos.co.uk/product/5']);
    expect(problem(refs)).toBe('');
  });

  it('pasted search links trip the cap: 6 searches plus 3 items for qty 1 is refused', () => {
    const card = [
      'SOURCING: Washing machine x 1 for 5 Dalham Place',
      'BASELINE: none on the list',
      `PICK: Bosch Serie 4 | second-hand | £120 | ${fb(1)}`,
      `RESERVE 1: Beko 8 kg | second-hand | £90 | ${fb(2)}`,
      `RESERVE 2: Hotpoint 7 kg | second-hand | £80 | ${fb(3)}`,
      'NEW FOR COMPARISON: not found: no shop page opened',
      'CASHBACK: n/a',
      'PROVEN: drum and door seal shown in photos',
      'NOT PROVEN: nothing',
      'SAVING: no baseline',
      'PAY BY: seller: cash on collection',
      'SEARCHED: https://www.facebook.com/marketplace/haverhill/search?query=washing%20machine '
        + 'https://www.gumtree.com/search?q=washing+machine https://www.ebay.co.uk/sch/i.html?_nkw=washing+machine '
        + 'https://www.vinted.co.uk/catalog?search_text=washing https://www.currys.co.uk/search?q=washing '
        + 'https://ao.com/search?q=washing',
      'SPEND: £120 (one-off)',
      CLOSING,
    ].join('\n');
    expect(problem(card)).toMatch(/9 links and a quantity of 1 allows 4/);
    expect(problem(card)).toMatch(/name the sites you searched in words/);
    expect(problem(swap(card, 'SEARCHED:', 'SEARCHED: Facebook Marketplace, Gumtree, eBay, Vinted, Currys, AO'))).toBe('');
  });

  it.each([
    ['bold with the colon inside', (l) => l.replace(/^([A-Z0-9 ]+):/, '**$1:**')],
    ['bold with the colon outside', (l) => l.replace(/^([A-Z0-9 ]+):/, '**$1**:')],
    ['a dash bullet', (l) => '- ' + l],
    ['a star bullet and bold', (l) => l.replace(/^([A-Z0-9 ]+):/, '* **$1:**')],
    ['a dot bullet and spaces', (l) => '  • ' + l],
    ['a quote marker', (l) => '> ' + l],
  ])('keys written with %s read like the plain form', (_label, dress) => {
    const KEYS = /^(SOURCING|BASELINE|PICK|RESERVE|NEW FOR COMPARISON|CASHBACK|PROVEN|NOT PROVEN|SAVING|PAY BY|SEARCHED|SPEND)/;
    const dressed = (text) => text.split('\n').map((l) => (KEYS.test(l) ? dress(l) : l)).join('\n');
    expect(parse(dressed(FRIDGES))).toEqual(parse(FRIDGES));
    expect(parse(dressed(FENCE))).toEqual(parse(FENCE));
    // Still judged: a dressed card missing a line is refused the same way.
    expect(problem(dressed(drop(FENCE, 'SEARCHED:')))).toMatch(/SEARCHED line is missing/);
  });

  it('a bold **SOURCING:** card is still judged, and a bold **SPEND:** still counts', () => {
    const bold = (text) => swap(text, 'SOURCING:', text.split('\n').find((l) => l.startsWith('SOURCING:'))
      .replace('SOURCING:', '**SOURCING:**'));
    expect(problem(bold(drop(FENCE, 'RESERVE 2:')))).toMatch(/RESERVE 2 line is missing/);
    expect(problem(swap(FENCE, 'SPEND:', '* **SPEND:** £148.90 (one-off)'))).toBe('');
    expect(parse(swap(FENCE, 'SPEND:', '* **SPEND:** £148.90 (one-off)')).spend).toBe(148.9);
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
  it('does not fire for a sourcing card, even a bold one', () => {
    expect(backstop(FRIDGES)).toBe('');
    expect(backstop(FRIDGES.replace('SOURCING:', '**SOURCING:**'))).toBe('');
  });
  it.each([
    ['an eBay order page', 'https://www.ebay.co.uk/vod/FetchOrderDetails?itemid=1234&transid=5678'],
    ['a Gumtree post-an-advert page', 'https://www.gumtree.com/postad'],
    ['a search', 'https://www.facebook.com/marketplace/haverhill/search?query=fridge%20freezer'],
  ])('does not fire for %s with a SPEND line', (_label, url) => {
    expect(backstop(`See: ${url}\nSPEND: £40 (one-off)\n${CLOSING}`)).toBe('');
  });
  it('fires on an item page on any subdomain, with a bulleted bold SPEND line', () => {
    expect(backstop(`See: https://m.ebay.co.uk/itm/123456\n- **SPEND:** £40 (one-off)\n${CLOSING}`)).not.toBe('');
    expect(backstop(`See: https://www.vinted.co.uk/items/987-lamp\nSPEND: £12 (one-off)\n${CLOSING}`)).not.toBe('');
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

// The whole submit, with Airtable stubbed: get_task returns what patch_task wrote, as Airtable would.
// The task is inbound so a CHECKED trigger=none report would normally file itself as Completed.
function fullSubmit(output) {
  return py(DISPATCH, `
import tempfile, os, types, io, contextlib
AF = m.AF
state = {AF["name"]: "INBOUND: Fence posts for 4 Abington Place", AF["inboundTask"]: True, AF["status"]: "Today"}
m.get_task = lambda t: {"id": t, "createdTime": "2026-11-11T09:00:00.000Z", "fields": dict(state)}
def patch(t, f):
    state.update(f)
    return {"id": t}
m.patch_task = patch
fh = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False); fh.write(P["o"]); fh.close()
args = types.SimpleNamespace(task="recSourcingTest01", agent=sorted(m.AGENTS)[0], type="Admin", output_file=fh.name, tier1=False)
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_submit(args)
    out = {"result": "submitted"}
except SystemExit as e:
    out = {"result": "refused", "error": str(e)}
finally:
    os.unlink(fh.name)
out["status"] = str(state.get(AF["status"]))
out["notes"] = str(state.get(AF["notes"]) or "")
out["mark"] = m.SOURCING_SUBMITTED_MARK
print(json.dumps(out))`, { o: output });
}

const NOTHING_TO_DECIDE = [
  'CHECKED: handled=no; roy=no; machine=no; open-task=no; trigger=none',
  '',
  FENCE.replace(CLOSING, 'TRACK RECORD: none found (searched tasks and Gmail for ref "fence posts")'),
  '',
  '**Carrying this out will involve:** nothing happens on approval; this is a report.',
].join('\n');

describe('a submitted sourcing card goes to Kevin and marks the task', () => {
  it('a sourcing card with trigger=none does not file itself, and the submit stamp is written', () => {
    const r = fullSubmit(NOTHING_TO_DECIDE);
    expect(r.result).toBe('submitted');
    expect(r.status).toBe('Approval');
    expect(r.notes).toContain(r.mark);
    expect(r.mark).toBe('SOURCING CARD SUBMITTED');
  });
  it('CONTROL: the same report without the SOURCING line files itself, with no stamp', () => {
    const plain = NOTHING_TO_DECIDE.split('\n').filter((l) => !l.startsWith('SOURCING:')).join('\n')
      .replace(/^SPEND:.*$/m, '');
    const r = fullSubmit(plain);
    expect(r.status).toBe('Completed');
    expect(r.notes).not.toContain('SOURCING CARD SUBMITTED');
  });
});

// cmd_complete is driven for real with get_task, patch_task and the list read stubbed.
function complete({ output, rows = [], readError = '', notBought = '', keepOpen = false, notes = '' }) {
  return py(DISPATCH, `
import types, io, contextlib
AF = m.AF
state = {AF["name"]: "INBOUND: Fridge freezers for Haverhill", AF["status"]: "Today",
         AF["approvalOutcome"]: "Approved as-is", AF["taskType"]: "Admin", AF["notes"]: P["notes"],
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
m._preferred_bought_rows_for_task = rows
try:
    with contextlib.redirect_stdout(io.StringIO()):
        m.cmd_complete(types.SimpleNamespace(task="reck5ZY5MoXulxJz8", keep_open=P["keepOpen"], note="", no_certificate="",
                                             evidence="", not_signed="", diary_not_written="", cost_not_written="",
                                             not_bought=P["notBought"]))
    print(json.dumps({"status": state.get(AF["status"]), "notes": state.get(AF["notes"]), "calls": calls}))
except SystemExit as e:
    print(json.dumps({"exit": str(e), "calls": calls}))`, { output, rows, readError, notBought, keepOpen, notes });
}

describe('cmd_complete closes a sourcing card only once the buy is on the list', () => {
  it('refuses with no list row, giving the exact record command', () => {
    const r = complete({ output: FRIDGES });
    expect(r.exit).toMatch(/sourcing card and the Preferred Products list has no bought row from this task/);
    expect(r.exit).toMatch(/python3 scripts\/preferred-list\.py record --task reck5ZY5MoXulxJz8 --item "<item>" --bought-as <new\|second-hand> --price <n> --supplier "<who>" --link <url>/);
    expect(r.exit).toMatch(/--not-bought "<why>"/);
    expect(r.calls).toEqual(['reck5ZY5MoXulxJz8']);
  });
  // What counts as bought is preferred-list.py's bought_rows_for_task, defined once there; the gate
  // closes on any row it returns and never re-filters.
  it('closes with a bought row from this task', () => {
    expect(complete({ output: FRIDGES, rows: [{ id: 'recPref1', fields: { 'Source Task': 'reck5ZY5MoXulxJz8' } }] }).status)
      .toBe('Completed');
  });
  it('fires on a task whose output is no longer a sourcing card but whose Notes carry the submit mark', () => {
    const notes = '[11 Nov 2026 10:13 — agent-dispatch] SOURCING CARD SUBMITTED (round 1): closes only on a bought row or --not-bought';
    const r = complete({ output: 'A plain revised report.\n' + CLOSING, notes });
    expect(r.exit).toMatch(/no bought row from this task/);
    expect(r.calls).toEqual(['reck5ZY5MoXulxJz8']);
    expect(complete({ output: 'A plain revised report.\n' + CLOSING, notes, notBought: 'Kevin chose not to buy' }).status)
      .toBe('Completed');
  });
  it('the loader is _preferred_bought_rows_for_task and calls bought_rows_for_task in preferred-list.py', () => {
    const r = py(DISPATCH, `
import tempfile, os
d = tempfile.mkdtemp()
fake = os.path.join(d, "preferred-list.py")
open(fake, "w").write("def bought_rows_for_task(t):\\n    return [{'id': 'recBought', 'task': t}]\\n"
                      "def rows_for_task(t):\\n    raise AssertionError('the any-row reader was called')\\n")
real = importlib.util.spec_from_file_location
seen = []
def redirect(name, path, *a, **k):
    seen.append(os.path.basename(path))
    return real(name, fake if os.path.basename(path) == "preferred-list.py" else path, *a, **k)
importlib.util.spec_from_file_location = redirect
try:
    rows = m._preferred_bought_rows_for_task("reck5ZY5MoXulxJz8")
finally:
    importlib.util.spec_from_file_location = real
print(json.dumps({"rows": rows, "seen": seen, "old": hasattr(m, "_preferred_rows_for_task")}))`);
    expect(r.rows).toEqual([{ id: 'recBought', task: 'reck5ZY5MoXulxJz8' }]);
    expect(r.seen).toEqual(['preferred-list.py']);
    expect(r.old).toBe(false);
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
