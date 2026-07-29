// Invariant: the login screen offers a working "Forgot your password?" flow.
// Bug class this guards: a reset link that silently doesn't call Supabase's
// recover endpoint, or a redirectTo that doesn't point at the set-password page
// (so the emailed link would land nowhere and the user could never reset).
//
// The login shell is supabase-app.html (served at /login by a Vercel rewrite;
// here we load the file directly). Supabase auth calls go to the project's
// /auth/v1/** endpoints — we intercept them so the test needs no real backend.

const { test, expect } = require('@playwright/test');
const { stubExternalHosts } = require('./helpers');

const SB_HOST = '**ptkyhzlsvijcwyovgrgv.supabase.co/**';

// Minimal stand-in for @supabase/supabase-js (normally loaded from jsdelivr).
// Mirrors only what supabase-app.html uses. resetPasswordForEmail POSTs to
// /auth/v1/recover?redirect_to=... exactly like the real client, so the SB_HOST
// route below can capture the real request the app produces.
const SUPABASE_SHIM = `
  window.supabase = {
    createClient: function(url, key, opts){
      const auth = {
        getSession: async () => ({ data: { session: null } }),
        getUser: async () => ({ data: { user: null } }),
        signInWithPassword: async () => ({ error: { message: 'stub: not signed in' } }),
        resetPasswordForEmail: async (email, options) => {
          const redirect = (options && options.redirectTo) ? encodeURIComponent(options.redirectTo) : '';
          const res = await fetch(url + '/auth/v1/recover?redirect_to=' + redirect, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
          });
          return res.ok ? { error: null } : { error: { message: 'HTTP ' + res.status } };
        },
        signOut: async () => ({}),
      };
      return { auth, from: () => ({ select: async () => ({ data: [], error: null }) }) };
    }
  };
`;

// Stub every Supabase auth call: no session on load (so the login card shows),
// and capture the recover POST so we can assert on its body.
async function stubSupabase(page, capture) {
  // Serve the supabase-js shim instead of hitting jsdelivr (keeps the test hermetic).
  await page.route('**cdn.jsdelivr.net/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: SUPABASE_SHIM });
  });
  await page.route(SB_HOST, async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('/auth/v1/recover')) {
      capture.hit = true;
      try { capture.body = route.request().postDataJSON(); } catch { capture.body = null; }
      capture.redirectTo = new URL(url).searchParams.get('redirect_to');
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    // getSession / getUser / anything else → empty (logged out).
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.describe('Login — reset password', () => {
  test('Forgot password reveals reset view and emails a recovery link to /set-password', async ({ page }) => {
    const capture = { hit: false, body: null, redirectTo: null };
    await stubExternalHosts(page);
    await stubSupabase(page, capture);

    await page.goto('/supabase-app.html');

    // Login card is visible; reset view is hidden to start.
    await expect(page.locator('#signin-view')).toBeVisible();
    await expect(page.locator('#reset-view')).toBeHidden();

    // Click "Forgot your password?" → reset view shows, sign-in view hides.
    await page.locator('#forgot').click();
    await expect(page.locator('#reset-view')).toBeVisible();
    await expect(page.locator('#signin-view')).toBeHidden();

    // Enter an email and send.
    await page.locator('#reset-email').fill('kevin@example.com');
    await page.locator('#send-reset').click();

    // Supabase recover endpoint was called with the right email + redirect target.
    await expect.poll(() => capture.hit, { timeout: 5000 }).toBe(true);
    expect(capture.body && capture.body.email).toBe('kevin@example.com');
    expect(capture.redirectTo).toMatch(/\/set-password$/);

    // A confirmation note is shown to the user.
    await expect(page.locator('#reset-note')).toHaveClass(/ok/);
    await expect(page.locator('#reset-note')).toContainText(/reset link/i);
  });

  test('empty email shows a validation note and does not call Supabase', async ({ page }) => {
    const capture = { hit: false };
    await stubExternalHosts(page);
    await stubSupabase(page, capture);

    await page.goto('/supabase-app.html');
    await page.locator('#forgot').click();
    await page.locator('#send-reset').click();

    await expect(page.locator('#reset-note')).toHaveClass(/err/);
    expect(capture.hit).toBe(false);

    // "Back to sign in" returns to the sign-in view.
    await page.locator('#back-to-signin').click();
    await expect(page.locator('#signin-view')).toBeVisible();
    await expect(page.locator('#reset-view')).toBeHidden();
  });
});
