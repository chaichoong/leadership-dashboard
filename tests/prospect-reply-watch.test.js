import { describe, it, expect } from 'vitest';
// The worker is a real ES module, so the tests import the shipped functions
// directly — no copies that can drift from the source.
import { matchReplies, draftTaskFields } from '../workers/prospect-reply-watch/worker.js';

const prospect = (id, email, extra = {}) => ({
  id,
  fields: {
    'Contact Email': email,
    'Name': 'Jane Whitehouse',
    'Company': 'IS Group Signs Limited',
    'Pain Signal': 'Advertising a part-time bookkeeper.',
    'Draft Message': 'Hi Jane, I saw your ad. Worth a call?',
    'Email Subject': 'your part-time bookkeeper ad',
    ...extra,
  },
});

const conv = (over = {}) => ({
  id: 'conv1',
  email: 'enquiries@is-group.co.uk',
  lastMessageDirection: 'inbound',
  lastMessageType: 'TYPE_EMAIL',
  lastMessageBody: 'Yes, tell me more about pricing.',
  locationId: 'dgsH',
  ...over,
});

describe('matchReplies — only genuine new replies from watched prospects', () => {
  const watched = [prospect('recA', 'enquiries@is-group.co.uk')];

  it('matches an inbound email from a contacted prospect', () => {
    const out = matchReplies([conv()], watched);
    expect(out).toHaveLength(1);
    expect(out[0].prospect.id).toBe('recA');
    expect(out[0].conversationId).toBe('conv1');
    expect(out[0].replyPreview).toContain('pricing');
  });

  it('matches case-insensitively and ignores whitespace in the stored email', () => {
    const w = [prospect('recB', '  Enquiries@IS-Group.co.uk ')];
    expect(matchReplies([conv()], w)).toHaveLength(1);
  });

  // The OD location also carries system mail and our own outbound — the
  // watcher must never mistake our own sent email for a reply.
  it('ignores outbound messages', () => {
    expect(matchReplies([conv({ lastMessageDirection: 'outbound' })], watched)).toHaveLength(0);
  });

  it('ignores non-email channels (SMS lives in another lane entirely)', () => {
    expect(matchReplies([conv({ lastMessageType: 'TYPE_SMS' })], watched)).toHaveLength(0);
  });

  it('ignores senders we are not watching', () => {
    expect(matchReplies([conv({ email: 'stranger@example.com' })], watched)).toHaveLength(0);
  });

  it('collapses multiple conversations from one prospect into one reply', () => {
    expect(matchReplies([conv(), conv({ id: 'conv2' })], watched)).toHaveLength(1);
  });

  it('survives prospects with no email and empty conversation lists', () => {
    expect(matchReplies([], watched)).toHaveLength(0);
    expect(matchReplies([conv()], [prospect('recC', '')])).toHaveLength(0);
  });
});

describe('draftTaskFields — the task the dispatch engine picks up', () => {
  const r = matchReplies([conv()], [prospect('recA', 'enquiries@is-group.co.uk')])[0];
  const f = draftTaskFields(r, '2026-08-08');

  it('lands on the dispatch worklist: Status Today, due today, owned by the Writer agent', () => {
    expect(f['fldx4qCw17UfrKpaN']).toBe('Today');
    expect(f['fld7XP8w8kbxfETV4']).toBe('2026-08-08');
    expect(f['flduCtmQGpOA4eWaj']).toEqual(['recFMVmHmqAOVPAeJ']);
  });

  it('carries the full context so the draft needs no re-derivation', () => {
    const d = f['fldRGhBQViKZKtkQ6'];
    expect(d).toContain('THEIR REPLY');
    expect(d).toContain('tell me more about pricing');
    expect(d).toContain('bookkeeper');
    expect(d).toContain('book-a-demo');
  });

  // The engine's default Correspondence carry-out sends via Gmail. A prospect
  // reply must go back through the GHL conversation instead — the task says so
  // explicitly, and its type is NOT Correspondence so nothing routes it to
  // send-email.py by accident.
  it('routes the send through GHL, never Gmail', () => {
    expect(f['fldZ2moDV2041Sobc']).toBe('Prospect Reply');
    const d = f['fldRGhBQViKZKtkQ6'];
    expect(d).toContain('NOT a Gmail send');
    expect(d).toContain('conversation conv1');
    expect(d).toContain('User-Agent');
  });
});
