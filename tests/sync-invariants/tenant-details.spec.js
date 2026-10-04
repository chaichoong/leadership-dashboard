// The tenant details form (tenant-details.html, task recrmZTcOHg8vPlZk). A tenant opens it on a
// phone from his own link; it talks only to the property-manager Worker, with his code in the
// request body, and never to Airtable. The Worker is mocked here: nothing reaches a real service.
const { test, expect } = require('@playwright/test');
const { stubExternalHosts } = require('./helpers');

const PM = 'https://pm.operationsdirector.co.uk';
const CODE = 'Abc_def-0123456789abcdefghijklmn';   // 32 characters, the shape the Worker makes

async function openForm(page, { hash = '#c=' + CODE, get, save, upload } = {}) {
  const calls = [];
  const airtable = [];
  await stubExternalHosts(page);
  await page.route('**/api.airtable.com/**', route => { airtable.push(route.request().url()); return route.fulfill({ status: 500, body: '{}' }); });
  await page.route('**/content.airtable.com/**', route => { airtable.push(route.request().url()); return route.fulfill({ status: 500, body: '{}' }); });
  await page.route(PM + '/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    let body = null; try { body = req.postDataJSON(); } catch (e) { body = null; }
    const code = body && body.code;
    if (body) delete body.code;
    calls.push({ path, method: req.method(), body, code: code || '', headers: req.headers() });
    const reply = (r) => r === 'abort' ? route.abort() : route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) });
    if (path === '/tenant-form/open') return reply(get ? get(calls) : { body: { ok: true, firstName: 'Sam' } });
    if (path === '/tenant-form') return reply(save ? save(body) : { body: { ok: true, saved: Object.keys(body.answers).length, savedAt: '14:02' } });
    if (path === '/tenant-form/upload') return reply(upload ? upload(body) : { body: { ok: true } });
    return reply({ status: 404, body: { ok: false } });
  });
  await page.goto('/tenant-details.html' + hash);
  return { calls, airtable };
}

test.describe('the tenant details form', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('a good link greets him by first name; Save sends only what he filled in, with his code', async ({ page }) => {
    const { calls, airtable } = await openForm(page);
    await expect(page.locator('#form')).toBeVisible();
    await expect(page.locator('#hello')).toContainText('Hello Sam.');
    await page.locator('input[name="phone"]').fill('07700 900123');
    await page.locator('input[name="ni"]').fill('ab 12 34 56 c');
    await page.locator('select[name="capExemption"]').selectOption('None (capped)');
    await page.locator('textarea[name="otherBenefits"]').fill('PIP');
    await page.locator('#save').click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved at 14:02. Thank you.');
    const save = calls.find(c => c.path === '/tenant-form');
    expect(save.body).toEqual({ answers: { phone: '07700 900123', ni: 'ab 12 34 56 c', capExemption: 'None (capped)', otherBenefits: 'PIP' } });
    expect(save.code).toBe(CODE);
    expect(calls.find(c => c.path === '/tenant-form/open').code).toBe(CODE);
    // The code is never in a header or the request URL.
    for (const c of calls) expect(JSON.stringify(c.headers) + c.path).not.toContain(CODE);
    // It never talks to Airtable and holds no key.
    expect(airtable).toEqual([]);
    const html = await page.content();
    expect(html).not.toMatch(/api\.airtable\.com|airtable_pat|Bearer /);
    // Phone width, no sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test('every question on the page is one the Worker accepts, and the cap list never offers Unknown', async ({ page }) => {
    await openForm(page);
    await expect(page.locator('#form')).toBeVisible();
    const names = await page.locator('#form [name]').evaluateAll(els => els.map(e => e.name).sort());
    expect(names).toEqual(['capExemption', 'ctAccount', 'dob', 'email', 'household', 'ni', 'otherAdults', 'otherBenefits', 'phone', 'ucPayDay', 'weeklyIncome', 'weeklySpending']);
    const capValues = await page.locator('select[name="capExemption"] option').evaluateAll(os => os.map(o => o.value));
    expect(capValues).toEqual(['', 'None (capped)', 'LCWRA', 'PIP or DLA', 'Carer', 'Earnings over threshold', 'Not on UC']);
  });

  test('a link the Worker does not know shows the plain message and offers no form', async ({ page }) => {
    const { calls } = await openForm(page, { get: () => ({ status: 404, body: { ok: false, error: 'gone' } }) });
    await expect(page.locator('#gone')).toBeVisible();
    await expect(page.locator('#gone')).toContainText('This link is not working. Reply to the email or text we sent you');
    await expect(page.locator('#form')).toBeHidden();
    expect(calls.filter(c => c.path !== '/tenant-form/open')).toEqual([]);
  });

  test('a first name holding markup shows as plain text', async ({ page }) => {
    await openForm(page, { get: () => ({ body: { ok: true, firstName: '<img src=x onerror="window.hit=1">' } }) });
    await expect(page.locator('#hello')).toContainText('Hello <img src=x');
    expect(await page.evaluate(() => window.hit)).toBeUndefined();
    await expect(page.locator('#hello img')).toHaveCount(0);
  });

  test('no code in the link: the message, and no call at all', async ({ page }) => {
    const { calls } = await openForm(page, { hash: '' });
    await expect(page.locator('#gone')).toBeVisible();
    expect(calls).toEqual([]);
    await openForm(page, { hash: '#c=short' });
    await expect(page.locator('#gone')).toBeVisible();
  });

  test('when the Worker cannot be reached, it says so and Try again tries again', async ({ page }) => {
    let n = 0;
    await openForm(page, { get: () => (++n === 1 ? 'abort' : { body: { ok: true, firstName: 'Sam' } }) });
    await expect(page.locator('#failed')).toBeVisible();
    await page.locator('#retry').click();
    await expect(page.locator('#form')).toBeVisible();
    await expect(page.locator('#hello')).toContainText('Hello Sam.');
  });

  test('a refused answer shows the Worker\'s words; an empty form sends nothing', async ({ page }) => {
    const { calls } = await openForm(page, { save: () => ({ status: 400, body: { ok: false, error: 'That date of birth does not look right.' } }) });
    await expect(page.locator('#form')).toBeVisible();
    await page.locator('#save').click();
    await expect(page.locator('#saveStatus')).toHaveText('Fill in at least one answer first.');
    expect(calls.filter(c => c.path === '/tenant-form')).toEqual([]);
    await page.locator('input[name="dob"]').fill('2015-01-01');
    await page.locator('#save').click();
    await expect(page.locator('#saveStatus')).toHaveText('That date of birth does not look right.');
  });

  test('a link that dies while the page is open turns into the plain message', async ({ page }) => {
    await openForm(page, { save: () => ({ status: 404, body: { ok: false } }) });
    await page.locator('input[name="phone"]').fill('07700 900123');
    await page.locator('#save').click();
    await expect(page.locator('#gone')).toBeVisible();
  });

  test('the statement photo goes up with its type and his code; a file over 3.7MB never leaves the phone', async ({ page }) => {
    const { calls } = await openForm(page);
    await expect(page.locator('#form')).toBeVisible();
    await page.locator('#file').setInputFiles({ name: 'statement.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake jpeg bytes') });
    await page.locator('#send').click();
    await expect(page.locator('#fileStatus')).toHaveText('Sent. Thank you.');
    const up = calls.find(c => c.path === '/tenant-form/upload');
    expect(up.code).toBe(CODE);
    expect(up.body).toEqual({ filename: 'statement.jpg', contentType: 'image/jpeg', file: Buffer.from('fake jpeg bytes').toString('base64') });
    await page.locator('#file').setInputFiles({ name: 'big.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(Math.floor(3.7 * 1024 * 1024) + 1) });
    await page.locator('#send').click();
    await expect(page.locator('#fileStatus')).toContainText('over 3.7MB');
    expect(calls.filter(c => c.path === '/tenant-form/upload')).toHaveLength(1);
  });
});
