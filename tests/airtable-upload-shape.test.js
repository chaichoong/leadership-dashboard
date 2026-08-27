// Every Airtable attachment upload in this repo must use the ONE shape the
// API actually accepts.
//
// Probed live against a throwaway record on 26 Aug 2026:
//   POST content.airtable.com/v0/{base}/{TABLE}/{rec}/{fld}/uploadAttachment
//        multipart  -> HTTP 404  (the shape js/shared.js had always used)
//   POST content.airtable.com/v0/{base}/{rec}/{fld}/uploadAttachment
//        multipart  -> HTTP 400
//   POST content.airtable.com/v0/{base}/{rec}/{fld}/uploadAttachment
//        base64 JSON -> HTTP 200
//
// So quick-task attachments had never uploaded once: the button existed, the
// spinner ran, and every file 404'd. Nothing surfaced it because the failure
// toast looked like any other transient error.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
// Comments explain these very bugs by name, so the shape checks below read
// CODE only — otherwise the explanation trips the guard it documents.
const codeOnly = (src) => src.replace(/^\s*\/\/.*$/gm, '');

// Every file that uploads an attachment.
const UPLOADERS = ['js/shared.js', 'os/agents/index.html', 'follow-up.html'];

describe('Airtable attachment uploads use the accepted shape', () => {
  it('at least three uploaders exist (control — a moved call site must not empty this suite)', () => {
    const found = UPLOADERS.filter((f) => read(f).includes('uploadAttachment'));
    expect(found).toEqual(UPLOADERS);
  });

  it.each(UPLOADERS)('%s posts to the record path, never with a table id (404)', (file) => {
    const src = codeOnly(read(file));
    for (const m of src.matchAll(/content\.airtable\.com\/v0\/([^`'"]+)uploadAttachment/g)) {
      // The path between base and field must be ONE id (the record).
      expect(m[1], `${file}: table id in the upload path returns 404`)
        .not.toMatch(/tbl|TBL|TABLES?\.|_TABLE/i);
    }
  });

  it.each(UPLOADERS)('%s sends base64 JSON, never multipart (400)', (file) => {
    const src = codeOnly(read(file));
    // Anchor on the ENDPOINT, not the word: in shared.js the first mention of
    // uploadAttachment is a call site 25 lines above the fetch.
    const at = src.indexOf('content.airtable.com');
    expect(at, `${file}: no upload endpoint found (control)`).toBeGreaterThan(-1);
    const near = src.slice(Math.max(0, at - 400), at + 1400);
    expect(near, `${file}: multipart is refused by this endpoint`).not.toMatch(/FormData/);
    expect(near).toMatch(/application\/json/);
    expect(near).toMatch(/contentType/);
    expect(near).toMatch(/filename/);
  });
});

describe('the approvals attachment flow', () => {
  const page = read('os/agents/index.html');

  it('uploads BEFORE the decision is written, so a refused file decides nothing', () => {
    const fn = page.slice(page.indexOf('async function applyApprovalDecision'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const upload = body.indexOf('uploadQueuedApprovalFiles');
    const patch = body.indexOf('atUpdate(TASKS_TBL, taskId, payload)');
    const staleGuard = body.indexOf('liveLmt !== String(t.lmt');
    expect(upload, 'upload call present').toBeGreaterThan(-1);
    expect(patch, 'decision write present (control)').toBeGreaterThan(-1);
    expect(staleGuard, 'stale guard present (control)').toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(staleGuard);  // never upload onto a task already decided
    expect(upload).toBeLessThan(patch);          // never decide on a failed upload
  });

  it('names the attached files in the record comment (the human trail)', () => {
    // NOT in Approval Feedback — see "the review findings stay fixed" below:
    // the dispatcher gates and pattern-matches that field.
    expect(page).toMatch(/attachComment = attachedNames\.length/);
    expect(page).toMatch(/Attached: \$\{attachedNames\.join\(', '\)\}/);
  });

  it('the decision clears the whole draft once it succeeds', () => {
    // Per-file clearing during the upload is asserted separately below.
    expect(page).toMatch(/delete _apvDrafts\[taskId\];/);
  });

  it('enforces Airtable’s 5MB limit before the upload, not as a 413 mid-decision', () => {
    expect(page).toMatch(/APV_MAX_FILE_BYTES = 5 \* 1024 \* 1024/);
    expect(page).toMatch(/f\.size > APV_MAX_FILE_BYTES/);
  });
});

describe('the review findings stay fixed', () => {
  const page = read('os/agents/index.html');
  const dispatch = read('scripts/agent-dispatch.py');

  it('Approval Feedback carries Kevin\'s words only — never a synthetic attachment line', () => {
    // agent-dispatch cmd_complete REFUSES a "Approved with minor edits" whose
    // feedback is non-empty until an edit is applied, and is_delay_feedback
    // pattern-matches the same field (\brevisit\b is in DELAY_PATTERNS). A
    // filename in there could deadlock a task or demote a hand-back.
    expect(page).toMatch(/if\(note\) payload\[TF\.approvalFeedback\] = note;/);
    expect(page).not.toMatch(/Attached to this task: \$\{attachedNames/);
    expect(dispatch).toMatch(/DELAY_PATTERNS/);            // control
    expect(dispatch).toMatch(/EDITS_APPLIED_MARK not in/); // control
  });

  it('agents are told about attachments through the queue instead', () => {
    const view = dispatch.slice(dispatch.indexOf('def task_view'), dispatch.indexOf('def sort_key'));
    expect(view).toMatch(/"attachments":/);
    expect(view).toMatch(/AF\["attachments"\]/);
    expect(dispatch).toMatch(/"attachments":\s*"fldEbs9cscRr8elcw"/);
  });

  it('each file leaves the queue as it lands, so a mid-batch failure cannot double-upload', () => {
    const fn = page.slice(page.indexOf('async function uploadQueuedApprovalFiles'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/await uploadOneApprovalAttachment/);
    expect(body).toMatch(/d\.files = \(d\.files \|\| \[\]\)\.filter\(f => f !== file\)/);
    expect(body).not.toMatch(/files = \[\]/);   // never a blanket wipe
  });

  it('uploaded names survive a failed decision, so a retry still names the files', () => {
    expect(page).toMatch(/d\.uploaded = \(d\.uploaded \|\| \[\]\)\.concat\(file\.name\)/);
  });

  it('empty and duplicate files are refused at the door', () => {
    expect(page).toMatch(/f\.size === 0/);
    expect(page).toMatch(/sameFile/);
  });

  it('an upload failure is reported as an upload failure, by phase not by message text', () => {
    expect(page).toMatch(/phase === 'upload'/);
    expect(page).not.toMatch(/refused the upload\|could not read/);
  });
});
