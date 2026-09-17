import { describe, it, expect, afterEach, vi } from 'vitest';

// ── EMAIL REPLIES TO FORWARDED TEXTS GO BACK AS SMS (Kevin, 17 Sep 2026) ───
//
// Tenant texts now land at info@agilelets.co.uk. A reply to the forwarded email
// must reach the tenant as an SMS. Only a message in a Google-authenticated SENT
// folder can trigger a text, each reply is sent once, and nothing writes KV on a
// tick with nothing to send (the account-wide free KV budget).

const WORKER_PATH = '../workers/sms-email-bridge/worker.js';

function makeKv() {
  const store = new Map();
  return {
    puts: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.puts += 1; store.set(k, v); },
  };
}

const REPLY = {
  id: 'msg1',
  headers: { subject: 'Re: [SMS] Jane Cole: kitchen tap leaking' },
  body: 'Roy will come round tomorrow at 10.\n\nKind regards,\nRoy Lavin\n\nOn Thu, 17 Sep 2026 at 09:12, SMS from Jane Cole <\nsms@operationsdirector.co.uk> wrote:\n> kitchen tap leaking\n> GHL Conversation: conv123abc',
};

afterEach(() => vi.unstubAllGlobals());

describe('parseEmailReply', () => {
  it('takes the reply above the quote and the conversation id from the quote', async () => {
    const { parseEmailReply } = await import(WORKER_PATH);
    expect(parseEmailReply(REPLY)).toEqual({
      conversationId: 'conv123abc',
      text: 'Roy will come round tomorrow at 10.\n\nKind regards,\nRoy Lavin',
    });
  });

  it('reads the SMS_BRIDGE_ID marker a real Gmail reply quotes (Kevin, live test 17 Sep 2026)', async () => {
    const { parseEmailReply } = await import(WORKER_PATH);
    const real = {
      id: 'real1',
      headers: { subject: 'Re: [SMS] Kevin Brittain: Test' },
      body: 'Test reply\n\nKind regards,\n\nAgile Lets Team\n\n\nOn Thu, 17 Sept 2026 at 15:56, SMS from Kevin Brittain <\nsms@operationsdirector.co.uk> wrote:\n\n> SMS from Kevin Brittain\n> Test\n> Use Inbound Comms to reply as SMS to Kevin Brittain.\n> SMS_BRIDGE_ID:UrNw34NAriAEdl0ActzV\n>\n',
    };
    expect(parseEmailReply(real)).toEqual({
      conversationId: 'UrNw34NAriAEdl0ActzV',
      text: 'Test reply\n\nKind regards,\n\nAgile Lets Team',
    });
  });

  it('ignores forwards, mail without a conversation, and replies it cannot separate from the quote', async () => {
    const { parseEmailReply } = await import(WORKER_PATH);
    expect(parseEmailReply({ ...REPLY, headers: { subject: 'Fwd: [SMS] Jane Cole: tap' } })).toBeNull();
    expect(parseEmailReply({ ...REPLY, body: 'Thanks\n\nOn Thu wrote:\n> hi' })).toBeNull();
    expect(parseEmailReply({ ...REPLY, body: 'Thanks GHL Conversation: conv123abc' })).toBeNull();
    expect(parseEmailReply({ ...REPLY, body: 'On Thu, 17 Sep wrote:\n> GHL Conversation: conv123abc' })).toBeNull();
  });

  it('checks for replies every fifth minute only', async () => {
    const { isReplyCheckMinute } = await import(WORKER_PATH);
    expect(isReplyCheckMinute(Date.UTC(2026, 8, 17, 10, 5))).toBe(true);
    expect(isReplyCheckMinute(Date.UTC(2026, 8, 17, 10, 6))).toBe(false);
  });
});

describe('the relay sends each reply once, from the Sent folder only', () => {
  it('sends one SMS, marks it, and does not send it again on the next check', async () => {
    const worker = (await import(WORKER_PATH)).default;
    const kv = makeKv();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/gmail/list')) {
        return new Response(JSON.stringify({ messages: [REPLY] }), { status: 200 });
      }
      if (String(url).includes('/conversations/conv123abc')) {
        return new Response(JSON.stringify({ conversation: { contactId: 'contact9' } }), { status: 200 });
      }
      if (String(url).endsWith('/conversations/messages')) {
        return new Response(JSON.stringify({ messageId: 'sms1' }), { status: 200 });
      }
      // The GHL inbound poll this tick also runs: answer it with nothing new.
      return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
    }));
    const env = { SMS_STATE: kv, GMAIL_TRIAGE_KEY: 'k', GHL_API_KEY: 'g', GHL_LOCATION_ID: 'l' };
    const run = async () => {
      const waits = [];
      await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 17, 10, 5) }, env, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
    };
    await run();
    const sends = () => calls.filter((c) => c.url.endsWith('/conversations/messages'));
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toMatchObject({ type: 'SMS', contactId: 'contact9', conversationId: 'conv123abc',
      message: 'Roy will come round tomorrow at 10.\n\nKind regards,\nRoy Lavin' });
    const list = calls.find((c) => c.url.endsWith('/gmail/list'));
    expect(list.body.q).toBe('in:sent newer_than:1d subject:SMS');
    expect(list.body.account).toBe('info@agilelets.co.uk');
    await run();
    expect(sends()).toHaveLength(1);
  });

  it('does nothing without the Gmail key, and never on a non-check minute', async () => {
    const worker = (await import(WORKER_PATH)).default;
    const kv = makeKv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ conversations: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const waits = [];
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 17, 10, 5) }, { SMS_STATE: kv, GHL_API_KEY: 'g', GHL_LOCATION_ID: 'l' }, { waitUntil: (p) => waits.push(p) });
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 8, 17, 10, 6) }, { SMS_STATE: kv, GMAIL_TRIAGE_KEY: 'k', GHL_API_KEY: 'g', GHL_LOCATION_ID: 'l' }, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith('/gmail/list'))).toBe(false);
  });
});
