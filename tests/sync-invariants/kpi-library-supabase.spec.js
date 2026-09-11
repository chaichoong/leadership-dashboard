// KPI Library (Supabase twin) — the page must actually be VISIBLE once it renders.
//
// Bug (8 Sep 2026): kpi-library-supabase.html loads css/styles.css for the shell's look,
// and styles.css hides every `.tab-panel` unless it carries `.active` (the shell's
// switchTab adds it). The twin's one panel never got it, so js/kpi-library.js rendered
// 47k characters of library into a display:none element and the page read as blank.
// Two fixes went in for other causes (Web-Locks deadlock, slow session read) and the
// page stayed blank, because the on-page diagnostic only checked innerHTML length —
// which was fine. skills-supabase.html carries `style="display:block"` for exactly this
// reason; this spec pins the same on the KPI twin and asserts VISIBILITY, not markup.
//
// Hermetic: supabase-js (jsdelivr) is replaced by a stand-in that issues PostgREST-shaped
// fetches, and the Supabase host is intercepted, so no backend and no internet.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts } = require('./helpers');

const SB_HOST = '**ptkyhzlsvijcwyovgrgv.supabase.co/**';
const STORAGE_KEY = '_dlr_sb_app';
const OWNER = 'kevin@operationsdirector.co.uk';

// Minimal stand-in for @supabase/supabase-js v2: auth.getSession reads the shell's
// storage key like the real client; from().select() is a thenable that fetches
// /rest/v1/<table> so the route below sees the real request the shim produces.
const SUPABASE_SHIM = `
  window.supabase = {
    createClient: function(url, key, opts){
      const storageKey = (opts && opts.auth && opts.auth.storageKey) || 'sb';
      const auth = {
        getSession: async () => { try { const s = JSON.parse(localStorage.getItem(storageKey) || 'null'); return { data: { session: s } }; } catch (e) { return { data: { session: null } }; } },
        signInWithPassword: async () => ({ error: { message: 'stub: not signed in' } }),
      };
      function from(table){
        const q = { params: [] };
        const b = {
          select(cols){ q.params.push('select=' + encodeURIComponent(cols || '*')); return b; },
          then(res, rej){
            const u = url + '/rest/v1/' + table + '?' + q.params.join('&');
            return fetch(u, { headers: { apikey: key } })
              .then(async r => r.ok ? { data: await r.json(), error: null } : { data: null, error: { message: 'HTTP ' + r.status } })
              .then(res, rej);
          }
        };
        return b;
      }
      return { auth, from };
    }
  };
`;

async function setup(page, { email = OWNER, projects = [] } = {}) {
  await stubExternalHosts(page);
  await page.route('**cdn.jsdelivr.net/**', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_SHIM }));
  await page.route(SB_HOST, route => {
    const url = route.request().url();
    if (url.includes('/rest/v1/v_projects')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projects) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEY, JSON.stringify({
    access_token: 'test-token', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer', user: { id: 'u1', email },
  })]);
  await page.goto('/kpi-library-supabase.html');
}

const LIVE_ROW = { id: 'p1', created_at: '2026-07-01', name: 'Q3 Launch', kpi_name: 'Cash collected',
  kpi_unit: '£', kpi_target: 5000, kpi_current: 1200, kpi_compute_code: 'return 1;',
  kpi_last_updated: '2026-09-08T12:14:07.518Z', end_date: '2099-12-31' };
// A closed quarter. Airtable's page filters {Closed On} = BLANK(); v_projects has no such
// column, so the shim treats end_date before today as closed. This row must NOT appear.
const CLOSED_ROW = { id: 'p0', created_at: '2026-04-01', name: 'Q2 Launch', kpi_name: 'Monthly Recurring Revenue',
  kpi_unit: '£', kpi_target: 249, kpi_current: 0, kpi_compute_code: 'return 0;',
  kpi_last_updated: '2026-09-04T09:27:39.029Z', end_date: '2026-06-30' };

test.describe('KPI Library (Supabase twin)', () => {
  test('the owner sees the library on screen, not a blank page', async ({ page }) => {
    await setup(page, { projects: [CLOSED_ROW, LIVE_ROW] });
    const panel = page.locator('#tab-kpi-library');
    // Visibility, not innerHTML: the bug rendered everything into a hidden element.
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Tier 1');
    await expect(panel).toContainText('Tier 2');
    await expect(panel.locator('h2.section-title')).toBeVisible();
    // The static library is the whole point: every shape and entry is on screen.
    const counts = await page.evaluate(() => ({ lib: KPI_LIBRARY.length, shapes: KPI_SHAPES.length }));
    await expect(panel.locator('table').nth(1).locator('tbody tr')).toHaveCount(counts.shapes);
    await expect(panel.locator('table').nth(0).locator('tbody tr')).toHaveCount(1);
    // The one live read is routed to v_projects and lands in the "live right now" table.
    await expect(panel.locator('table').nth(0)).toContainText('Cash collected');
    await expect(panel.locator('table').nth(0)).toContainText('Q3 Launch');
    await expect(panel.locator('table').nth(0)).toContainText('£1,200 / £5,000');
    await expect(panel.locator('table').nth(0)).toContainText('2026-09-08');    // Last moved
    await expect(panel.locator('table').nth(0)).not.toContainText('Q2 Launch');  // closed quarter excluded
    await expect(panel.locator('.kpi-card').nth(3)).toContainText('1');          // automated live count
    // No gate, no login, no diagnostic fallback, one heading only.
    await expect(page.locator('#sbLoginOverlay')).toHaveCount(0);
    await expect(page.locator('#sbOwnerGate')).toHaveCount(0);
    await expect(page.locator('#sbBootCover')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('KPI Library diagnostic');
    await expect(page.getByText('📚 KPI Library')).toHaveCount(1);
    expect(counts.lib).toBeGreaterThan(20);
  });

  test('a signed-in non-owner is blocked by the owner gate and never sees the library', async ({ page }) => {
    await setup(page, { email: 'client@example.com', projects: [LIVE_ROW] });
    await expect(page.locator('#sbOwnerGate')).toBeVisible();
    await expect(page.locator('#sbOwnerGate')).toContainText('internal admin tool');
    await expect(page.locator('#tab-kpi-library')).toBeEmpty();
  });

  test('with no session the login overlay shows and nothing renders behind it', async ({ page }) => {
    await stubExternalHosts(page);
    await page.route('**cdn.jsdelivr.net/**', route =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_SHIM }));
    await page.route(SB_HOST, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto('/kpi-library-supabase.html');
    await expect(page.locator('#sbLoginOverlay')).toBeVisible();
    await expect(page.locator('#tab-kpi-library')).toBeEmpty();
  });

  // The twin must read its live rows from Supabase and never from Airtable. The shim
  // overrides window.fetch: the one Projects read is answered from v_projects, every
  // other Airtable call is answered empty, and no request ever leaves for
  // api.airtable.com. Recorded at the network layer, so a shim that quietly fell
  // through to the real fetch would fail here even though the page still rendered.
  test('the live KPI rows come from Supabase v_projects and nothing is asked of Airtable', async ({ page }) => {
    // page.on('request') sees every request, including ones a route later fulfils.
    const requests = [];
    page.on('request', r => requests.push(r.url()));
    let served = 0;
    await stubExternalHosts(page);
    await page.route('**cdn.jsdelivr.net/**', route =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_SHIM }));
    await page.route(SB_HOST, route => {
      if (route.request().url().includes('/rest/v1/v_projects')) {
        served += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([LIVE_ROW]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [STORAGE_KEY, JSON.stringify({
      access_token: 'test-token', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer', user: { id: 'u1', email: OWNER },
    })]);
    await page.goto('/kpi-library-supabase.html');
    // The row on screen is the one Supabase served.
    await expect(page.locator('#tab-kpi-library table').nth(0)).toContainText('Q3 Launch');
    expect(served).toBeGreaterThan(0);
    const supabaseReads = requests.filter(u => u.includes('supabase.co/rest/v1/v_projects'));
    const airtableReads = requests.filter(u => u.includes('api.airtable.com'));
    expect(supabaseReads.length).toBeGreaterThan(0);
    expect(airtableReads).toEqual([]);
    // Belt and braces: the app's Airtable token is the shim's placeholder, not a real PAT.
    expect(await page.evaluate(() => PAT)).toBe('supabase');
  });
});
