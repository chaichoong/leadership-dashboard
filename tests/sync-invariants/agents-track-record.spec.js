// Kevin, 29 Sep 2026: "something that lists everything we've built that stays
// updated in real time, so we have a track record and a kind of log of
// everything that we've built." The AI Agents page's Track record tab shows
// (1) the build log, read live from GitHub's public pull-request list, and
// (2) everything running, from the built-inventory row scripts/estate-status.py
// writes every ten minutes. Airtable and GitHub are both mocked here.
//
// The invariants: a failed or stale read says so in red and never renders as
// an empty list; a GitHub link is the only link a log row can carry.
const { test, expect } = require('@playwright/test');
const { defaultFixtures, mockAgentsPage, loadAgentsPage } = require('./agents-page.helpers');

const ES = { key: 'fldLO6xJqkokvVR4g', kind: 'fldfjQOn76VpgKEfZ', status: 'fldhOUiva3bqPNk1c',
  detail: 'fldLRFP2nJttDVQOa', payload: 'fldiqs9lvyLimoR7i', updated: 'fld3q8WN5XqrER92Z' };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const INVENTORY = {
  v: 1, generatedAt: ago(4),
  counts: { macJobs: 2, agentFiles: 1, skills: 1, workers: 1, githubTimers: 1, scheduledTasks: 1 },
  groups: [
    { id: 'mac-jobs', title: 'Scheduled jobs on the Mac', items: [
      { k: 'estate-status', n: 'Estate Status Board', w: 'every 10 min', s: 'on', d: 'Writes one line per job.', m: '2026-09-29' },
      { k: 'prospecting', n: 'Lead Finder slot', w: '10:00', s: 'parked', d: 'Parked until January.', m: '2026-09-27' },
    ] },
    { id: 'agent-files', title: 'AI agent files', items: [
      { k: 'od-ceo', n: 'od-ceo', s: 'live', d: 'The AI CEO.' },
    ] },
    { id: 'skills', title: 'Skills', items: [{ k: 'close-out', n: 'close-out', s: 'global', d: 'Session close-out.' }] },
    { id: 'workers', title: 'Cloudflare workers', items: [{ k: 'claude-proxy', n: 'claude-proxy', w: 'on request', s: 'on', d: 'Relays AI calls.' }] },
    { id: 'github-timers', title: 'GitHub workflows', items: [{ k: 'sync.yml', n: 'Sync projects', w: '41 * * * * (UTC)', s: 'timer', d: '' }] },
    { id: 'scheduled-tasks', title: 'Scheduled-task instructions', items: [{ k: 'daily-ops', n: 'daily-ops', s: 'on', d: 'The one daily routine.' }] },
  ],
  missing: { automations: [], workers: [], skills: ['close-out'] },
};

function builtRow(over = {}, payload = INVENTORY) {
  return { id: 'recBuilt', createdTime: ago(4), fields: Object.assign({
    [ES.key]: 'built-inventory', [ES.kind]: 'report', [ES.status]: 'Worked',
    [ES.detail]: '2 Mac jobs, 1 agent files', [ES.payload]: JSON.stringify(payload), [ES.updated]: ago(4) }, over) };
}

const PRS = [
  { number: 613, title: 'Fix: inbox triage decided no mail for 4 days', merged_at: ago(30), html_url: 'https://github.com/chaichoong/leadership-dashboard/pull/613' },
  { number: 612, title: 'Closed without merging', merged_at: null, html_url: 'https://github.com/chaichoong/leadership-dashboard/pull/612' },
  { number: 601, title: 'An older change', merged_at: ago(60 * 24 * 10), html_url: 'javascript:alert(1)' },
];

async function open(page, { estate = [builtRow()], github = { status: 200, body: PRS } } = {}) {
  await mockAgentsPage(page, Object.assign(defaultFixtures(), { estate }));
  let githubCalls = 0;
  await page.route('**/api.github.com/**', async (route) => {
    githubCalls += 1;
    await route.fulfill({ status: github.status, contentType: 'application/json', body: JSON.stringify(github.body) });
  });
  await loadAgentsPage(page);
  await page.click('#ptab-built');
  return { calls: () => githubCalls };
}

test.describe('AI Agents: Track record tab', () => {
  test('shows the live build log and everything running, grouped, with the gaps named', async ({ page }) => {
    await open(page);
    const log = page.locator('#builtLogBody');
    await expect(log).toContainText('Fix: inbox triage decided no mail for 4 days');
    await expect(log).toContainText('Today');
    await expect(log).not.toContainText('Closed without merging');       // unmerged PRs are not builds
    await expect(page.locator('#builtLogCount')).toHaveText('2');
    await expect(log.locator('a[href="https://github.com/chaichoong/leadership-dashboard/pull/613"]')).toHaveText('#613');
    // A non-GitHub URL is never rendered as a link, escaped or not.
    await expect(log.locator('a[href^="javascript"]')).toHaveCount(0);
    await expect(log).toContainText('An older change');

    const running = page.locator('#builtRunningBody');
    await expect(running.locator('details.built-group')).toHaveCount(7);   // register + six sources
    await expect(running).toContainText('Scheduled jobs on the Mac (1 active, 1 off or retired)');
    await expect(running).toContainText('AI agents in the register');
    await expect(page.locator('#builtGaps')).toContainText('Skills Library: close-out');
    // No tab badge: drift on the hand-kept lists is not Kevin's to act on (29 Sep 2026).
    await expect(page.locator('#ptab-built .page-tab-badge')).toHaveCount(0);
    await expect(page.locator('#builtSummary')).toContainText('2 Mac jobs · 1 agent file ·');
    await expect(page.locator('#builtSummary')).toContainText('1 change shipped in the last 7 days');
  });

  test('an open section stays open across a re-render', async ({ page }) => {
    await open(page);
    const mac = page.locator('details[data-built-group="mac-jobs"]');
    await mac.locator('summary').click();
    await expect(mac).toHaveAttribute('open', '');
    await page.evaluate(() => renderBuiltRunning());
    await expect(page.locator('details[data-built-group="mac-jobs"]')).toHaveAttribute('open', '');
  });

  test('GitHub refusing the read is a red, retryable error, not an empty log', async ({ page }) => {
    await open(page, { github: { status: 403, body: { message: 'API rate limit exceeded' } } });
    const log = page.locator('#builtLogBody');
    await expect(log).toContainText('Could not read the build log from GitHub');
    await expect(log).toContainText('60 reads an hour');
    await expect(log).toContainText('This list is NOT empty');
    await expect(page.locator('#builtLogCount')).toHaveText('?');
    await expect(log.locator('button', { hasText: 'Try again' })).toBeVisible();
  });

  test('a GitHub answer with nothing merged fails its control instead of reading as a quiet week', async ({ page }) => {
    await open(page, { github: { status: 200, body: [PRS[1]] } });
    await expect(page.locator('#builtLogBody')).toContainText('the read is wrong, not a quiet week');
  });

  test('a second visit within five minutes reuses the log instead of spending another GitHub read', async ({ page }) => {
    const gh = await open(page);
    await expect(page.locator('#builtLogBody')).toContainText('Fix: inbox triage');
    await page.click('#ptab-dashboard');
    await page.click('#ptab-built');
    await expect(page.locator('#builtLogBody')).toContainText('Fix: inbox triage');
    expect(gh.calls()).toBe(1);
  });

  test('a stale inventory warns that the writer has stopped', async ({ page }) => {
    await open(page, { estate: [builtRow({ [ES.updated]: ago(120) })] });
    await expect(page.locator('#builtRunningBody')).toContainText('The estate-status job that rebuilds it every ten minutes has stopped');
    await expect(page.locator('#builtRunningBody')).toContainText('Scheduled jobs on the Mac');
  });

  test('a failed build shows its reason, and a missing row says the job has not written it', async ({ page }) => {
    await open(page, { estate: [builtRow({ [ES.status]: 'Failed', [ES.detail]: 'read 0 Mac jobs (expected 20+)' }, { error: 'x' })] });
    await expect(page.locator('#builtRunningBody')).toContainText('read 0 Mac jobs (expected 20+)');
    await expect(page.locator('#builtRunningBody')).toContainText('This list is NOT empty');
    await expect(page.locator('#builtRunningCount')).toHaveText('?');
  });

  test('no built-inventory row at all is named, not shown as nothing built', async ({ page }) => {
    await open(page, { estate: [] });
    await expect(page.locator('#builtRunningBody')).toContainText('No everything-built list yet');
  });

  test('#tab=track-record opens the tab directly', async ({ page }) => {
    await mockAgentsPage(page, Object.assign(defaultFixtures(), { estate: [builtRow()] }));
    await page.route('**/api.github.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRS) }));
    await loadAgentsPage(page, 'tab=track-record');
    await expect(page.locator('#view-built')).toBeVisible();
    await expect(page.locator('#builtRunningBody')).toContainText('Scheduled jobs on the Mac');
  });
});
