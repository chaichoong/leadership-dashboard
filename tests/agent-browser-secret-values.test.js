// The browser lane's value guard (18 Nov 2026). It used to run the field-NAME words (password, cvv, token, ...) over
// the whole value as a bare substring. Episode 2187's Spotify description said "Add friction, such as a password after
// a set daily limit" and was refused on three hourly runs, then held; 2162's Facebook shares were refused because the
// YouTube link id held "Cvv". Meanwhile a real API key passed, because it holds none of the words. These pin both sides:
// real episode copy passes, and a real key, a labelled secret and a secret-named word still fail.
//
// The episode copy below is invented in the shape of 2187's (paragraphs, distances, hashtags, a link). The keys are
// built at run time from parts, so no key-shaped string sits in this public repo for a scanner to flag.
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = createRequire(import.meta.url)(resolve(ROOT, 'scripts/agent-browser.js'));
const pageWith = (attrs) => ({ $eval: async () => attrs });
const field = pageWith({ type: 'text', name: 'description' });

const DESCRIPTION = [
  'Phone habits are today\'s topic on day 3,456 of my daily run. I split the problem in two: scrolling, and games.',
  '',
  'If screen time is a problem for you, my suggestions are simple. Check your screen time data and write down the number. ' +
    'Add friction, such as a password after a set daily limit, or an app blocker which locks apps until certain times.',
  '',
  'So far I have covered 12,345.67km of the 40,075km lap of the world. The secret? Show up every day. Thank you for listening.',
  ' #habits #adhd #runnerslifestyle #stravarun',
].join('\n');
// a link whose 11-character id holds "Cvv", as 2162's did
const SHARE = 'Small changes add up. Today is Day 3,457, and I looked at one example.\n\nhttps://youtu.be/7CvvQa_9Lm2';

const KEYS = {
  'an Anthropic key': ['sk', 'ant', 'api03', 'Zq8'.repeat(12)].join('-'),
  'an OpenAI key': ['sk', 'proj', 'Ab3d'.repeat(8)].join('-'),
  'an Airtable token': 'pat' + 'Qw3rTy5uIo9pAs' + '.' + 'ab12'.repeat(16),
  'a GitHub token': ['ghp', 'Zx9'.repeat(12)].join('_'),
  'a signed token': ['eyJhbGciOiJIUzI1', 'eyJzdWIiOiIxMjM0', 'c2lnbmF0dXJlX19f'].join('.'),
  'a long random string': 'Q9' + 'wErT5yUi8oPa3sDf'.repeat(2),
};

describe('browser lane: the value guard reads what a value IS, not a word inside it', () => {
  it('lets a real episode description through, even with "password" in a sentence (2187)', async () => {
    expect(browser.secretValueReason(DESCRIPTION)).toBe('');
    await expect(browser.assertNotCredential(field, "textarea[name='description']", DESCRIPTION)).resolves.toBeUndefined();
  });

  it('lets a share through whose YouTube link id holds "Cvv" (2162)', async () => {
    expect(browser.secretValueReason(SHARE)).toBe('');
    await expect(browser.assertNotCredential(field, "[role='dialog'] [contenteditable='true']", SHARE)).resolves.toBeUndefined();
  });

  it('control: the old check refused both, so the two tests above prove a change', () => {
    expect(browser.SECRET_NAME_RE.test(DESCRIPTION)).toBe(true);
    expect(browser.SECRET_NAME_RE.test(SHARE)).toBe(true);
  });

  it.each(Object.entries(KEYS))('refuses %s, alone or inside a sentence', async (_label, key) => {
    expect(browser.secretValueReason(key)).not.toBe('');
    expect(browser.secretValueReason('Here is the key you wanted: ' + key + ' thanks')).not.toBe('');
    await expect(browser.assertNotCredential(field, '#f', key)).rejects.toThrow(/looks like a secret/i);
  });

  it('control: the old check let a real key through, so the refusals above are new protection', () => {
    expect(browser.SECRET_NAME_RE.test(KEYS['an Anthropic key'])).toBe(false);
    expect(browser.SECRET_NAME_RE.test(KEYS['an Airtable token'])).toBe(false);
  });

  it.each(['api_key=abc123', 'password: hunter22', 'Password: correcthorsebattery', 'API key: abcdefghijklmnop',
    'OTP: 123456', 'token = x', 'client_secret=abc', 'Secret: abcd1234efgh', 'MyPassword123', 'cvv',
    // third review (18 Nov 2026): the ways a robot passes on a code or a login, which the old guard refused
    'Your OTP is 483920', 'My password is Tr0ub4dor&3', 'Password - Hunter22!', 'Here is the password: correcthorsebattery',
    'client secret: abcdefghijklmnopqrst', 'The WiFi password is sunflower', 'The password is correcthorsebattery'])
    ('still refuses a labelled secret or a secret-named word: %s', (v) => {
      expect(browser.secretValueReason(v)).not.toBe('');
    });

  // card numbers and the shapes of keys this estate holds; each built from parts so no real-looking value is committed
  it.each([
    ['a test card number', ['4111', '1111', '1111', '1111'].join(' ')],
    ['a dashed card number', ['5555', '5555', '5555', '4444'].join('-')],
    ['a GoHighLevel token', 'pit-' + ['1a2b3c4d', '5e6f', '7a8b', '9c0d', '1e2f3a4b5c6d'].join('-')],
    ['a capital-letter UUID key', ['1A2B3C4D', '5E6F', '7A8B', '9C0D', '1E2F3A4B5C6D'].join('-')],
    ['a Google access token', 'ya29' + '.' + 'a0Af'.repeat(8)],
    ['a long hex secret', 'ab12cd34'.repeat(6)],
  ])('refuses %s', (_label, v) => {
    expect(browser.secretValueReason(v)).not.toBe('');
    expect(browser.secretValueReason('use ' + v + ' for this')).not.toBe('');
  });

  it.each(['5482505', 'The secret: consistency.', 'The secret: 10,000 steps', 'Top secret: 2026', 'My secret: 5am.',
    'Day 2,187: 16,777.69km run, 23,297.31km left', 'https://www.facebook.com/reel/1908741580501895',
    'Episode 2187 - Screen Addiction, Gaming and ADHD', '#TheUltimateUltraMarathon2026Challenge', 'youtu.be/7CvvQa_9Lm2',
    'Watch the series: www.youtube.com/playlist?list=PLaB3dE5gH7jK9mN1pQ3rS5tU7vW9xY0zA', 'Raised £76,975 so far', '',
    // second review (18 Nov 2026): sentences and references that only look like a label or a card
    'Turn on 2FA: always.', 'Every token: earned', 'Your card number: never share it', 'The secret = showing up',
    'Order 203-1234566-7654321 arrived', 'Meter 2012345670007 read today', 'TheUltimateUltraMarathon2026Challenge',
    'See https://example.org/item/1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D for the form',
    'Passcode: lock apps after 9pm', 'OTP: never share it', 'Token: 10,000 steps', 'A password is a lock, not a wall', 'A password is a lock on your phone', 'Your password is weak'])
    ('allows ordinary text: %s', (v) => {
      expect(browser.secretValueReason(v)).toBe('');
    });

  it('reads a very long value in linear time (no backtracking blow-up)', () => {
    const long = ('a-b.c-d '.repeat(12500)) + 'end';          // 100 KB of hyphens and dots, the slow shape for \b
    const t0 = Date.now();
    expect(browser.secretValueReason(long)).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('never puts the value in the refusal message', async () => {
    const key = KEYS['an Anthropic key'];
    const err = await browser.assertNotCredential(field, '#f', key).catch((e) => e);
    expect(String(err && err.message)).toMatch(/looks like a secret \(an API key\)/);
    expect(String(err && err.message)).not.toContain(key.slice(0, 12));
  });
});
