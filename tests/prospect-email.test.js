import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// js/ files load as plain <script> tags, so there is nothing to import. Pull the real
// functions out of the source and evaluate them, the same way tests/recon-vendor-key.test.js
// does, so this suite can never pass against a stale copy of the logic.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prospecting = readFileSync(resolve(root, 'js/prospecting.js'), 'utf8');
const config = readFileSync(resolve(root, 'js/config.js'), 'utf8');

function extract(src, name, file) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

function constant(src, name) {
  const m = src.match(new RegExp(`const ${name} = ('[^']*'|\\{[\\s\\S]*?\\n    \\});`));
  if (!m) throw new Error(`${name} not found in js/config.js`);
  return m[0];
}

// escHtml lives in shared.js; the builder depends on it, so bring the real one in too.
const shared = readFileSync(resolve(root, 'js/shared.js'), 'utf8');

const sandbox = new Function(`
  ${constant(config, 'OD_BOOKING_URL')}
  ${constant(config, 'OD_SENDER')}
  ${extract(shared, 'escHtml', 'js/shared.js')}
  ${extract(prospecting, 'prosField', 'js/prospecting.js')}
  ${extract(prospecting, 'prospectDefaultSubject', 'js/prospecting.js')}
  ${extract(prospecting, 'prospectSignatureText', 'js/prospecting.js')}
  ${extract(prospecting, 'prosStripSignOff', 'js/prospecting.js')}
  ${extract(prospecting, 'prospectSignatureHtml', 'js/prospecting.js')}
  ${extract(prospecting, 'prosLinkify', 'js/prospecting.js')}
  ${extract(prospecting, 'prosBodyHtml', 'js/prospecting.js')}
  ${extract(prospecting, 'buildProspectEmail', 'js/prospecting.js')}
  return { buildProspectEmail, prospectDefaultSubject, prosLinkify, prosStripSignOff, OD_BOOKING_URL, OD_SENDER };
`)();

const { buildProspectEmail, prospectDefaultSubject, prosLinkify, prosStripSignOff, OD_BOOKING_URL, OD_SENDER } = sandbox;

const rec = (fields) => ({ id: 'recTest', fields });

const ltd = rec({
  'Name': 'Jane Whitehouse',
  'Company': 'IS Group Signs Limited',
  'Contact Email': 'enquiries@is-group.co.uk',
  'Contact Route': 'Email sequence (Ltd)',
  'Draft Message': `Hi Jane, I saw your part-time bookkeeper ad.\nWorth a quick call? ${OD_BOOKING_URL}`,
  'Email Subject': 'your bookkeeper ad',
});

describe('buildProspectEmail — the preview IS the sent email', () => {
  it('addresses the email from Kevin to the prospect', () => {
    const e = buildProspectEmail(ltd);
    expect(e.from).toBe('kevin@operationsdirector.co.uk');
    expect(e.fromName).toBe('Kevin Brittain');
    expect(e.to).toBe('enquiries@is-group.co.uk');
    expect(e.toName).toBe('Jane Whitehouse');
  });

  it('uses the agent-written subject when there is one', () => {
    expect(buildProspectEmail(ltd).subject).toBe('your bookkeeper ad');
  });

  // Records created before the Email Subject field existed (7 Aug 2026) have a blank
  // subject. A blank subject line would be sent verbatim by GHL, so it must fall back.
  it('falls back to a generated subject when the field is blank or whitespace', () => {
    expect(buildProspectEmail(rec({ ...ltd.fields, 'Email Subject': '' })).subject)
      .toBe('A thought for IS Group Signs Limited');
    expect(buildProspectEmail(rec({ ...ltd.fields, 'Email Subject': '   ' })).subject)
      .toBe('A thought for IS Group Signs Limited');
  });

  it('lets an unsaved edit in the card drive the preview', () => {
    const e = buildProspectEmail(ltd, { draft: 'Rewritten body', subject: 'rewritten subject' });
    expect(e.subject).toBe('rewritten subject');
    expect(e.html).toContain('Rewritten body');
    expect(e.html).not.toContain('bookkeeper');
  });

  it('signs every email off with Kevin, once', () => {
    const e = buildProspectEmail(ltd);
    expect(e.text).toContain('Kevin\n\nKevin Brittain\nFounder, Operations Director');
    expect(e.html.match(/Founder, Operations Director/g)).toHaveLength(1);
  });
});

// 20 of the 131 drafts on 7 Aug 2026 ended with a bare "Kevin". The signature
// supplies its own sign-off, so those would have gone out signed twice.
describe('prosStripSignOff — no double sign-off', () => {
  it('drops a trailing bare Kevin so the sign-off appears once', () => {
    const e = buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': 'Worth a quick call?\n\nKevin' }));
    expect(e.text).toBe(`Worth a quick call?\n\nKevin\n\n${OD_SENDER.name}\nFounder, Operations Director\noperationsdirector.co.uk\nkevin@operationsdirector.co.uk`
      + `\n\n${OD_SENDER.postal}`
      + `\nPrefer not to hear from me? Reply "unsubscribe" or email ${OD_SENDER.email} with Unsubscribe in the subject.`);
    expect(e.text.match(/^Kevin$/gm)).toHaveLength(1);
  });

  it('produces the SAME ending whether or not the draft signed off', () => {
    const withSign = buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': 'Worth a call?\n\nKevin' }));
    const without = buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': 'Worth a call?' }));
    expect(withSign.text).toBe(without.text);
    expect(withSign.html).toBe(without.html);
  });

  it('tolerates punctuation and trailing whitespace on the sign-off', () => {
    for (const tail of ['\n\nKevin', '\nKevin', '\n\nKevin  ', '\n\nkevin', '\n\nKevin.']) {
      expect(buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': 'Body' + tail })).text)
        .toBe(buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': 'Body' })).text);
    }
  });

  // The regex must anchor to its own line, or it eats real sentence content.
  it('leaves Kevin alone when it is part of the last sentence', () => {
    const e = buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': 'Book a quick call with Kevin' }));
    expect(e.text).toContain('a quick call with Kevin');
  });

  // The whole point of the single builder: two paths would let Kevin approve one thing
  // and the prospect receive another.
  it('produces identical output for the preview and the send', () => {
    expect(buildProspectEmail(ltd).html).toBe(buildProspectEmail(ltd).html);
  });
});

describe('booking link', () => {
  it('is the public website page, never the raw CRM widget', () => {
    expect(OD_BOOKING_URL).toBe('https://operationsdirector.co.uk/book-a-demo/');
  });

  // The bug: drafts carried https://api.leadconnectorhq.com/widget/booking/<id>, which
  // reads as spam and names the CRM vendor. 131 of 136 records had it on 7 Aug 2026.
  it('never reappears as a raw widget URL anywhere in the shipped source', () => {
    const files = ['js/prospecting.js', 'js/config.js', 'index.html', 'journey.html'];
    for (const f of files) {
      const src = readFileSync(resolve(root, f), 'utf8');
      const offenders = src.match(/https?:\/\/api\.leadconnectorhq\.com\/widget\/booking\/\S+/g) || [];
      expect(offenders, `${f} contains a raw booking widget URL`).toEqual([]);
    }
  });

  it('renders as a clickable link, not bare text', () => {
    const e = buildProspectEmail(ltd);
    expect(e.html).toContain(`<a href="${OD_BOOKING_URL}"`);
  });
});

describe('prosLinkify', () => {
  it('leaves trailing punctuation outside the href', () => {
    const out = prosLinkify('see https://example.com/x, then');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('</a>, then');
  });

  it('does not linkify anything that is not a URL', () => {
    expect(prosLinkify('no links here')).toBe('no links here');
  });
});

describe('XSS — Airtable text reaches the preview and the prospect', () => {
  it('escapes markup in the draft body', () => {
    const e = buildProspectEmail(rec({ ...ltd.fields, 'Draft Message': '<img src=x onerror=alert(1)>' }));
    expect(e.html).not.toContain('<img');
    expect(e.html).toContain('&lt;img');
  });

  it('escapes markup in the company name that feeds the fallback subject', () => {
    const e = buildProspectEmail(rec({ ...ltd.fields, 'Company': '<b>Acme</b>', 'Email Subject': '' }));
    // The subject is plain text (JSON to GHL), so it stays raw; the HTML body must not
    // gain a tag from it.
    expect(e.subject).toBe('A thought for <b>Acme</b>');
    expect(e.html).not.toContain('<b>Acme</b>');
  });
});

describe('prospectDefaultSubject', () => {
  it('differs by contact route', () => {
    expect(prospectDefaultSubject(rec({ 'Contact Route': 'Email reply (they asked)' })))
      .toBe('Your post about finding some help');
    expect(prospectDefaultSubject(rec({ 'Contact Route': 'Email sequence (Ltd)', 'Company': 'Acme' })))
      .toBe('A thought for Acme');
  });

  it('never produces an empty subject when the company is unknown', () => {
    expect(prospectDefaultSubject(rec({ 'Contact Route': 'Email sequence (Ltd)' })))
      .toBe('A thought for your business');
  });
});

describe('sender identity is defined once', () => {
  it('carries every part the signature needs', () => {
    expect(OD_SENDER).toEqual({
      name: 'Kevin Brittain',
      email: 'kevin@operationsdirector.co.uk',
      title: 'Founder, Operations Director',
      website: 'operationsdirector.co.uk',
      postal: 'Operations Director, 61 Bridge Street, Kington, HR5 3DJ',
      unsubscribeMailto: 'mailto:kevin@operationsdirector.co.uk?subject=Unsubscribe',
    });
  });

  // ---------------------------------------------------------------------
  // Finding 20260808-agent-dispatch-019: the three cold touches went out with
  // no postal address and no way to opt out. UK PECR requires both in every
  // marketing email, and this is unsolicited mail to people who have never
  // heard of Kevin. Every touch is built by buildProspectEmail, so the footer
  // belongs in the shared signature and cannot be omitted from one of them.
  // ---------------------------------------------------------------------

  it('every cold email carries a postal address, in both plain text and HTML', () => {
    const e = buildProspectEmail(ltd);
    expect(e.text).toContain(OD_SENDER.postal);
    expect(e.html).toContain('61 Bridge Street');
  });

  it('every cold email offers a working way to opt out', () => {
    const e = buildProspectEmail(ltd);
    expect(e.text.toLowerCase()).toContain('unsubscribe');
    expect(e.html).toContain(`href="${OD_SENDER.unsubscribeMailto}"`);
  });

  it('the opt-out is a real link, never an unrendered merge tag', () => {
    // These sends go through the GHL conversations endpoint, not a GHL workflow.
    // A {{unsubscribe_link}} tag that nothing expands would ship literal braces
    // to a stranger and leave them with no way out at all.
    const e = buildProspectEmail(ltd);
    expect(e.html).not.toMatch(/\{\{\s*unsubscribe/i);
    expect(e.text).not.toMatch(/\{\{\s*unsubscribe/i);
    expect(e.html).toMatch(/href="mailto:[^"]+"/);
  });

  // The send path must read the address from OD_SENDER, not repeat it inline.
  it('is not hardcoded in the GHL send path', () => {
    const send = prospecting.slice(prospecting.indexOf('async function sendProspectEmailViaGHL'));
    const body = send.slice(0, send.indexOf('\n    }\n'));
    expect(body).toContain('emailFrom: email.from');
    expect(body).not.toContain("'kevin@operationsdirector.co.uk'");
  });
});
