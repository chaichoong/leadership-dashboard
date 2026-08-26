import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// sms-email-bridge polls GHL on a cron that fires EVERY MINUTE. It used to write
// the 'lastPollTime' heartbeat to KV on every one of those ticks: 1,440 writes a
// day against Cloudflare's free-tier limit of 1,000 per namespace per day.
//
// Nothing errors when that budget runs out — the put just fails — and the write
// that fails with it is 'lastMessageTimestamp', the checkpoint that stops an SMS
// being forwarded to Kevin twice. A status field was quietly starving the only
// piece of state that matters. (Finding 20260826-agent-dispatch-370.)
//
// This test drives the REAL scheduled handler over a simulated day and counts the
// puts, so it fails again if any unconditional per-tick write comes back.

const WORKER_PATH = '../workers/sms-email-bridge/worker.js';
const TOML = read('workers/sms-email-bridge/wrangler.toml');

/** Ticks per day for a 5-field cron, for the simple shapes this worker uses. */
function ticksPerDay(cron) {
  const [min, hour] = cron.trim().split(/\s+/);
  const perHour = min === '*' ? 60 : min.split(',').length;
  const hours = hour === '*' ? 24 : hour.split(',').length;
  return perHour * hours;
}

/** Minimal in-memory KV that counts writes the way Cloudflare bills them. */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    puts: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.puts += 1; store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
  };
}

describe('sms-email-bridge KV write budget', () => {
  let worker;
  let originalFetch;

  beforeEach(async () => {
    worker = (await import(WORKER_PATH)).default;
    originalFetch = globalThis.fetch;
    // GHL returns no conversations: the quiet case, which is nearly every tick.
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ conversations: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function runTicks(count, minutesApart, kv) {
    const env = {
      SMS_STATE: kv,
      GHL_API_KEY: 'test-key',
      GHL_LOCATION_ID: 'test-location',
      RESEND_API_KEY: 'test-resend',
      RECIPIENT_EMAIL: 'test@example.com',
    };
    for (let i = 0; i < count; i++) {
      const pending = [];
      await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
      vi.advanceTimersByTime(minutesApart * 60 * 1000);
    }
  }

  it('cron really does fire every minute (the premise of the bug)', () => {
    const crons = TOML.match(/crons\s*=\s*\[([^\]]*)\]/);
    expect(crons, 'no crons in wrangler.toml').not.toBeNull();
    const list = crons[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    expect(list.length).toBeGreaterThan(0);
    const total = list.reduce((n, c) => n + ticksPerDay(c), 0);
    expect(total).toBeGreaterThan(1000); // more ticks than the free-tier daily write budget
  });

  it('stays inside the 1000/day free-tier KV write limit over a full day of quiet ticks', async () => {
    const kv = makeKv();
    // A full day at one tick a minute would be 1,440 runs. 240 minutes is enough
    // to catch a per-tick write (240 puts) while keeping the test fast, so scale
    // the observed rate up to 24 hours and check the budget from that.
    await runTicks(240, 1, kv);
    const projectedPerDay = kv.puts * (1440 / 240);
    expect(projectedPerDay).toBeLessThan(1000);
    // Back-test: reverting to the unconditional put makes this 1,440.
    expect(kv.puts).toBeLessThanOrEqual(240 / 30 + 1);
  });

  it('still refreshes the heartbeat, so a dead worker is still visible', async () => {
    const kv = makeKv();
    await runTicks(4, 30, kv); // four ticks, half an hour apart
    expect(kv.puts).toBeGreaterThanOrEqual(3);
    const stamp = await kv.get('lastPollTime');
    expect(stamp, 'heartbeat never written').toBeTruthy();
    expect(Number.isFinite(Date.parse(stamp))).toBe(true);
  });

  it('/test reports the heartbeat cadence, so a stale stamp is not read as an outage', async () => {
    const kv = makeKv({ lastPollTime: new Date().toISOString() });
    const env = { SMS_STATE: kv, FROM_EMAIL: 'sms@example.com' };
    const resp = await worker.fetch(new Request('https://example.com/test'), env);
    const body = await resp.json();
    expect(body.polling.heartbeatEveryMinutes).toBeGreaterThan(1);
    expect(body.polling.staleAfterMinutes).toBeGreaterThan(body.polling.heartbeatEveryMinutes);
  });

  it('rewrites an unreadable or future-dated heartbeat rather than trusting it', async () => {
    const junk = makeKv({ lastPollTime: 'not-a-date' });
    await runTicks(1, 1, junk);
    expect(junk.puts).toBe(1);

    const future = makeKv({ lastPollTime: new Date(Date.now() + 86400000).toISOString() });
    await runTicks(1, 1, future);
    expect(future.puts).toBe(1);
  });
});
