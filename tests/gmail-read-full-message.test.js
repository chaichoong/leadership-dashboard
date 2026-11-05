// ONE MESSAGE, READ IN FULL (5 Nov 2026, finding 20261102-agent-dispatch-1171).
//
// /gmail/list cuts every body at 4,000 characters. That is right for a scan —
// 25 full bodies in one worker reply is how the triage slot runs out of memory
// and reads nothing — and wrong for an agent that has to ANSWER a long email:
// it could read only the opening, and NOTHING in the reply said the rest
// existed. A silent cut is the whole fault, so both halves of the new route are
// tested for the cut being reported:
//
//   1. workers/drive-upload/worker.js gmailGet — extracted and RUN here
//      against a stubbed fetch, because a wrong shape fails at Gmail's end
//      after the worker is already deployed.
//   2. scripts/inbound-triage.py read --id — driven for real with worker_post
//      stubbed, so the printed JSON is the one an agent actually gets.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const WORKER = readFileSync(resolve(ROOT, 'workers/drive-upload/worker.js'), 'utf8');
const TRIAGE = resolve(ROOT, 'scripts/inbound-triage.py');

function extractFn(name) {
  const marker = `async function ${name}(`;
  const start = WORKER.indexOf(marker);
  if (start === -1) throw new Error(`${name} not found in worker.js`);
  const paramsClose = WORKER.indexOf(')', start);
  let i = WORKER.indexOf('{', paramsClose), depth = 0;
  for (; i < WORKER.length; i++) {
    if (WORKER[i] === '{') depth++;
    else if (WORKER[i] === '}') { depth--; if (depth === 0) return WORKER.slice(start, i + 1); }
  }
  throw new Error(`${name} body did not close`);
}

const CAP_LINE = WORKER.match(/const GMAIL_GET_BODY_CAP = (\d+);/);

/** Run the real gmailGet with fetch, and the extract* helpers, stubbed. */
async function runGmailGet(bodyText) {
  const src = `
    ${CAP_LINE[0]}
    const extractPlainText = () => BODY;
    const extractLinks = () => [{ href: 'https://example.test/x', text: 'Review' }];
    const extractAttachments = () => [{ attachmentId: 'a1', filename: 'Note.pdf', mimeType: 'application/pdf', size: 12 }];
    const fetch = async (url, opts) => {
      CALLS.push({ url, auth: opts.headers.Authorization });
      return {
        ok: true,
        json: async () => ({
          id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: '1762300000000',
          snippet: 'opening words',
          payload: { headers: [{ name: 'Subject', value: 'Long one' }, { name: 'From', value: 'a@b.test' }] },
        }),
      };
    };
    ${extractFn('gmailGet')}
    return gmailGet('tok', { id: 'm1' });
  `;
  const CALLS = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function('BODY', 'CALLS', `return (async () => { ${src} })()`);
  return { out: await fn(bodyText, CALLS), calls: CALLS };
}

function py(code) {
  const prog = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("t", ${JSON.stringify(TRIAGE)})
t = importlib.util.module_from_spec(spec)
sys.modules["t"] = t
spec.loader.exec_module(t)
${code}
`;
  return execFileSync('python3', ['-c', prog], { encoding: 'utf8' });
}

describe('an agent can read a whole email, and a cut is never silent', () => {
  it('the worker returns the full body and says how long it really was', async () => {
    const body = 'x'.repeat(50000);
    const { out, calls } = await runGmailGet(body);
    expect(out.body.length).toBe(50000);
    expect(out.bodyChars).toBe(50000);
    expect(out.bodyTruncated).toBe(false);
    // The tail is there — the whole point of the route.
    expect(out.body.endsWith('x')).toBe(true);
    expect(out.headers.subject).toBe('Long one');
    expect(out.attachments[0].filename).toBe('Note.pdf');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/messages\/m1\?format=full/);
    expect(calls[0].auth).toBe('Bearer tok');
  });

  it('past the 60k cap the body is cut AND the reply says so', async () => {
    const { out } = await runGmailGet('y'.repeat(70000));
    expect(out.body.length).toBe(Number(CAP_LINE[1]));
    expect(out.bodyChars).toBe(70000);
    expect(out.bodyTruncated).toBe(true);
  });

  it('the worker refuses a call with no message id', async () => {
    await expect(runGmailGet('short').then(async () => {
      const src = `${extractFn('gmailGet')}\nreturn gmailGet('tok', {});`;
      // eslint-disable-next-line no-new-func
      return new Function(`return (async () => { ${src} })()`)();
    })).rejects.toThrow(/id .*is required/);
  });

  it('/gmail/get is on the triage-key route list, not the send-key one', () => {
    expect(WORKER).toMatch(/url\.pathname === '\/gmail\/get'/);
    const guard = WORKER.slice(WORKER.indexOf("url.pathname === '/gmail/labels'"));
    // The dispatch for /gmail/get sits inside the GMAIL_TRIAGE_KEY block.
    const triageBlock = guard.slice(0, guard.indexOf('GMAIL_TRIAGE_KEY') + 4000);
    expect(triageBlock).toMatch(/await gmailGet\(accessToken, body\)/);
  });

  it('inbound-triage read prints the whole body, the length and the links', () => {
    const out = py(`
body = "A" * 12000 + "THE-TAIL"
t.worker_post = lambda path, payload: (
    CALLS.append((path, payload)) or {
        "id": "m1", "threadId": "t1", "labelIds": ["INBOX"],
        "headers": {"from": "a@b.test", "subject": "Long one", "date": "Wed, 5 Nov 2026"},
        "body": body, "bodyChars": len(body), "bodyTruncated": False,
        "links": [{"href": "https://example.test/x", "text": "Review"}],
        "attachments": [{"filename": "Note.pdf", "mimeType": "application/pdf", "size": 12}],
    })
CALLS = []
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    t.cmd_read("m1")
got = json.loads(buf.getvalue())
print(json.dumps({"got": got, "calls": CALLS}))
`);
    const { got, calls } = JSON.parse(out);
    expect(calls[0][0]).toBe('/gmail/get');
    expect(calls[0][1].id).toBe('m1');
    expect(got.bodyChars).toBe(12008);
    expect(got.body.endsWith('THE-TAIL')).toBe(true);
    expect(got.bodyTruncated).toBe(false);
    expect(got.note).toBeUndefined();
    expect(got.subject).toBe('Long one');
    expect(got.links[0].href).toBe('https://example.test/x');
  });

  it('a truncated read carries a plain-English note, so the agent knows', () => {
    const out = py(`
t.worker_post = lambda path, payload: {
    "id": "m1", "headers": {"subject": "Very long"},
    "body": "Z" * 60000, "bodyChars": 95000, "bodyTruncated": True,
}
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    t.cmd_read("m1")
print(buf.getvalue())
`);
    const got = JSON.parse(out);
    expect(got.bodyTruncated).toBe(true);
    expect(got.note).toMatch(/longer than 60,000 characters/);
    expect(got.note).toMatch(/95000 characters in all/);
  });

  it('read refuses a missing id and an account Kevin has not connected', () => {
    for (const call of ['t.cmd_read("")', 't.cmd_read("m1", "nobody@example.test")']) {
      let threw = '';
      try {
        py(`
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    ${call}
`);
      } catch (e) {
        threw = String(e.stderr || e.message);
      }
      expect(threw, call).not.toBe('');
    }
  });

  it('/gmail/list keeps its 4,000-character scan excerpt', () => {
    // The scan must NOT start carrying full bodies: 25 of them in one reply is
    // how the worker runs out of memory and the slot reads nothing.
    expect(WORKER).toMatch(/extractPlainText\(msg\.payload\)\.slice\(0, 4000\)/);
  });
});
