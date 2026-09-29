// Opening the Systemisation page must not rebuild an SOP that is already built.
//
// Bug (found 29 Sep 2026 by the read-only prod walk): every load of
// os/systemisation/index.html in a browser without this page's localStorage reran the
// whole Loom-to-SOP pipeline for the one completed video task: a POST to claude-proxy
// (an AI call), an upload to Google Drive and PATCHes to the Systemisation Workflows
// record. The weekly Sunday walk did it on every run, and so did any new device or
// cleared cache.
//
// Root cause: checkVideoTasks() treats a Completed video task as "newly completed"
// whenever sys_vtask_status_<wfId> is not 'complete'. That flag lives only in
// localStorage, while the task link itself has been rebuilt from Airtable on every
// load since 2 Jul 2026 (rebuildVideoTaskTracking). So a fresh browser saw an old,
// long-processed task as brand new. The durable marker is the workflow's own
// [loom:URL] stamp in Airtable: if the workflow already carries the task's Loom, the
// SOP was built from that video and there is nothing to do on load.
//
// Both halves are pinned: an already-built SOP writes nothing, and a stale SOP (a new
// or changed Loom) or a missing one still fires the pipeline (the auto-import is a
// feature, not the bug). The page runs in a fresh browser context here, like the walk.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, stubExternalHosts } = require('./helpers');

// Table and field ids from os/systemisation/index.html (TBL, WF, ST, TASKS_TBL, TF).
const WORKFLOWS_TBL = 'tblLPoRHFBl0vqR24';
const TASKS_TBL = 'tblqB8b22hKBL4PF1';
const WF_NAME = 'fldsaS0jeoSRuJN28';
const WF_DESCRIPTION = 'fld1cGXzKp8ab5nBr';
const WF_SOP_DOCUMENT = 'fldW4qoDv2mrTNvu7';
const WF_FULFIL_STAGE = 'fldoN7pdUv4CIcKf2';
const STAGE = 'F - Find & Grab Attention';
const TF_STATUS = 'fldx4qCw17UfrKpaN';
const TF_NOTES = 'fldR7apBzSp3oxFxz';

const WF_ID = 'recWfRecon000001';
const TASK_ID = 'recTaskVideo00001';
const TASK_LOOM = 'https://www.loom.com/share/abc123def456';

const SOP_JSON = JSON.stringify({
    sopTitle: 'Reconciliation', sopSteps: [{ title: 'Open the bank feed', detail: 'Check it.' }],
    cautions: [], tips: [], generatedDate: '2026-09-01T09:00:00.000Z',
});

/**
 * Load the page with one workflow and one Completed video task carrying TASK_LOOM.
 * `workflowLoom` is the Loom already stamped on the workflow (null = none), and
 * `hasSop` whether the workflow already holds its SOP document.
 * Returns every write the page made, plus the reads that prove the code under
 * test actually ran.
 */
async function loadSystemisation(page, { workflowLoom, hasSop = true }) {
    const writes = [];
    const taskReads = [];

    await page.addInitScript((pat) => { localStorage.setItem('_dlr_pat', pat); }, MOCK_PAT);

    // Fonts, cdnjs and a default for the workers first: routes registered later win.
    await stubExternalHosts(page);

    // The AI proxy, the Drive upload and the Loom transcript workers, plus Loom itself.
    // Any request to these on load is the bug, whatever its method.
    const recordExternal = async (route) => {
        const req = route.request();
        writes.push({ method: req.method(), url: req.url().split('?')[0] });
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    };
    await page.route('**/*.workers.dev/**', recordExternal);
    await page.route('**/*loom.com/**', recordExternal);

    await page.route('**/api.airtable.com/v0/**', async (route) => {
        const req = route.request();
        const url = req.url();
        const method = req.method();

        if (method !== 'GET') {
            writes.push({ method, url: url.split('?')[0], body: req.postData() || '' });
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ id: 'recWritten', fields: {}, records: [] }),
            });
        }

        let records = [];
        if (url.includes(WORKFLOWS_TBL)) {
            const desc = 'Match every bank line to a cost or a rent.'
                + (workflowLoom ? '\n[loom:' + workflowLoom + ']' : '');
            records = [{ id: WF_ID, fields: {
                [WF_NAME]: 'Reconciliation',
                [WF_DESCRIPTION]: desc,
                [WF_FULFIL_STAGE]: STAGE,
                ...(hasSop ? { [WF_SOP_DOCUMENT]: SOP_JSON } : {}),
            } }];
        } else if (url.includes(TASKS_TBL)) {
            taskReads.push(decodeURIComponent(url));
            records = [{ id: TASK_ID, fields: {
                [TF_STATUS]: 'Completed',
                [TF_NOTES]: '[Systemisation] Workflow ID: ' + WF_ID + '\nRecorded: ' + TASK_LOOM,
            } }];
        }
        return route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ records }),
        });
    });

    await page.goto('/os/systemisation/index.html');
    return { writes, taskReads };
}

test('an already-imported Loom makes no write, AI call or upload on page load', async ({ page }) => {
    const { writes, taskReads } = await loadSystemisation(page, { workflowLoom: TASK_LOOM });

    // start() shows #main only after loadData(), which awaits checkVideoTasks() and,
    // under the bug, the whole pipeline. Then give any stray async write time to land.
    await expect(page.locator('#main')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);

    // Controls: the video-task check ran against this task and saw it as Completed.
    // Without these, a fixture the page ignored would pass while asserting nothing.
    expect(taskReads.some(u => u.includes("RECORD_ID()='" + TASK_ID + "'")),
        'checkVideoTasks never read the task: the fixture is not reaching the code under test').toBe(true);
    expect(await page.evaluate((id) => localStorage.getItem('sys_vtask_status_' + id), WF_ID),
        'the Completed task was not recognised').toBe('complete');

    expect(writes, 'page load wrote to Airtable or called the AI/Drive/Loom endpoints').toEqual([]);
});

for (const [label, workflowLoom, hasSop] of [
    ['a new Loom (none on the workflow)', null, true],
    ['a changed Loom (a different one on the workflow)', 'https://www.loom.com/share/old999old999', true],
    ['the same Loom with the SOP missing', TASK_LOOM, false],
]) {
    test(`${label} still auto-runs the pipeline on load`, async ({ page }) => {
        const { writes } = await loadSystemisation(page, { workflowLoom, hasSop });

        // The pipeline itself ran: it reached the Loom transcript worker and the AI.
        // Asserting only the stamp PATCH would pass even if the pipeline call were deleted.
        await expect.poll(
            () => writes.some(w => w.method === 'POST' && w.url.includes('claude-proxy')),
            { timeout: 20000, message: 'the pipeline never called the AI' },
        ).toBe(true);
        expect(writes.some(w => w.url.includes('loom-transcript')), 'the pipeline never fetched the transcript').toBe(true);

        // And the workflow carries the task's Loom stamp.
        const stamp = writes.find(w => w.method === 'PATCH' && w.url.endsWith('/' + WORKFLOWS_TBL + '/' + WF_ID));
        expect(stamp, 'the task\'s Loom was never stamped on the workflow').toBeTruthy();
        expect(JSON.parse(stamp.body).fields[WF_DESCRIPTION]).toContain('[loom:' + TASK_LOOM + ']');
    });
}

// Follow-up (29 Sep 2026): the AI description button (✨) replaced the whole description,
// deleting the [loom:] stamp that marks the SOP as built. The next fresh browser then saw
// "no stamp" and rebuilt the SOP on load, the bug above in a narrower form.
test('the AI description button keeps the Loom link on the workflow', async ({ page }) => {
    const { writes } = await loadSystemisation(page, { workflowLoom: TASK_LOOM });
    await expect(page.locator('#main')).toBeVisible({ timeout: 20000 });
    expect(writes, 'control: the load itself must write nothing').toEqual([]);

    // Answer the one AI call the button makes (registered last, so it wins).
    await page.route('**/claude-proxy.kevinbrittain.workers.dev/**', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ content: [{ type: 'text', text: 'Matches every bank line to a cost or a rent.' }] }),
    }));
    await page.evaluate((stage) => openDrawer(stage, 'fulfill'), STAGE);
    await page.locator(`tr[data-id="${WF_ID}"] .btn-ai-inline`).click();

    const isSave = w => w.method === 'PATCH' && w.url.endsWith('/' + WORKFLOWS_TBL + '/' + WF_ID);
    await expect.poll(() => writes.some(isSave), { timeout: 10000,
        message: 'the generated description was never saved' }).toBe(true);
    expect(JSON.parse(writes.find(isSave).body).fields[WF_DESCRIPTION])
        .toBe('Matches every bank line to a cost or a rent.\n[loom:' + TASK_LOOM + ']');
});
