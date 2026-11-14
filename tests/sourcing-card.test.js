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
  'SOURCING: Fridge freezer, full height | 4 | 13 Chedburgh Place and three more Haverhill HMOs',
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
  'SOURCING: Fence posts and postcrete | 1 | 4 Abington Place',
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
    ['SPEND:', /no plain SPEND line/],
    ['PICK', /no PICK line/],
  ])('removing the %s line is refused, naming it', (prefix, msg) => {
    expect(problem(drop(FRIDGES, prefix))).toMatch(msg);
  });

  it('an empty required line is refused like a missing one', () => {
    expect(problem(swap(FRIDGES, 'PROVEN:', 'PROVEN:'))).toMatch(/PROVEN line is missing or empty/);
  });

  it('the SOURCING line is item | quantity | property; anything else is refused showing the form', () => {
    for (const line of ['SOURCING: Fence posts x 1 for 4 Abington Place', 'SOURCING: Fence posts | 1',
      'SOURCING: Fence posts | one | 4 Abington Place', 'SOURCING: Fence posts | 0 | 4 Abington Place',
      'SOURCING: Fence posts | 1 | ']) {
      expect(problem(swap(FENCE, 'SOURCING:', line))).toMatch(/SOURCING: <item> \| <quantity> \| <property>/);
    }
  });

  it('the Rug case: a size inside the item never changes the quantity', () => {
    const rug = swap(FENCE, 'SOURCING:', 'SOURCING: Rug 160 x 230 | 1 | 14 Wentworth Terrace lounge');
    expect(problem(rug)).toBe('');
    expect(parse(rug)).toMatchObject({ qty: 1, item: 'Rug 160 x 230', property: '14 Wentworth Terrace lounge' });
  });

  it.each([
    ['a link that is not http', 'PICK: Posts | new | £148.90 | www.screwfix.com/posts', /link on PICK must be one http or https address/],
    ['a zero price', 'PICK: Posts | new | £0 | https://www.screwfix.com/p/1', /more than £0/],
    ['a price with no £', 'PICK: Posts | new | 148.90 | https://www.screwfix.com/p/1', /write the price plain, for example £70\.00/],
    ['a bold price', 'PICK: Posts | new | **£148.90** | https://www.screwfix.com/p/1', /write the price plain, for example £70\.00/],
    ['a bad kind', 'PICK: Posts | refurbished | £148.90 | https://www.screwfix.com/p/1', /must be new or second-hand/],
    ['three fields', 'PICK: Posts | new | £148.90', /4 parts split by ' \| '; it has 3/],
  ])('a PICK with %s is refused', (_label, line, msg) => {
    expect(problem(swap(FENCE, 'PICK:', line))).toMatch(msg);
  });

  it('PICK may repeat up to the quantity, plain or numbered; one more is refused', () => {
    const twoQty = swap(FENCE, 'SOURCING:', 'SOURCING: Fence posts | 2 | 4 Abington Place');
    const plainTwice = swap(twoQty.replace(/^(PICK: .*)$/m, '$1\nPICK: Posts again | new | £150 | https://www.diy.com/p/1'),
      'SPEND:', 'SPEND: £298.90 (one-off)');
    expect(problem(plainTwice)).toBe('');
    expect(problem(plainTwice.replace(/^(PICK: .*)$/m, '$1\nPICK 3: More | new | £150 | https://www.diy.com/p/2')))
      .toMatch(/3 PICK lines for a quantity of 2/);
  });

  // THE ALARM TEST (Kevin, 12 Nov 2026). A rehearsal card for six mains smoke alarms and one heat
  // alarm passed this check with UNIT prices on its PICK lines and a total nothing had added up. The
  // fixture is that card's own lines. SPEND is now the sum of the PICK lines, to the penny.
  const ALARMS = [
    'SOURCING: Mains smoke alarm and heat alarm, wireless interlinked | 7 | property not named (test request)',
    'BASELINE: none on the list',
    'PICK 1: FireAngel Pro Connected FP1640W2-R mains smoke alarm, per unit | new | £63.99 | https://www.amazon.co.uk/dp/B07WQY765Q',
    'PICK 2: FireAngel Pro Connected FP1740W2-R mains heat alarm, incl £4.20 delivery | new | £87.55 | https://www.safelincs.co.uk/product/fireangel-pro-connected-fp1740w2r-mains-powered-heat-alarm',
    'RESERVE 1: Aico Ei3016RF mains smoke alarm | new | £112.27 | https://www.safelincs.co.uk/mains-radio-interlinked-optical-smoke-alarm-lithium-backup-ei3016rf',
    'RESERVE 2: Aico Ei3014RF mains heat alarm | new | £124.42 | https://www.safelincs.co.uk/mains-radio-interlinked-heat-alarm-lithium-backup-ei3014rf',
    'CASHBACK: none offered',
    'PROVEN: both 230V mains with a sealed 10-year back-up and the radio link built in',
    'NOT PROVEN: the property and the real number of alarms',
    'SAVING: no baseline',
    'PAY BY: shop checkout',
    'SEARCHED: Amazon, Safelincs, Gumtree, Facebook Marketplace, Vinted',
    'SPEND: £471.49 (one-off)',
    '',
    CLOSING,
  ].join('\n');
  const ALARMS_FIXED = swap(ALARMS, 'PICK 1:',
    'PICK 1: FireAngel Pro Connected FP1640W2-R mains smoke alarm, x6 at £63.99 each | new | £383.94 | https://www.amazon.co.uk/dp/B07WQY765Q');

  it('the alarm card as first written is refused: unit prices on the lines, a total that is not their sum', () => {
    const msg = problem(ALARMS);
    expect(msg).toMatch(/SPEND reads £471\.49 but the PICK lines add up to £151\.54/);
    expect(msg).toMatch(/full amount for that line/);
  });

  it('the same card with the full amount on each PICK line passes, and spend is the sum', () => {
    expect(problem(ALARMS_FIXED)).toBe('');
    const p = parse(ALARMS_FIXED);
    expect(p.spend).toBe(471.49);
    expect(Math.round(p.picks.reduce((s, x) => s + x.price * 100, 0))).toBe(47149);
  });

  it.each([
    ['a penny over', 'SPEND: £471.50 (one-off)', /SPEND reads £471\.50 but the PICK lines add up to £471\.49/],
    ['a penny under', 'SPEND: £471.48 (one-off)', /SPEND reads £471\.48 but the PICK lines add up to £471\.49/],
    ['one line left out of the total', 'SPEND: £383.94 (one-off)', /add up to £471\.49/],
    ['the reserves counted in', 'SPEND: £708.18 (one-off)', /add up to £471\.49/],
  ])('a total that is %s is refused', (_label, line, msg) => {
    expect(problem(swap(ALARMS_FIXED, 'SPEND:', line))).toMatch(msg);
  });

  it('the fridge card with a wrong total is refused, and names both figures', () => {
    expect(problem(swap(FRIDGES, 'SPEND:', 'SPEND: £300 (one-off)')))
      .toMatch(/SPEND reads £300\.00 but the PICK lines add up to £260\.00/);
  });

  it('the sum is done in pence: £0.10 and £0.20 make £0.30, and a comma in thousands reads right', () => {
    const pennies = swap(swap(swap(FENCE, 'SOURCING:', 'SOURCING: Washers | 2 | 4 Abington Place'),
      'PICK:', 'PICK 1: Washer | new | £0.10 | https://www.toolstation.com/p/1\nPICK 2: Washer | new | £0.20 | https://www.toolstation.com/p/2'),
    'SPEND:', 'SPEND: £0.30 (one-off)');
    expect(problem(pennies)).toBe('');
    const big = swap(swap(FENCE, 'PICK:', 'PICK: Boiler | new | £1,250.50 | https://www.wickes.co.uk/p/1'),
      'SPEND:', 'SPEND: £1,250.50 (one-off)');
    expect(problem(big)).toBe('');
    expect(problem(swap(big, 'SPEND:', 'SPEND: £1,250 (one-off)'))).toMatch(/SPEND reads £1,250\.00 but the PICK lines add up to £1,250\.50/);
  });

  // Review, 12 Nov 2026: two ways a wrong total could still pass. A PICK line the key pattern does not
  // read is left out of the sum, and the dispatcher reads the FIRST spend-like line, in any case.
  it.each([
    ['PICK2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['Pick 2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['PICK 2 : Posts again | new | £150 | https://www.diy.com/p/1'],
    ['- PICK 2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['**PICK 2:** Posts again | new | £150 | https://www.diy.com/p/1'],
    ['  PICK 2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['PICK 2 (reserve promoted): Posts again | new | £150 | https://www.diy.com/p/1'],
    ['1. PICK 2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['PICK #2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['PICKS 2: Posts again | new | £150 | https://www.diy.com/p/1'],
    ['PICK 2 – Posts again | second-hand | £150 | https://www.diy.com/p/1'],
    ['PICK 2： Posts again | New | 150 | https://www.diy.com/p/1'],
    ['Also worth a look: Posts again | **new** | £150 | https://www.diy.com/p/1'],
    ['RESERVE one: Posts again | new | £150 | https://www.diy.com/p/1'],
  ])('a line written like an item that does not start with the plain key is refused: %s', (line) => {
    const twoQty = swap(FENCE, 'SOURCING:', 'SOURCING: Fence posts | 2 | 4 Abington Place');
    const card = twoQty.replace(/^(PICK: .*)$/m, `$1\n${line}`);
    expect(problem(card)).toMatch(/written like an item but does not start with the plain key/);
    // CONTROL: the same second line written plain is counted, so the old total is now refused.
    const plain = twoQty.replace(/^(PICK: .*)$/m, '$1\nPICK 2: Posts again | new | £150 | https://www.diy.com/p/1');
    expect(problem(plain)).toMatch(/SPEND reads £148\.90 but the PICK lines add up to £298\.90/);
  });

  it('prose is not an item line: sentences about picking, pick-up, new and second-hand all pass', () => {
    const card = FENCE.replace('SAVING: no baseline', ['SAVING: no baseline',
      'Pick: the Screwfix posts are cheapest.', 'Picked: the cheaper of the two.', 'Pick-up: Roy collects on Friday.',
      'Ruled out: three second-hand lots, none new enough | all over 40 km away.',
      '- 2 Nov: card sent, new posts priced at £148.90'].join('\n'));
    expect(problem(card)).toBe('');
  });

  // Review pass 3: `preferred-list.py list` prints a row with the same bars (key | item | £price |
  // Bought As | ...), and the agent's rules call that row the BASELINE. A line under any plain key
  // is accounted for, so the pasted row passes, and the total is still checked.
  it('a preferred-list row pasted as the BASELINE passes, and the total is still checked', () => {
    const row = 'BASELINE: fence-posts | Fence posts | £139.00 | New | Screwfix | https://www.screwfix.com/p/1 | last bought 2026-10-02 | Active';
    const card = swap(FENCE, 'BASELINE:', row);
    expect(problem(card)).toBe('');
    expect(problem(swap(card, 'BASELINE:', row.replace('| New |', '| Second-hand |')))).toBe('');
    expect(problem(swap(card, 'SPEND:', 'SPEND: £139.00 (one-off)')))
      .toMatch(/SPEND reads £139\.00 but the PICK lines add up to £148\.90/);
    // CONTROL: the same row with no key in front of it is still refused.
    expect(problem(FENCE.replace('SAVING: no baseline', `SAVING: no baseline\n${row.replace('BASELINE: ', '')}`)))
      .toMatch(/written like an item but does not start with the plain key/);
  });

  it.each([
    [' SPEND: £5 per unit'],
    ['Spend: £5 a month'],
    ['spend: £5'],
  ])('a spend-like line above the SPEND line, which the dispatcher would read first, is refused: %s', (line) => {
    const card = FENCE.replace('SAVING: no baseline', `SAVING: no baseline\n${line}`);
    expect(problem(card)).toMatch(/a line above the SPEND line also reads as a spend \(£5\)/);
    // The dispatcher's own reader agrees it would have taken £5, not £148.90.
    const read = py(DISPATCH, 'print(json.dumps(m.spend_declared(P["o"])))', { o: card });
    expect(read[0]).toBe(5);
  });

  it('a spend-like line BELOW the SPEND line changes nothing the dispatcher reads, and passes', () => {
    const card = FENCE.replace(CLOSING, `Spend: nothing more is due.\n${CLOSING}`);
    expect(problem(card)).toBe('');
    const read = py(DISPATCH, 'print(json.dumps(m.spend_declared(P["o"])))', { o: FENCE });
    expect(read).toEqual([148.9, false]);
  });

  it('any other key written twice is refused', () => {
    expect(problem(FENCE.replace('SAVING: no baseline', 'SAVING: no baseline\nSAVING: £5'))).toMatch(/SAVING line is written twice/);
  });

  it('a malformed reserve or comparison is refused; none found and not found: why are accepted', () => {
    expect(problem(swap(FENCE, 'RESERVE 1:', 'RESERVE 1: Toolstation | new | £152'))).toMatch(/RESERVE 1 must read/);
    expect(problem(swap(FRIDGES, 'NEW FOR COMPARISON:', 'NEW FOR COMPARISON: not found: no shop lists a full height model under £500'))).toBe('');
    expect(problem(swap(FRIDGES, 'NEW FOR COMPARISON:', 'NEW FOR COMPARISON: not found'))).toMatch(/must say why/);
    expect(problem(swap(FRIDGES, 'NEW FOR COMPARISON:', 'NEW FOR COMPARISON: Beko | £399'))).toMatch(/3 parts/);
  });

  const addBefore = (text, anchor, lines) => text.replace(anchor, lines.join('\n') + '\n' + anchor);

  it('the cap: qty + 3 marketplace item links pass, qty + 4 are refused', () => {
    // Qty 4: four picks and two reserves = 6 item links. One more is 7 (= qty + 3), two more is 8.
    const one = addBefore(FRIDGES, 'TRACK RECORD:', [`Ruled out: ${fb(100)}`]);
    expect(problem(one)).toBe('');
    const two = addBefore(one, 'TRACK RECORD:', [`Ruled out: ${fb(101)}`]);
    expect(problem(two)).toMatch(/8 marketplace listing links and a quantity of 4 allows 7/);
    expect(problem(two)).toMatch(/keep ruled-out listings as words without links/);
  });

  it('shop, spec, photo and track record links are not counted, and one listing written several ways is one', () => {
    const extra = addBefore(FENCE, 'PAY BY:', [
      'Spec: https://www.screwfix.com/p/fence-post-2-4m/12345#specifications',
      'Photo: https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view',
      'Thread: https://mail.google.com/mail/u/0/#all/1a0496b9df667238',
      'Task: https://airtable.com/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/reck5ZY5MoXulxJz8',
      'Shop: https://www.diy.com/p/4', 'Shop: https://www.argos.co.uk/product/5', 'Shop: https://ao.com/product/6',
    ]);
    expect(problem(extra)).toBe('');
    // FRIDGES at its limit, with pick 1 repeated in the Approve line on m.facebook.com with a query string.
    const repeat = FRIDGES.replace('Nothing is bought.**', `Pick 1 is ${fb(1).replace('www.', 'm.')}?ref=share. Nothing is bought.**`);
    expect(problem(addBefore(repeat, 'TRACK RECORD:', [`Ruled out: ${fb(100)}`]))).toBe('');
  });

  it('short item links count: fb.me, facebook.com/share and ebay.us', () => {
    const shorts = addBefore(FRIDGES, 'TRACK RECORD:', ['https://fb.me/abc123', 'https://www.facebook.com/share/1Xyz/', 'https://ebay.us/q1W2e3']);
    expect(problem(shorts)).toMatch(/9 marketplace listing links and a quantity of 4 allows 7/);
  });

  it('a pasted search does not count, but the item links beside it do', () => {
    const card = addBefore(swap(FENCE, 'SEARCHED:', 'SEARCHED: https://www.gumtree.com/search?q=posts https://www.ebay.co.uk/sch/i.html?_nkw=posts'),
      'PAY BY:', ['https://www.gumtree.com/p/a/1', 'https://www.ebay.co.uk/itm/2', 'https://www.vinted.co.uk/items/3', 'https://www.gumtree.com/p/a/4']);
    expect(problem(card)).toBe('');
    expect(problem(addBefore(card, 'PAY BY:', ['https://www.gumtree.com/p/a/5']))).toMatch(/5 marketplace listing links and a quantity of 1 allows 4/);
  });

  it.each([
    ['bold with the colon inside', '**SOURCING:** Fence posts | 1 | 4 Abington Place'],
    ['bold with the colon outside', '**SOURCING**: Fence posts | 1 | 4 Abington Place'],
    ['a dash bullet', '- SOURCING: Fence posts | 1 | 4 Abington Place'],
    ['a star bullet and bold', '* **SOURCING**: Fence posts | 1 | 4 Abington Place'],
    ['a dot bullet', '• SOURCING: Fence posts | 1 | 4 Abington Place'],
    ['a leading space', ' SOURCING: Fence posts | 1 | 4 Abington Place'],
  ])('a SOURCING key written with %s is refused: write the keys plain', (_label, line) => {
    const card = swap(FENCE, 'SOURCING:', line);
    expect(problem(card)).toBe("write the SOURCING card's keys plain, at the start of the line, with no bullets and no bold");
  });

  it('other dressed keys on a real card are not keys, so the card is refused for the missing line', () => {
    expect(problem(swap(FENCE, 'SEARCHED:', '- SEARCHED: Screwfix, Toolstation, B&Q'))).toMatch(/SEARCHED line is missing/);
    expect(problem(swap(FENCE, 'SPEND:', '**SPEND:** £150'))).toMatch(/no plain SPEND line/);
    expect(problem(swap(FENCE, 'SPEND:', 'Spend: £150 (one-off)'))).toMatch(/no plain SPEND line/);
    expect(problem(swap(FENCE, 'SAVING:', 'Saving: no baseline'))).toMatch(/SAVING line is missing/);
    expect(problem(swap(FENCE, 'SOURCING:', 'Sourcing: Fence posts | 1 | 4 Abington Place'))).toBe('');   // not a card at all
  });

  it('prose is never a key: Sourcing in an email card, quoted seller lines and ruled-out bullets', () => {
    const email = ['TO: supplier@example.com', 'SUBJECT: Parts', '---', '- Sourcing: we need three quotes by Friday',
      '> Sourcing: we can source the part', 'Thanks', CLOSING].join('\n');
    expect(problem(email)).toBe('');
    expect(backstop(email)).toBe('');
    const chatty = addBefore(FRIDGES, 'TRACK RECORD:', ['> Saving: you a trip, I can deliver', '- Searched: Vinted too, nothing tall',
      'Saving: words in a sentence', 'Sourcing: more words']);
    expect(problem(chatty)).toBe('');
    expect(parse(chatty).qty).toBe(4);
  });

  it('the SPEND pattern behaves the same as agent-dispatch.py on sample lines', () => {
    const r = py(DISPATCH, `
spec2 = importlib.util.spec_from_file_location("f", ${JSON.stringify(FORMAT)})
f = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(f)
lines = ["SPEND: £70 (one-off)", "SPEND: £1,250.50/month", "  spend: 40 per week", "SPEND: £80 a year",
         "**SPEND:** £150", "- SPEND: £20", "SPEND: none", "SPEND:£9.99", "Nothing to spend"]
read = lambda rx, l: (lambda mm: [mm.group("amount"), mm.group("recurring")] if mm else None)(rx.search(l))
print(json.dumps([[read(m.SPEND_LINE_RE, l), read(f.SPEND_LINE_RE, l)] for l in lines]))`);
    for (const [a, b] of r) expect(b).toEqual(a);
    expect(r[0][0]).toEqual(['70', null]);
    expect(r[4][0]).toBeNull();                              // dispatch does not read a bold SPEND, so neither does the card
  });
});

describe('a listing to buy without the shape', () => {
  it('the real 2 Nov card is refused by the backstop', () => {
    expect(backstop(NOV2)).toMatch(/must use the SOURCING card shape/);
    expect(problem(NOV2)).toBe('');                         // not a sourcing card, so the shape gate is quiet
  });
  it('fires for a marketplace item link and a SPEND line', () => {
    expect(backstop(`Found one: ${fb(9)}\nSPEND: £40 (one-off)\n${CLOSING}`)).not.toBe('');
  });
  it('does not fire for a room advert link with no SPEND line', () => {
    expect(backstop('Advert is live: https://www.gumtree.com/p/rooms-to-rent/double-room-haverhill/1800000000\n' + CLOSING)).toBe('');
  });
  it('does not fire for a sourcing card', () => {
    expect(backstop(FRIDGES)).toBe('');
  });
  it.each([
    ['an eBay order page', 'https://www.ebay.co.uk/vod/FetchOrderDetails?itemid=1234&transid=5678'],
    ['a Gumtree post-an-advert page', 'https://www.gumtree.com/postad'],
    ['a search', 'https://www.facebook.com/marketplace/haverhill/search?query=fridge%20freezer'],
  ])('does not fire for %s with a SPEND line', (_label, url) => {
    expect(backstop(`See: ${url}\nSPEND: £40 (one-off)\n${CLOSING}`)).toBe('');
  });
  it.each([
    'https://m.ebay.co.uk/itm/123456', 'https://www.vinted.co.uk/items/987-lamp', 'https://fb.me/abc123',
    'https://ebay.us/q1W2e3', 'https://mobile.facebook.com/marketplace/item/42/',
  ])('fires on the item link %s', (url) => {
    expect(backstop(`See: ${url}\nSPEND: £40 (one-off)\n${CLOSING}`)).not.toBe('');
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
function fullSubmit(output, forceLevelA = false) {
  return py(DISPATCH, `
import tempfile, os, types, io, contextlib
AF = m.AF
acted = []
if P["forceA"]:
    real_level = m.decision_level
    m.decision_level = lambda *a, **k: dict(real_level(*a, **k), level=m.AUTONOMY_ACT, category="close",
                                             carry="close", why="forced Level A in a test")
    def hwk(args, output, trec, level, to_attach):
        acted.append(level.get("why"))
        return 0
    m.handle_without_kevin = hwk
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
out["acted"] = acted
print(json.dumps(out))`, { o: output, forceA: forceLevelA });
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
  it('a sourcing card that would otherwise be a Level A act still lands as a card', () => {
    const asked = NOTHING_TO_DECIDE.replace('trigger=none', 'trigger=kevin-asked');
    const r = fullSubmit(asked, true);
    expect(r.acted).toEqual([]);
    expect(r.status).toBe('Approval');
    // CONTROL: the same output without the SOURCING line takes the Level A path.
    const plain = asked.split('\n').filter((l) => !l.startsWith('SOURCING:')).join('\n').replace(/^SPEND:.*$/m, '');
    expect(fullSubmit(plain, true).acted).toEqual(['forced Level A in a test']);
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
                                             not_bought=P["notBought"],
                                             until=(m.datetime.now(m.LONDON).date() + m.timedelta(days=2)).isoformat() if P["keepOpen"] else ""))
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
  it('a track-record copy of the stamp in Notes (a bulleted line) does not fire the gate', () => {
    const notes = 'TRACK RECORD:\n- 11 Nov 2026 10:13 — agent-dispatch: [11 Nov 2026 10:13 — agent-dispatch] SOURCING CARD SUBMITTED (round 1)'
      + '\nAlso mentions SOURCING CARD SUBMITTED in a sentence.';
    const r = complete({ output: 'A plain report.\n' + CLOSING, notes });
    expect(r.status).toBe('Completed');
    expect(r.calls).toEqual([]);
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
