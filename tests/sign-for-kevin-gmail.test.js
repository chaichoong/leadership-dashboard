// SIGN AS KEVIN, the second door (16 Oct 2026): an Adobe Sign link emailed to kevinbrittain@gmail.com.
// Kevin built it "anyway" after seeing the volume (1 real request in 120 days), so it ships with the same
// gates as the info@ door: only Adobe's own request email, addressed to him, for that exact document; the
// card names the request by a fingerprint of its link; the robot opens it with no Adobe session, presses
// Continue only after his approval, types his name, and believes it only from Adobe's page AND Adobe's
// "You signed" email. Every test drives the real code; the pages are fixtures served at Adobe's own
// address and shaped from the live page probed on 16 Oct 2026.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const require_ = createRequire(import.meta.url);
const DIR = mkdtempSync(join(tmpdir(), 'sign-gmail-'));
const NAME = 'Runpreneur_Test_Statement';
const LINK = 'https://na1.documents.adobe.com/public/esign?tsid=SECRETTOKEN1';

afterAll(() => { rmSync(DIR, { recursive: true, force: true }); });

// ── The link finder: Adobe's own request to Kevin, for that exact document, on Adobe's signing host ──
function finder(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("asl", ${JSON.stringify(join(SCRIPTS, 'adobe_sign_link.py'))})
L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
NAME = ${JSON.stringify(NAME)}
def msg(i, when, frm="Agile Lets via Adobe Acrobat Sign <adobesign@adobesign.com>", to='"kevinbrittain@gmail.com" <kevinbrittain@gmail.com>',
        subject='Signature requested on "%s"' % NAME, links=None):
    return {"id": i, "internalDate": when, "headers": {"from": frm, "to": to, "subject": subject},
            "links": links if links is not None else [{"text": "Review and sign", "href": "https://na1.documents.adobe.com/public/esign?tsid=T" + i},
                                                       {"text": "delegate", "href": "https://x.na1.echosign.com/public/resend?tsid=T" + i}]}
${code}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
}

describe('the link finder takes only Adobe\'s own request to Kevin, for that exact document', () => {
  it('refuses every look-alike, and says why', () => {
    const out = finder(`
cases = {
  "good": msg("a", 1),
  "fakeSender": msg("b", 1, frm="Adobe Sign <adobesign@adobe-sign-docs.com>"),
  "notKevin": msg("c", 1, to="someone@example.com"),
  "otherDoc": msg("d", 1, subject='Signature requested on "Something_Else"'),
  "reminderWording": msg("e", 1, subject='Reminder: %s' % NAME),
  "otherHost": msg("f", 1, links=[{"text": "Review and sign", "href": "https://docs-adobe.example.com/public/esign?tsid=Tf"}]),
  "delegateOnly": msg("g", 1, links=[{"text": "delegate", "href": "https://x.na1.echosign.com/public/resend?tsid=Tg"}]),
  "plainHttp": msg("h", 1, links=[{"text": "Review and sign", "href": "http://na1.documents.adobe.com/public/esign?tsid=Th"}]),
  "twoLinks": msg("i", 1, links=[{"text": "Review and sign", "href": "https://na1.documents.adobe.com/public/esign?tsid=T1"},
                                 {"text": "Review and sign", "href": "https://na1.documents.adobe.com/public/esign?tsid=T2"}]),
}
print(json.dumps({k: L.request_link(v, NAME)[1] for k, v in cases.items()}))`);
    expect(out.good).toBe('');
    expect(out.fakeSender).toMatch(/not sent by adobesign@adobesign.com/);
    expect(out.notKevin).toMatch(/not addressed to kevinbrittain@gmail.com/);
    expect(out.otherDoc).toMatch(/exact document/);
    expect(out.reminderWording).toMatch(/exact document/);
    expect(out.otherHost).toMatch(/Adobe's own signing host/);
    expect(out.delegateOnly).toMatch(/no Review and sign link/);
    expect(out.plainHttp).toMatch(/no Review and sign link/);
    expect(out.twoLinks).toMatch(/two different signing links/);
  });

  it('picks the newest real request, names it by a fingerprint, and never by its token', () => {
    const out = finder(`
lister = lambda **kw: ([msg("old", 1000), msg("new", 2000), msg("fake", 3000, frm="x <adobesign@evil.example>")], False)
print(json.dumps(L.find(NAME, lister=lister)))`);
    expect(out.messageId).toBe('new');
    expect(out.linkId).toMatch(/^tsid-[0-9a-f]{40}$/);
    expect(out.linkId).not.toMatch(/Tnew/);
  });

  it('finds Adobe\'s "You signed" email only after the press', () => {
    const out = finder(`
lister = lambda **kw: ([msg("s", 1760630000000, subject='You signed: "%s"' % NAME, links=[])], False)
print(json.dumps([L.signed(NAME, "2025-10-16T00:00:00+00:00", lister=lister)["signed"],
                  L.signed(NAME, "2099-01-01T00:00:00+00:00", lister=lister)["signed"]]))`);
    expect(out).toEqual([true, false]);
  });
});

describe('the Gmail worker hands back each email\'s links (the real worker source)', () => {
  it('reads the HTML part\'s links with their words; the plain-text body never had them', () => {
    const src = readFileSync(join(ROOT, 'workers/drive-upload/worker.js'), 'utf8');
    const grab = (n) => { const i = src.indexOf('function ' + n + '('); let d = 0; const j = src.indexOf('{', i);
      for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } } };
    const extractLinks = new Function(grab('b64urlDecodeUtf8') + grab('extractLinks') + 'return extractLinks;')();
    const b64 = (t) => Buffer.from(t).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const html = '<a href="https://na1.documents.adobe.com/public/esign?tsid=X&amp;y=1" style="c"><span>Review</span> and sign</a>'
      + '<a href="mailto:a@b.c">mail</a><a href=\'https://www.adobe.com/go/terms_uk\'>Terms</a>';
    const links = extractLinks({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64('Review and sign') } }, { mimeType: 'text/html', body: { data: b64(html) } }] });
    expect(links).toEqual([{ href: 'https://na1.documents.adobe.com/public/esign?tsid=X&y=1', text: 'Review and sign' },
                           { href: 'https://www.adobe.com/go/terms_uk', text: 'Terms' }]);
    expect(src).toMatch(/links: extractLinks\(msg\.payload\)/);
  });
});

// ── The robot's link door, in real Chrome, against a fixture at Adobe's own signing address ──
let chromium, ab, browser, PDF_A, PDF_B, APPROVED, ID;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported by the tests */ }
const STUB = join(DIR, 'link-stub.py');

beforeAll(async () => {
  process.env.SIGN_FOR_KEVIN_LEDGER = join(DIR, 'signed.jsonl');
  process.env.AGENT_UPLOAD_DIR = DIR;
  process.env.AGENT_SIGN_LIST_MS = '200';
  process.env.AGENT_SIGN_SETTLE_MS = '100';
  process.env.AGENT_SIGN_CONFIRM_GAP_MS = '100';
  process.env.AGENT_SIGN_LINK_SCRIPT = STUB;
  writeFileSync(STUB, 'import os, sys\nprint(os.environ["LINK_SIGNED" if sys.argv[1] == "signed" else "LINK_FIND"])\n');
  delete require_.cache[require_.resolve(join(SCRIPTS, 'agent-browser.js'))];
  ab = require_(join(SCRIPTS, 'agent-browser.js'));
  ID = 'tsid-' + require_('crypto').createHash('sha256').update('SECRETTOKEN1').digest('hex').slice(0, 40);
  process.env.LINK_FIND = JSON.stringify({ messageId: 'm1', when: '2026-10-16T17:49:11+00:00', linkId: ID, link: LINK });
  process.env.LINK_SIGNED = JSON.stringify({ signed: true });
  browser = await chromium.launch();
  const pdfOf = async (words) => { const pg = await browser.newPage(); await pg.setContent(`<p>${words}</p>`); const b = await pg.pdf(); await pg.close(); return b; };
  PDF_A = await pdfOf('The statement is true. Signed by Kevin Brittain.');
  PDF_B = await pdfOf('The statement is different now.');
  APPROVED = join(DIR, 'approved.pdf');
  writeFileSync(APPROVED, PDF_A);
});
afterAll(async () => { if (browser) await browser.close(); });

function linkPage(over = {}) {
  return Object.assign({ title: NAME, waiting: true, extraRequired: 0, pdf: null, submits: 0, continues: 0, declines: 0, delegates: 0 }, over);
}
async function fakeLink(s) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route((u) => u.hostname.endsWith('documents.adobe.com'), async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/download') return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename="a.pdf"' }, body: s.pdf || PDF_A });
    if (u.pathname === '/press') { s[u.searchParams.get('what')]++; return route.fulfill({ status: 204 }); }
    if (u.pathname !== '/public/esign') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
<style>@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.06)}100%{transform:scale(1)}}.go{animation:pulse .6s infinite}
#gate{position:fixed;inset:0;background:transparent;z-index:5}
/* Live (16 Oct 2026): before Continue the gate covers the document, never Options or Continue. */
[data-testid=lhp-options-btn],#menu,[data-testid=lhp-continue-btn]{position:relative;z-index:6}</style>
<input aria-label="Document Title" value="${s.title}">
<div id="msg">${s.waiting ? 'Your turn to sign.' : 'You have already signed this document.'}</div>
<button data-testid="lhp-options-btn">Options</button><button data-testid="actions-menu-button" style="display:none">Options</button>
<div id="menu" role="menu" style="display:none"><div role="menuitem" data-testid="actions-menu-item-decline">Decline to sign</div>
<div role="menuitem" data-testid="actions-menu-item-delegate">Delegate signing to another</div>
<a role="menuitem" data-testid="actions-menu-item-agreement-download" href="/download">Download PDF</a></div>
<button data-testid="lhp-continue-btn" aria-label="By selecting Continue, I agree to the Terms of Use, Consumer Disclosure and to use electronic signatures." style="position:relative;z-index:6">Continue</button>
<div id="gate" data-testid="test-esign-gate"></div>
<div id="left"></div>
<div data-testid="signature-form-field" aria-label="Click to Sign (required)" style="width:120px;height:30px;border:1px solid"></div>
<button data-testid="footer-submit-button" style="position:fixed;bottom:10px;right:20px">Submit</button>
<div id="dlg"></div><script>
const press = (what) => fetch('/press?what=' + what, { method: 'POST' });
const EXTRA = ${s.extraRequired};
const footer = document.querySelector('[data-testid=footer-submit-button]');
const box = document.querySelector('[data-testid=signature-form-field]');
function refresh() {
  const empty = (/Click to Sign/.test(box.getAttribute('aria-label')) ? 1 : 0) + EXTRA;
  footer.setAttribute('aria-label', empty ? empty + ' required fields remaining' : 'All required fields complete. Click submit to sign.');
  footer.classList.toggle('go', !empty);
}
document.querySelector('[data-testid=lhp-options-btn]').onclick = () => { document.getElementById('menu').style.display = 'block'; };
document.querySelector('[data-testid=actions-menu-item-decline]').onclick = () => press('declines');
document.querySelector('[data-testid=actions-menu-item-delegate]').onclick = () => press('delegates');
document.querySelector('[data-testid=lhp-continue-btn]').onclick = () => { press('continues'); document.getElementById('gate').remove(); };
box.onclick = () => {
  document.getElementById('dlg').innerHTML = '<div role="dialog"><div role="tab" data-testid="sign-canvas-type-tab">Type</div>'
    + '<input aria-label="Type your signature above"><button id="close">Close</button><button id="apply">Apply</button></div>';
  document.getElementById('apply').onclick = () => {
    const name = document.querySelector('[role=dialog] input').value;
    box.setAttribute('aria-label', name + ' Click to change (required)'); document.getElementById('dlg').innerHTML = ''; refresh(); };
};
footer.onclick = () => press('submits').then(() => { document.body.innerHTML = "<h1>You\\u2019re all set!</h1><p>You finished signing \\u201c${s.title}\\u201d.</p>"; });
refresh();
</script>` });
  });
  return ctx;
}
async function runLink(s, o) {
  const ctx = await fakeLink(s);
  const page = await ctx.newPage();
  try {
    return await ab.runSignFlow(page, ctx, Object.assign({ task: 'recTESTTESTTEST02', name: NAME, id: ID,
      door: ab.SIGN_DOORS['kevinbrittain@gmail.com'], approvedCopy: APPROVED }, o));
  } finally { await ctx.close(); }
}

describe('the robot signs the approved Gmail request with Kevin\'s typed name, and only it', () => {
  it('Continue, his typed name, Adobe\'s pulsing Submit, then Adobe\'s page AND Adobe\'s email', async () => {
    const s = linkPage();
    const r = await runLink(s, { mode: 'sign' });
    expect(r).toMatchObject({ agreementId: ID, statusAfter: 'Signed (Adobe page and Adobe email)', boxes: 1 });
    expect([s.continues, s.submits, s.declines, s.delegates]).toEqual([1, 1, 0, 0]);
  });

  const refused = async (over, o, re) => {
    const s = linkPage(over);
    await expect(runLink(s, Object.assign({ mode: 'sign' }, o))).rejects.toThrow(re);
    expect([s.continues, s.submits]).toEqual([0, 0]);          // not even the terms were agreed
  };
  it('refuses when the newest request in Gmail is not the one Kevin approved', () =>
    refused({}, { id: 'tsid-' + 'f'.repeat(40) }, /not the one he approved/));
  it('refuses a link whose document is not the approved one', () => refused({ title: 'Something_Else' }, {}, /not "Runpreneur_Test_Statement"/));
  it('refuses a link no longer waiting for Kevin', () => refused({ waiting: false }, {}, /not waiting for Kevin's signature/));
  it('refuses when the words in Adobe differ from the copy he approved', () => refused({ pdf: PDF_B }, {}, /not the document Kevin approved/));

  it('refuses when Adobe asks for more than his name (after Continue, before Submit)', async () => {
    const s = linkPage({ extraRequired: 1 });
    await expect(runLink(s, { mode: 'sign' })).rejects.toThrow(/asks for more than Kevin's signature/);
    expect(s.submits).toBe(0);
  });

  it('a page that says all set but no "You signed" email is NOT proved, and locks', async () => {
    process.env.LINK_SIGNED = JSON.stringify({ signed: false });
    try {
      const s = linkPage();
      const err = await runLink(s, { mode: 'sign' }).catch((e) => e);
      expect(err.unconfirmed).toBe(true);
      expect(err.message).toMatch(/SIGN NOT CONFIRMED.*"You signed" email/);
      expect(s.submits).toBe(1);
    } finally { process.env.LINK_SIGNED = JSON.stringify({ signed: true }); }
  });
});

describe('the Gmail dry run names the request, downloads it and agrees to nothing', () => {
  it('prints the fingerprint, saves the unsigned copy, and never presses Continue', async () => {
    const s = linkPage();
    const r = await runLink(s, { mode: 'dry', id: undefined });
    expect(r).toMatchObject({ agreementId: ID, status: 'Your turn to sign', onlySignature: true });
    expect(readFileSync(r.unsigned).equals(PDF_A)).toBe(true);
    expect([s.continues, s.submits, s.declines, s.delegates]).toEqual([0, 0, 0, 0]);
  });
  it('a finder refusal is the robot\'s refusal', async () => {
    const was = process.env.LINK_FIND;
    writeFileSync(STUB, 'import json, sys\nprint(json.dumps({"error": "no Adobe signature request for that name"}))\nsys.exit(1)\n');
    try {
      await expect(runLink(linkPage(), { mode: 'dry', id: undefined })).rejects.toThrow(/no usable Adobe request .* no Adobe signature request/);
    } finally {
      writeFileSync(STUB, 'import os, sys\nprint(os.environ["LINK_SIGNED" if sys.argv[1] == "signed" else "LINK_FIND"])\n');
      process.env.LINK_FIND = was;
    }
  });
});
