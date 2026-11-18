// Gmail send-path attachments (built 25 Aug 2026 for the Accounts Payable
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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// ─── The file guards in scripts/send-email.py (load_attachment), driven for real ───
//
// Two findings held approved messages for weeks against this one function:
//   * 20261014-agent-dispatch-862 — the allowlist took .pdf, .png and .jpg only, so an
//     approved message attaching a fillable Word form could not go. Sending it as a PDF
//     would have changed what Kevin approved and left Roy unable to fill it in.
//   * 20261030-agent-dispatch-1143 and 20261113-agent-dispatch-1301 — twice, the approved
//     ATTACH header named the file where the agent had built it (the dispatcher's own run
//     folder) and the only root allowed was the attachments directory. Moving the file
//     would have changed the approved text, so both cards sat unsent.
// Back-test: put ATTACH_EXTENSIONS and the single-root check back and every case below fails.
const LOAD_PY = `
import json, os, sys, importlib.util
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
os.environ["SEND_EMAIL_ATTACH_DIR"] = sys.argv[1]
os.environ["AGENT_DISPATCH_DIR"] = sys.argv[2]
spec = importlib.util.spec_from_file_location("send_mod", ${JSON.stringify(SEND)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    print(json.dumps({"ok": True, "payload": m.load_attachment(sys.argv[3], "recTEST")}))
except SystemExit as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

// The task the harness sends as. The run folder is named for it on purpose: round 2 of
// PR 962 made the ONE sendable shape under the dispatcher's state directory
// `<run>/<this task's id>/<file>`, so a folder named for anything else is refused.
const TASK = 'recTEST';

function attachTree(file, where) {
  const base = mkdtempSync(resolve(tmpdir(), 'attach-'));
  const attachDir = resolve(base, 'attachments');
  const runRoot = resolve(base, 'runs');
  const runDir = resolve(runRoot, '20261118-070000', TASK);
  mkdirSync(attachDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const dirs = {
    attach: attachDir,
    run: runDir,
    runLevel: resolve(runRoot, '20261118-070000'),
    otherTask: resolve(runRoot, '20261118-070000', 'recOTHERTASK'),
    nested: resolve(runDir, 'scratch'),
  };
  const dir = dirs[where];
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, file);
  writeFileSync(path, 'file bytes');
  return { attachDir, runRoot, path };
}

function loadAttachment({ file, inAttachDir, where }) {
  const t = attachTree(file, where || (inAttachDir ? 'attach' : 'run'));
  const out = execFileSync('python3', ['-c', LOAD_PY, t.attachDir, t.runRoot, t.path], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

// The SUBMIT gate, through the real validate_submission_any — the same two checks the
// send path runs, run before Kevin decides (round 2 of PR 962).
const SUBMIT_PY = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
os.environ["SEND_EMAIL_ATTACH_DIR"] = sys.argv[1]
os.environ["AGENT_DISPATCH_DIR"] = sys.argv[2]
import agent_email_format as fmt
out = ("TO: office@example-agents.test\\nFROM: " + fmt.PROPERTY_SENDER + "\\n"
       "SUBJECT: Title register for 57 Example Street\\n"
       "ATTACH: " + sys.argv[3] + "\\n---\\nDear Sir or Madam,\\n\\n"
       "The title register is attached.\\n\\nKind regards\\nRoy Lavin\\nAgile Lets\\n\\n"
       "**Carrying this out will involve:** sending this email.")
try:
    fmt.validate_submission_any(out, task_name="INBOUND: title register", task_id=${JSON.stringify(TASK)})
    print(json.dumps({"ok": True}))
except fmt.EmailFormatError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

function submitAttach({ file, where }) {
  const t = attachTree(file, where);
  const out = execFileSync('python3', ['-c', SUBMIT_PY, t.attachDir, t.runRoot, t.path], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

describe('load_attachment (real scripts/send-email.py)', () => {
  it('takes a .docx from the attachments directory: the form Roy has to fill in (862)', () => {
    const r = loadAttachment({ file: 'police-form.docx', inAttachDir: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.payload.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.payload.filename).toBe('police-form.docx');
  });

  it('takes a file the agent built in this task\'s own run folder, approved path untouched (1143)', () => {
    const r = loadAttachment({ file: 'title-register.png', where: 'run' });
    expect(r.ok, r.error).toBe(true);
    expect(r.payload.mimeType).toBe('image/png');
  });

  // CONTROL for the narrowing the reviewer asked for in round 2 of PR 962. The dispatcher's
  // state directory is NOT an attachments directory: it holds queue.json (tenant names, rent
  // figures, email bodies), the run's own prep and report scripts, and every other task's
  // scratch. Exactly one shape under it is sendable — <run>/<this task's id>/<file> — so the
  // run level, another task's folder and anything nested deeper are all still refused.
  it('the dispatcher state directory is not a root: only this task\'s own run folder is', () => {
    for (const where of ['runLevel', 'otherTask', 'nested']) {
      const r = loadAttachment({ file: 'queue.pdf', where });
      expect(r.ok, where).toBe(false);
      expect(r.error, where).toMatch(/not in this task's own run folder/);
    }
  });

  // CONTROL: the injection guard is what this function exists for. A path outside BOTH
  // fixed roots is still refused, and so is a type nobody has asked for.
  it('a path outside both roots is still refused', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'attach-'));
    const attachDir = resolve(base, 'attachments');
    const runRoot = resolve(base, 'runs');
    mkdirSync(attachDir, { recursive: true });
    mkdirSync(runRoot, { recursive: true });
    const outside = resolve(base, 'secret.pdf');
    writeFileSync(outside, 'x');
    const out = execFileSync('python3', ['-c', LOAD_PY, attachDir, runRoot, outside], { encoding: 'utf8' });
    const r = JSON.parse(out.trim());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/outside the attachments directory/);
  });

  it('a macro-bearing .docm, and anything else off the list, is still refused (862 control)', () => {
    for (const file of ['form.docm', 'script.sh', 'book.xlsx']) {
      const r = loadAttachment({ file, inAttachDir: true });
      expect(r.ok, file).toBe(false);
      expect(r.error).toMatch(/not allowed/);
    }
  });

  // THE CAUSE, NOT THE SYMPTOM (round 2 of PR 962). Submit read ATTACH for shape only, so an
  // output naming a type or a folder the send path refuses was approved first and refused days
  // later, after Kevin had decided. Both paths now run the same two functions.
  // Back-test: drop the attach_submit_problem call from validate_submission_any and both fail.
  it('submit refuses a type the send path would refuse, before Kevin decides (862)', () => {
    const bad = submitAttach({ file: 'form.docm', where: 'attach' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/type \.docm is not allowed/);
    const good = submitAttach({ file: 'police-form.docx', where: 'attach' });
    expect(good.ok, good.error).toBe(true);
  });

  it('submit refuses a folder the send path would refuse, before Kevin decides (1301)', () => {
    const bad = submitAttach({ file: 'queue.pdf', where: 'runLevel' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not in this task's own run folder/);
    // And it accepts the path that got the two cards stuck, so nothing has to be re-approved
    // just to move a file: this task's own run folder.
    const good = submitAttach({ file: 'title-register.png', where: 'run' });
    expect(good.ok, good.error).toBe(true);
  });

  it('the worker allowlist agrees with the script, or the send fails at the worker (862)', () => {
    expect(lib.attachmentProblem({ filename: 'f.docx', dataB64: 'AAAA',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBeNull();
    expect(lib.attachmentProblem({ filename: 'f.docm', dataB64: 'AAAA',
      mimeType: 'application/vnd.ms-word.document.macroEnabled.12' })).toBeTruthy();
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
