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
const UPLOADERS = ['js/shared.js', 'os/agents/index.html', 'follow-up.html', 'scripts/agent-dispatch.py'];

describe('Airtable attachment uploads use the accepted shape', () => {
  it('at least three uploaders exist (control — a moved call site must not empty this suite)', () => {
    const found = UPLOADERS.filter((f) => read(f).includes('uploadAttachment'));
    expect(found).toEqual(UPLOADERS);
  });

  it.each(UPLOADERS)('%s posts to the record path, never with a table id (404)', (file) => {
    const src = codeOnly(read(file));
    // Join adjacent string fragments (the Python url is a two-part f-string)
    // before matching, or this reads zero urls out of it and passes vacuously.
    const joined = src.replace(/["'`]\s*\n?\s*f?["'`]/g, '');
    const found = [...joined.matchAll(/content\.airtable\.com\/v0\/([\s\S]{0,200}?)uploadAttachment/g)];
    expect(found.length, `${file}: no upload url parsed (control — the guard would be vacuous)`)
      .toBeGreaterThan(0);
    for (const m of found) {
      // The accepted path is {base}/{record}/{field}/ — exactly three
      // segments. The 404 shape has four because it carries the table id.
      // Counting beats a name blocklist: it does not care whether the
      // constant is called TABLES.tasks, TASKS_TBL or TASKS.
      const segments = m[1].split('/').filter(Boolean);
      expect(segments.length, `${file}: upload path is {${segments.join('} / {')}} — the accepted shape is base/record/field, and a table id in there returns 404`)
        .toBe(3);
    }
  });

  it.each(UPLOADERS)('%s sends base64 JSON, never multipart (400)', (file) => {
    const src = codeOnly(read(file));
    // Anchor on the ENDPOINT, not the word: in shared.js the first mention of
    // uploadAttachment is a call site 25 lines above the fetch.
    const at = src.indexOf('content.airtable.com');
    expect(at, `${file}: no upload endpoint found (control)`).toBeGreaterThan(-1);
    const near = src.slice(Math.max(0, at - 700), at + 1400);
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

describe('agents can attach a deliverable to an approval', () => {
  const dispatch = read('scripts/agent-dispatch.py');
  const page = read('os/agents/index.html');
  const skill = read('.claude/scheduled-tasks/agent-dispatch/SKILL.md');

  it('submit --attach uploads BEFORE the task reaches Approval', () => {
    // A refused upload must leave the task unsubmitted, never hand Kevin an
    // approval card promising a letter that is not there.
    const fn = dispatch.slice(dispatch.indexOf('def cmd_submit'), dispatch.indexOf('def cmd_annotate'));
    const upload = fn.indexOf('upload_attachment(args.task, path)');
    const status = fn.indexOf('AF["status"]: "Approval"');
    expect(upload, 'attach loop present').toBeGreaterThan(-1);
    expect(status, 'status write present (control)').toBeGreaterThan(-1);
    expect(upload).toBeLessThan(status);
  });

  it('refuses an empty, missing or oversized file rather than half-attaching', () => {
    const fn = dispatch.slice(dispatch.indexOf('def upload_attachment'), dispatch.indexOf('def patch_task'));
    expect(fn).toMatch(/os\.path\.isfile/);
    expect(fn).toMatch(/size == 0/);
    expect(fn).toMatch(/ATTACH_MAX_BYTES/);
    expect(dispatch).toMatch(/ATTACH_MAX_BYTES = 5 \* 1024 \* 1024/);
  });

  it('there is also a standalone attach command for a file that arrives later', () => {
    expect(dispatch).toMatch(/def cmd_attach/);
    expect(dispatch).toMatch(/"attach": cmd_attach/);
  });

  it('the approvals card fetches and shows what the agent attached', () => {
    // The queue's field list moved into APV_QUEUE_FIELDS() on 28 Aug 2026 so
    // the knocked-back lane reads the same fields as the queue. Attachments
    // must still be in it — dropped from there, the card silently stops
    // showing the letter or form the agent produced, and Kevin approves blind.
    expect(page).toMatch(/APV_QUEUE_FIELDS = \(\) => \[[^\]]*TF\.attachments/s);   // fetched
    expect(page).toMatch(/files: \(gf\(r,TF\.attachments\)\|\|\[\]\)/); // mapped
    expect(page).toMatch(/open before you decide/);                 // shown
    // Only real http(s) urls become links — same scheme guard as the email links.
    expect(page).toMatch(/filter\(a=>\/\^https\?:/);
  });

  it('the attach zone accepts a dropped file', () => {
    expect(page).toMatch(/ondrop="event\.preventDefault\(\)/);
    expect(page).toMatch(/apvQueueFiles\('\$\{t\.id\}', event\.dataTransfer\.files\)/);
    expect(page).toMatch(/ondragover=/);
    expect(page).toMatch(/apv-drop-over/);
  });

  it('agents are TOLD they can attach — a capability nobody documents is never used', () => {
    expect(skill).toMatch(/--attach/);
    expect(skill).toMatch(/letter of authority/i);
    expect(skill).toMatch(/5MB/);
  });
});

describe('the Attachments field is shared, and the surfaces say so', () => {
  const dispatch = read('scripts/agent-dispatch.py');
  const page = read('os/agents/index.html');

  it('the card does not claim a file came from the agent', () => {
    // follow-up.html uploads the SENDER's own email attachments to the same
    // field id on the same task, and Kevin's feedback files land there too.
    // Verified: follow-up.html AIRTABLE_FIELDS.attachments === fldEbs9cscRr8elcw.
    expect(read('follow-up.html')).toMatch(/attachments:\s*'fldEbs9cscRr8elcw'/);
    expect(page).toMatch(/File on this task|files on this task/);
    expect(page).not.toMatch(/File from the agent|files from the agent/);
  });

  it('a redo replaces the agent\'s own file instead of stacking a second copy', () => {
    expect(dispatch).toMatch(/def supersede_attachments/);
    const fn = dispatch.slice(dispatch.indexOf('def supersede_attachments'));
    const body = fn.slice(0, fn.indexOf('\n\n\ndef '));
    // Keeps everything whose filename we are NOT replacing — the creditor's
    // own notice.pdf must survive the agent re-attaching its letter.
    expect(body).toMatch(/a\.get\("filename"\) not in filenames/);
    // And both entry points supersede before uploading.
    const submit = dispatch.slice(dispatch.indexOf('def cmd_submit'), dispatch.indexOf('def cmd_annotate'));
    expect(submit.indexOf('supersede_attachments')).toBeGreaterThan(-1);
    expect(submit.indexOf('supersede_attachments')).toBeLessThan(submit.indexOf('upload_attachment(args.task, path)'));
    expect(dispatch.slice(dispatch.indexOf('def cmd_attach'), dispatch.indexOf('def cmd_submit')))
      .toMatch(/supersede_attachments/);
  });

  it('a network failure mid-attach is caught, not a raw traceback', () => {
    const fn = dispatch.slice(dispatch.indexOf('def upload_attachment'), dispatch.indexOf('def supersede_attachments'));
    expect(fn).toMatch(/urllib\.error\.URLError/);
    expect(fn).toMatch(/TimeoutError/);
  });

  it('attachment links are re-read on click, because Airtable signs them short-lived', () => {
    expect(page).toMatch(/function apvOpenAttachment/);
    expect(page).toMatch(/window\.open\('', '_blank'/);   // synchronous, keeps the gesture
    expect(page).toMatch(/atFetchOne\(TASKS_TBL, taskId\)/);
  });

  it('a file dropped outside the strip cannot navigate the page and destroy every draft', () => {
    expect(page).toMatch(/\['dragover','drop'\]\.forEach/);
    expect(page).toMatch(/closest\('\.apv-attach'\)/);
  });
});
