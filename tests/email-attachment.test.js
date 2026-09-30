// Gmail send-path attachments (built 25 Aug 2026 for the Creditor Management
// agent: its standing debt-correspondence letter attaches the first three
// pages of a legal document).
//
// The contract has three layers, each tested against the REAL source:
//   1. scripts/agent_email_format.py accepts exactly one ATTACH header —
//      covered by send-email.py's offline selftest (run below).
//   2. scripts/send-email.py enforces the file guards (allowlisted directory,
//      symlink-resolved, extension, size) — also in the selftest, exercised
//      against real files in a throwaway directory. The guards are the whole
//      defence against an injected "ATTACH: ~/.config/od/<secret>" header
//      riding an approved email out.
//   3. workers/drive-upload/worker.js builds the multipart MIME — extracted
//      and executed here, because a malformed raw message fails at Gmail's
//      end AFTER Kevin has approved the send.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const WORKER = readFileSync(resolve(ROOT, 'workers/drive-upload/worker.js'), 'utf8');
const SEND = resolve(ROOT, 'scripts/send-email.py');

function extract(name, kind = 'function') {
  const marker = kind === 'function' ? `function ${name}(` : `const ${name} = `;
  let start = WORKER.indexOf(marker);
  if (start === -1) throw new Error(`${name} not found in worker.js`);
  if (kind === 'const') {
    const end = WORKER.indexOf(';', start);
    return WORKER.slice(start, end + 1);
  }
  // The body brace is the first `{` AFTER the parameter list closes —
  // buildRawEmail destructures its parameter, so the naive first-`{` is the
  // parameter object and the walk ends at `}` of the destructuring.
  const paramsClose = WORKER.indexOf(')', start);
  let i = WORKER.indexOf('{', paramsClose), depth = 0;
  for (; i < WORKER.length; i++) {
    if (WORKER[i] === '{') depth++;
    else if (WORKER[i] === '}') { depth--; if (depth === 0) return WORKER.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

// Concatenated, never a template literal: the extracted worker source itself
// contains `${...}` sequences that an outer template would interpolate.
// eslint-disable-next-line no-new-func
const lib = new Function([
  extract('b64url'),
  extract('ATTACH_MIME_ALLOWED', 'const'),
  extract('ATTACH_B64_MAX', 'const'),
  extract('buildRawEmail'),
  extract('attachmentProblem'),
  'return { buildRawEmail, attachmentProblem };',
].join('\n'))();

const decodeRaw = (raw) => atob(raw.replace(/-/g, '+').replace(/_/g, '/'));

describe('buildRawEmail (real worker source)', () => {
  const base = { to: 'a@b.com', subject: 'Hello £ world', text: 'Body text', from: 'me@x.com' };
  const attachment = {
    filename: 'restraint-order-p1-3.pdf',
    mimeType: 'application/pdf',
    dataB64: btoa('%PDF-1.4 fake'),
  };

  it('without an attachment the proven single-part shape is unchanged', () => {
    const mime = decodeRaw(lib.buildRawEmail(base));
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).not.toContain('multipart/mixed');
    expect(mime).toContain('To: a@b.com');
  });

  it('with an attachment it builds multipart/mixed with both parts intact', () => {
    const mime = decodeRaw(lib.buildRawEmail({ ...base, attachment }));
    const boundary = mime.match(/boundary="([^"]+)"/)[1];
    expect(mime).toContain('Content-Type: multipart/mixed');
    // Two opening boundaries and one closing terminator.
    expect(mime.split(`--${boundary}`).length - 1).toBe(3);
    expect(mime).toContain(`--${boundary}--`);
    expect(mime).toContain('Content-Disposition: attachment; filename="restraint-order-p1-3.pdf"');
    expect(mime).toContain('Content-Type: application/pdf; name=');
    // The body and the file both survive the round trip.
    expect(mime).toContain(btoa('Body text'));
    expect(mime).toContain(attachment.dataB64);
    // From survives so a send-as alias keeps its identity.
    expect(mime).toContain('From: me@x.com');
  });

  it('sanitises a hostile filename before it reaches a MIME header', () => {
    const mime = decodeRaw(lib.buildRawEmail({ ...base, attachment: {
      ...attachment, filename: 'a"\r\nBcc: evil@x.com;.pdf' } }));
    // No header injection: the CRLF and quote are gone from the disposition.
    expect(mime).not.toMatch(/Bcc: evil/);
    expect(mime).toMatch(/filename="a___Bcc_ evil_x\.com_\.pdf"/);
  });
});

describe('attachmentProblem (worker-side floor)', () => {
  const ok = { filename: 'f.pdf', mimeType: 'application/pdf', dataB64: 'AAAA' };
  it('accepts the shape send-email.py sends', () => {
    expect(lib.attachmentProblem(ok)).toBeNull();
  });
  it('refuses missing pieces, bad mime, oversize and non-base64', () => {
    expect(lib.attachmentProblem(null)).toBeTruthy();
    expect(lib.attachmentProblem({ ...ok, filename: '' })).toBeTruthy();
    expect(lib.attachmentProblem({ ...ok, mimeType: 'text/html' })).toBeTruthy();
    expect(lib.attachmentProblem({ ...ok, dataB64: '' })).toBeTruthy();
    expect(lib.attachmentProblem({ ...ok, dataB64: 'not base64 ***' })).toBeTruthy();
    expect(lib.attachmentProblem({ ...ok, dataB64: 'A'.repeat(7 * 1024 * 1024 + 1) })).toBeTruthy();
  });
});

describe('the send endpoint actually gates on it', () => {
  it('validates the attachment before building the message, and passes it through', () => {
    expect(WORKER).toMatch(/attachmentProblem\(attachment\)/);
    expect(WORKER).toMatch(/attachment: attachment \|\| undefined/);
  });
});

describe('the python layers hold (offline selftest, real files)', () => {
  it('parser + file guards all pass, symlink escape included', () => {
    const out = execFileSync('python3', [SEND, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/PASS parses ATTACH/);
    expect(out).toMatch(/PASS refuses a path outside the attachments dir/);
    expect(out).toMatch(/PASS refuses a symlink escaping the dir/);
    expect(out).toMatch(/PASS refuses an oversize file/);
    expect(out).toMatch(/selftest OK/);
  });
});

// 30 Sep 2026: Roy's email of 3 Aug carried the Agile Estates authentication-code letter as two
// photos pasted into the body (inline JPEGs, ~3.5 MB each). The worker skipped every inline part,
// so no agent could see or save them, and Kevin asked on the card how to fix it. A small inline
// image (a logo, a tracking pixel) is still skipped; a real photo and an inline document count.
describe('extractAttachments keeps photos pasted into the body (real worker source)', () => {
  // eslint-disable-next-line no-new-func
  const { extractAttachments } = new Function([
    extract('INLINE_PHOTO_MIN_BYTES', 'const'),
    extract('extractAttachments'),
    'return { extractAttachments };',
  ].join('\n'))();
  const part = (filename, mimeType, size, disposition, id) => ({
    filename, mimeType, body: { attachmentId: id, size },
    headers: disposition ? [{ name: 'Content-Disposition', value: `${disposition}; filename="${filename}"` }] : [],
  });
  // The shape of Roy's message: multipart/related holding the HTML body and the inline photos.
  const roy = {
    mimeType: 'multipart/mixed', filename: '', body: { size: 0 }, parts: [
      { mimeType: 'multipart/related', filename: '', body: { size: 0 }, parts: [
        { mimeType: 'text/html', filename: '', body: { size: 120, data: 'PGI-' } },
        part('Image_260803_141144.jpeg', 'image/jpeg', 3600000, 'inline', 'att1'),
        part('Image_260803_141202.jpeg', 'image/jpeg', 3500000, 'inline', 'att2'),
        part('logo.png', 'image/png', 8200, 'inline', 'att3'),
        part('pixel.gif', 'image/gif', 43, 'inline', 'att4'),
      ] },
      part('invoice.pdf', 'application/pdf', 250000, 'attachment', 'att5'),
      part('statement.pdf', 'application/pdf', 90000, 'inline', 'att6'),
    ],
  };
  it('lists the two pasted photos and the inline PDF, flagged inline, and never the logo or the pixel', () => {
    const got = extractAttachments(roy);
    expect(got.map((a) => a.filename)).toEqual(['invoice.pdf', 'statement.pdf', 'Image_260803_141144.jpeg', 'Image_260803_141202.jpeg']);
    expect(got.find((a) => a.filename === 'invoice.pdf').inline).toBeUndefined();
    for (const f of ['statement.pdf', 'Image_260803_141144.jpeg', 'Image_260803_141202.jpeg']) {
      expect(got.find((a) => a.filename === f).inline).toBe(true);
    }
  });
  it('an inline image just under the line is a logo; at the line it is a photo', () => {
    const one = (size) => extractAttachments({ mimeType: 'multipart/related', filename: '', body: {}, parts: [part('x.jpg', 'image/jpeg', size, 'inline', 'a')] });
    expect(one(100 * 1024 - 1)).toEqual([]);
    expect(one(100 * 1024)).toHaveLength(1);
  });
});
