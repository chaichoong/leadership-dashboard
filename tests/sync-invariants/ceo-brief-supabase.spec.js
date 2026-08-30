// CEO Brief (per-tenant Supabase page) — render and save invariants.
//
// ceo-brief-supabase.html reads public.ceo_briefs (written by the ceo-brief-tenants
// worker) and writes its setup to app_settings key 'ceo_brief'. The setup form is
// rendered FROM js/ceo-brief-defaults.mjs, so this spec asserts that EVERY question
// in SETUP_QUESTIONS appears as a field: a hand-typed form would drift from the
// worker the first time someone added a question.
//
// Hermetic: supabase-js (jsdelivr) is replaced by a small stand-in that issues
// PostgREST-shaped fetches, and the Supabase host is intercepted, so the assertions
// see the real request the page produces (table, key, body) without a backend.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts } = require('./helpers');

const SB_HOST = '**ptkyhzlsvijcwyovgrgv.supabase.co/**';
const STORAGE_KEY = '_dlr_sb_app';

// Minimal stand-in for @supabase/supabase-js v2. Mirrors only what the page uses:
// auth.getSession (reads the shell's storage key, like the real client) and a query
// builder for select/eq/order/limit/maybeSingle/upsert that fetches /rest/v1/<table>.
const SUPABASE_SHIM = `
  window.supabase = {
    createClient: function(url, key, opts){
      const storageKey = (opts && opts.auth && opts.auth.storageKey) || 'sb';
      const auth = {
        getSession: async () => { try { const s = JSON.parse(localStorage.getItem(storageKey) || 'null'); return { data: { session: s } }; } catch (e) { return { data: { session: null } }; } },
        signInWithPassword: async () => ({ error: { message: 'stub: not signed in' } }),
        signOut: async () => ({}),
      };
      function from(table){
        const q = { table, params: [], single: false, method: 'GET', body: null, headers: {} };
        const b = {
          select(cols){ q.params.push('select=' + encodeURIComponent(cols || '*')); return b; },
          eq(col, val){ q.params.push(col + '=eq.' + encodeURIComponent(val)); return b; },
          order(col, o){ q.params.push('order=' + col + '.' + ((o && o.ascending === false) ? 'desc' : 'asc')); return b; },
          limit(n){ q.params.push('limit=' + n); return b; },
          maybeSingle(){ q.single = true; return b; },
          upsert(row, o){ q.method = 'POST'; q.body = row; q.headers['Prefer'] = 'resolution=merge-duplicates'; if (o && o.onConflict) q.params.push('on_conflict=' + o.onConflict); return b; },
          then(res, rej){
            const u = url + '/rest/v1/' + table + (q.params.length ? '?' + q.params.join('&') : '');
            return fetch(u, { method: q.method, headers: Object.assign({ 'Content-Type': 'application/json', apikey: key }, q.headers), body: q.body ? JSON.stringify(q.body) : undefined })
              .then(async r => {
                if (!r.ok) return { data: null, error: { message: 'HTTP ' + r.status } };
                const text = await r.text(); let data = text ? JSON.parse(text) : null;
                if (q.single && Array.isArray(data)) data = data[0] || null;
                return { data, error: null };
              }).then(res, rej);
          }
        };
        return b;
      }
      return { auth, from };
    }
  };
`;

function londonTodayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

const ENABLED_CFG = {
  enabled: true, timezone: 'Europe/London', send_hour: 9,
  founder: { name: 'Sam Tester', business: 'Tester Ltd', what_it_sells: 'Bookkeeping, £250 a month', wheelhouse: ['client calls'] },
  quarter: { context: 'Sign three clients.' },
};

function briefRow(overrides) {
  return Object.assign({
    brief_date: londonTodayISO(),
    one_thing: 'Call the two warm leads before lunch',
    first_step: 'Open the CRM and ring Dana first',
    why: 'Two signed clients close the quarter target',
    ignore_today: 'The website copy\nThe new logo',
    board_flags: 'Finance: cash floor is thin this week',
    handed_off: 'Invoice chasing to worker-writer\nSupplier quotes to Jo',
    money_light: 'green', safe_to_act: 1250.5, fallback: false,
  }, overrides || {});
}

// Stub the CDN script, the Supabase host and the shell's session. `opts.cfg` is what
// app_settings holds (null = no row); `opts.briefs` is the ceo_briefs result.
async function setup(page, opts) {
  const capture = { upserts: [] };
  await stubExternalHosts(page);
  await page.route('**cdn.jsdelivr.net/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_SHIM });
  });
  await page.route(SB_HOST, async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('/rest/v1/app_settings')) {
      if (method === 'POST') {
        let body = null; try { body = route.request().postDataJSON(); } catch { body = null; }
        capture.upserts.push({ url, body });
        await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
        return;
      }
      const rows = opts.cfg ? [{ value: JSON.stringify(opts.cfg) }] : [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
      return;
    }
    if (url.includes('/rest/v1/ceo_briefs')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.briefs || []) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEY, JSON.stringify({
    access_token: 'test-token', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer', user: { id: 'u1', email: 'test@example.com' },
  })]);
  await page.goto('/ceo-brief-supabase.html');
  return capture;
}

test.describe('CEO Brief (Supabase page)', () => {
  test("today's card renders the one thing, first step and the hand-offs", async ({ page }) => {
    await setup(page, { cfg: ENABLED_CFG, briefs: [briefRow()] });
    const card = page.locator('.card.brief.today');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.one-thing')).toHaveText('Call the two warm leads before lunch');
    await expect(card.locator('.first-step')).toContainText('Open the CRM and ring Dana first');
    await expect(card.locator('.handed li')).toHaveCount(2);
    await expect(card.locator('.handed li').nth(1)).toHaveText('Supplier quotes to Jo');
    await expect(card.locator('.badge.green')).toHaveText('Money: green');
    await expect(card.locator('.safe')).toContainText('£1,250.50');
    await expect(page.locator('#sbLoginOverlay')).toHaveCount(0);
  });

  test('a config that is not switched on shows the not-on panel with what is missing', async ({ page }) => {
    await setup(page, { cfg: { enabled: false, founder: { name: 'Sam' } }, briefs: [] });
    const panel = page.locator('#notOn');
    await expect(panel).toContainText('not switched on yet');
    const missing = panel.locator('li');
    expect(await missing.count()).toBeGreaterThan(0);
    await expect(missing.first()).toHaveText('Business name');
    // the button lands on the Setup tab
    await page.click('#goSetup');
    await expect(page.locator('#view-setup')).toHaveClass(/active/);
  });

  test('the Setup tab renders every SETUP_QUESTIONS id as a field and every step title', async ({ page }) => {
    await setup(page, { cfg: null, briefs: [] });
    await page.click('.tab[data-tab="setup"]');
    const questions = await page.evaluate(() => window.SETUP_QUESTIONS.map(q => ({ id: q.id, type: q.type })));
    const steps = await page.evaluate(() => window.SETUP_STEPS.map(s => s.title));
    expect(questions.length).toBeGreaterThan(20);
    await expect(page.locator('[data-q]')).toHaveCount(questions.length);
    for (const q of questions) {
      await expect(page.locator(`[data-q="${q.id}"]`), `question ${q.id}`).toHaveCount(1);
      await expect(page.locator(`[data-q="${q.id}"] #q_${q.id}`), `input for ${q.id}`).toHaveCount(1);
    }
    for (const t of steps) await expect(page.locator('#stepper')).toContainText(t);
    // structured fields carry their full row sets
    await expect(page.locator('[data-q="board"] [data-seat]')).toHaveCount(11);
    await expect(page.locator('[data-q="workers"] [data-worker]')).toHaveCount(5);
    // the go-live switch is locked while anything is missing
    await page.click('[data-step="8"]');
    await expect(page.locator('#q_enabled')).toBeDisabled();
    await expect(page.locator('#enabledNote')).toContainText('Founder name');
  });

  test('saving a step upserts app_settings with key ceo_brief and the typed answers', async ({ page }) => {
    const capture = await setup(page, { cfg: null, briefs: [] });
    await page.click('.tab[data-tab="setup"]');
    await page.fill('#q_founder_name', 'Sam Tester');
    await page.fill('#q_business', 'Tester Ltd');
    await page.fill('#q_what_it_sells', 'Bookkeeping, £250 a month');
    await page.click('[data-save="1"]');
    await expect(page.locator('[data-status="1"]')).toHaveText('Saved');
    expect(capture.upserts).toHaveLength(1);
    const { url, body } = capture.upserts[0];
    expect(url).toContain('/rest/v1/app_settings');
    expect(url).toContain('on_conflict=org_id,key');
    expect(body.key).toBe('ceo_brief');
    expect(body.org_id).toBeUndefined();          // RLS + column default own org_id, never the page
    const saved = JSON.parse(body.value);
    expect(saved.founder.name).toBe('Sam Tester');
    expect(saved.founder.business).toBe('Tester Ltd');
    expect(saved.founder.what_it_sells).toBe('Bookkeeping, £250 a month');
    expect(saved.enabled).toBe(false);
    expect(saved.board).toHaveLength(11);         // defaults filled in around the answers
    // the readiness panel no longer lists what was just answered
    await expect(page.locator('#readiness')).not.toContainText('Founder name');
    await expect(page.locator('#readiness')).toContainText("This quarter's targets");
  });

  test('a fallback row is labelled as a failure, not shown as a finished brief', async ({ page }) => {
    await setup(page, { cfg: ENABLED_CFG, briefs: [briefRow({ fallback: true, one_thing: null, first_step: null, why: null, handed_off: null, ignore_today: null, board_flags: null, money_light: 'amber', safe_to_act: 300 })] });
    const card = page.locator('.card.brief.today');
    await expect(card).toHaveAttribute('data-fallback', '1');
    await expect(card.locator('.badge.failed')).toContainText('Brief failed');
    await expect(card.locator('.one-thing')).toHaveText('No brief was written today.');
    // the health strip agrees
    await expect(page.locator('#health .hc').nth(2)).toHaveClass(/fail/);
    await expect(page.locator('#health .hc').nth(2)).toContainText('Brief failed today');
  });

  // The weekend excuse used to be tested BEFORE the row, so a brief that fired on a
  // Saturday and failed was reported as "No brief at weekends" — a green tick over a
  // broken brief, beside a card already saying "Brief failed". It only misreported at
  // weekends, so it passed Mon–Fri for weeks. These three pin the clock so the whole
  // precedence is checked every day: a row is reported on pass or fail, and the weekend
  // excuse still covers a genuinely absent brief.
  const SATURDAY = new Date('2026-08-29T09:30:00Z');   // 10:30 in London, BST
  const SAT_ISO = '2026-08-29';

  test('a weekend fallback row still reads as failed in the health strip', async ({ page }) => {
    await page.clock.setFixedTime(SATURDAY);
    await setup(page, { cfg: ENABLED_CFG, briefs: [briefRow({ brief_date: SAT_ISO, fallback: true, one_thing: null })] });
    await expect(page.locator('#health .hc').nth(2)).toHaveClass(/fail/);
    await expect(page.locator('#health .hc').nth(2)).toContainText('Brief failed today');
  });

  test('a weekend brief that DID arrive reads as arrived, not as absent', async ({ page }) => {
    await page.clock.setFixedTime(SATURDAY);
    await setup(page, { cfg: ENABLED_CFG, briefs: [briefRow({ brief_date: SAT_ISO })] });
    await expect(page.locator('#health .hc').nth(2)).toHaveClass(/ok/);
    await expect(page.locator('#health .hc').nth(2)).toContainText('Arrived');
  });

  test('with no row at all, the weekend excuse still stands', async ({ page }) => {
    await page.clock.setFixedTime(SATURDAY);
    await setup(page, { cfg: ENABLED_CFG, briefs: [] });
    await expect(page.locator('#health .hc').nth(2)).toHaveClass(/ok/);
    await expect(page.locator('#health .hc').nth(2)).toContainText('No brief at weekends');
  });

  test('a secret is never echoed back into its field', async ({ page }) => {
    await setup(page, { cfg: { calendar_ics_url: 'https://calendar.example.com/private-abc.ics' }, briefs: [] });
    await page.click('.tab[data-tab="setup"]');
    await page.click('[data-step="6"]');
    await expect(page.locator('#q_calendar_ics')).toHaveValue('');
    await expect(page.locator('#q_calendar_ics')).toHaveAttribute('placeholder', 'Saved. Paste again to replace.');
    await expect(page.locator('[data-q="calendar_ics"] .saved-dot')).toHaveCount(1);
    expect(await page.content()).not.toContain('private-abc.ics');
  });
});
