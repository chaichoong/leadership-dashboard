/**
 * Gmail Meetings Intake → SUPABASE — Google Apps Script (always-on, server-side)
 *
 * Supabase-native twin of gmail-meetings-script.gs. Same Gmail-label handling,
 * same regex parsing, same name→email + assignee resolution, same collaborator
 * logic, same task-level de-duplication and the same Slack DM notifications — the
 * ONLY thing that changes is the WRITE TARGET: it writes the Meeting + its linked
 * Tasks straight into Supabase (Postgres via the PostgREST REST API) instead of
 * Airtable, so it keeps working after Airtable is retired.
 *
 * It watches the Gmail label "15: meeting summary", turns each Zoom/Loom/email
 * meeting summary into a `meetings` row + `tasks` rows in the Operations Director
 * Supabase database, and DMs each non-Kevin assignee via the existing
 * slack-notify Cloudflare Worker. Parsing is regex-only — NO AI key (the original
 * has no Claude/Anthropic call, so neither does this twin).
 *
 * SETUP:
 *   1. Go to script.google.com → New Project
 *   2. Paste this code
 *   3. Set Script Properties (Project Settings → Script properties):
 *        SUPABASE_URL         = https://ptkyhzlsvijcwyovgrgv.supabase.co   (optional, this is default)
 *        SUPABASE_SERVICE_KEY = <service_role key>   (a real secret — server-side
 *                               only, never logged, never shipped to a browser)
 *        SLACK_NOTIFY_URL     = https://slack-notify.kevinbrittain.workers.dev/  (optional default)
 *   4. Deploy → New Deployment → Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Triggers (clock icon) → Add Trigger → choose function `syncMeetings`
 *        - Event source: Time-driven → Minutes timer → Every 15 minutes
 *        (15 min is plenty for meeting summaries and keeps well under Gmail's
 *         daily read quota.)
 *
 * MANUAL RUN: run `syncMeetings()` (or its alias `run()`) from the editor.
 *
 * ACTIONS (via query string on the web-app URL):
 *   ?action=sync   → run the intake now and return a JSON summary
 *   ?action=repair → finish any Meeting rows stuck without their tasks: rebuild
 *                    the missing tasks from the stored transcript, link them, and
 *                    set Status "Done". Safe to re-run; never duplicates tasks.
 *   ?action=count  → how many threads currently carry the trigger label
 *   (no action)    → { status: 'ok' } health check
 */

// ═══════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    sbUrl:    (props.getProperty('SUPABASE_URL') || 'https://ptkyhzlsvijcwyovgrgv.supabase.co').replace(/\/+$/, ''),
    sbKey:    props.getProperty('SUPABASE_SERVICE_KEY'),   // service_role — never logged
    slackUrl: props.getProperty('SLACK_NOTIFY_URL') || 'https://slack-notify.kevinbrittain.workers.dev/',
  };
}

// Kevin's home org — stamped on EVERY meeting + task row.
var ORG_ID = '600ac348-7a49-4fbb-838f-76ec226344ed';

// Trigger label. The real Gmail label is "15: meeting summary" (a COLON), so we
// name it exactly — getUserLabelByName resolves it directly, no fuzzy matching.
// LABEL_NUMBER is kept only as a last-resort fallback (see findLabel), which now
// skips sub-labels so it can never grab the processed child by mistake.
var LABEL_NUMBER = 15;
var LABEL_NAME   = '15: meeting summary';

// Idempotency: the primary guard is a per-message check against the `meeting_uuid`
// column (= Gmail message id), backed by the partial unique index
// uq_meetings_org_uuid(org_id, meeting_uuid) — the direct equivalent of the
// Airtable Meeting-UUID lookup. After a thread's meeting is written it also gets
// this "processed" label as a secondary guard, so old summaries stop being
// re-read every run (keeping well under Gmail's daily quota).
//
// IMPORTANT: this label deliberately does NOT start with "15" and has no "/", so
// it can never collide with the numeric-prefix fallback in EITHER this script or
// the live Airtable meeting script (both match labels beginning "15."/"15:"/"15 ").
// A "15…" processed label would risk those scripts scanning the wrong label.
var PROCESSED_LABEL_NAME = 'Meetings synced to Supabase';

// Supabase table names (PostgREST resource names)
var SB = {
  meetings: 'meetings',
  tasks:    'tasks',
  team:     'team_members',
  projects: 'projects',
};

// Field-level defaults applied to EVERY task created from a meeting.
var TASK_DEFAULT_TIME     = '15 min';
var TASK_DEFAULT_PRIORITY = 'Not Urgent';
// New tasks are due on the creation date, so they belong to "Today". A NULL
// status would be EXCLUDED by PostgREST's `status != 'Completed'` filter (NULL
// comparisons are not TRUE), which would hide the task from the Tasks page —
// so we set an explicit status here (the Airtable version left this to base
// automation, which Supabase does not have).
var TASK_DEFAULT_STATUS   = 'Today';

var KEVIN_EMAIL = 'kevin@runpreneur.org.uk';

// name → collaborator email. Assignee is a plain email column in Supabase, so any
// email can be written — but we keep the same map + Kevin fallback so behaviour is
// identical to the Airtable version. slackEmail (where present) is the address the
// Slack worker needs to find that person's DM.
var PEOPLE = [
  { names: ['kevin', 'kevin brittain'],               email: 'kevin@runpreneur.org.uk' },
  { names: ['mica', 'mica albovias'],                 email: 'micaa.work@gmail.com' },
  { names: ['ericamae', 'erica', 'erica may', 'ericamae atenta'], email: 'atentaerica@gmail.com' },
  { names: ['gary', 'gary marsh'],                    email: 'gkm.property.maintenance@outlook.com', slackEmail: 'roofline@outlook.com' },
  { names: ['rob', 'rob jackson'],                    email: 'rjm320@hotmail.com' },
  { names: ['roy', 'roy lavin'],                      email: 'roy.lavin1978@gmail.com' },
];

// Phonetic / spelling corrections applied before resolving an owner.
function correctName(raw) {
  var n = String(raw || '').trim();
  var low = n.toLowerCase();
  if (low === 'erica may' || low === 'erica') return 'Ericamae';
  return n;
}

// Resolve a spoken name to a KNOWN collaborator email, or null if not in the map.
function knownEmailForName(rawName) {
  if (!rawName) return null;
  var low = correctName(rawName).toLowerCase();
  for (var i = 0; i < PEOPLE.length; i++) {
    for (var j = 0; j < PEOPLE[i].names.length; j++) {
      if (PEOPLE[i].names[j] === low) return PEOPLE[i].email;
    }
  }
  var first = low.split(/\s+/)[0];
  for (var k = 0; k < PEOPLE.length; k++) {
    if (PEOPLE[k].names.indexOf(first) !== -1) return PEOPLE[k].email;
  }
  return null;
}

// Resolve a spoken name to a writable assignee email (defaults to Kevin so a
// task is never dropped just because the owner isn't in the map).
function resolveAssigneeEmail(rawName) {
  return knownEmailForName(rawName) || KEVIN_EMAIL;
}

// Unique collaborator emails for the team members present at a meeting.
function presentCollaboratorEmails(attendeeNames) {
  var seen = {}, out = [];
  for (var i = 0; i < (attendeeNames || []).length; i++) {
    var em = knownEmailForName(attendeeNames[i]);
    if (em && !seen[em]) { seen[em] = true; out.push(em); }
  }
  return out;
}

// The address the Slack worker should DM for a given assignee email.
function slackEmailFor(assigneeEmail) {
  for (var i = 0; i < PEOPLE.length; i++) {
    if (PEOPLE[i].email === assigneeEmail) return PEOPLE[i].slackEmail || assigneeEmail;
  }
  return assigneeEmail;
}


// ═══════════════════════════════════════════
// Label lookup — robust against rename
// ═══════════════════════════════════════════

function findLabel() {
  var byName = GmailApp.getUserLabelByName(LABEL_NAME);
  if (byName) return byName;
  var prefix = String(LABEL_NUMBER);
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    var name = labels[i].getName();
    // Never match a sub-label (e.g. the processed child) — only the top-level
    // "15." / "15:" / "15 " trigger label.
    if (name.indexOf('/') !== -1) continue;
    if (name.indexOf(prefix + '.') === 0 ||
        name.indexOf(prefix + ':') === 0 ||
        name.indexOf(prefix + ' ') === 0) {
      return labels[i];
    }
  }
  return null;
}

// The "processed" marker label, created on first use.
function getOrCreateProcessedLabel() {
  var lb = GmailApp.getUserLabelByName(PROCESSED_LABEL_NAME);
  if (!lb) lb = GmailApp.createLabel(PROCESSED_LABEL_NAME);
  return lb;
}

function threadHasLabel(thread, label) {
  var want = label.getName();
  var ls = thread.getLabels();
  for (var i = 0; i < ls.length; i++) { if (ls[i].getName() === want) return true; }
  return false;
}


// ═══════════════════════════════════════════
// Web App Entry Point
// ═══════════════════════════════════════════

function doGet(e) {
  try {
    var params = e ? (e.parameter || {}) : {};

    if (params.action === 'count') {
      var label = findLabel();
      var count = label ? label.getThreads(0, 100).length : 0;
      return jsonResponse({ labelCount: count });
    }

    if (params.action === 'sync') {
      return jsonResponse(syncMeetings());
    }

    if (params.action === 'repair') {
      return jsonResponse(repairStuckMeetings());
    }

    return jsonResponse({ status: 'ok', message: 'Gmail Meetings Intake → Supabase v1' });
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}

// Manual on-demand run (alias, so the editor's Run menu shows a friendly name).
function run() { return syncMeetings(); }


// ═══════════════════════════════════════════
// Main intake — Gmail → Supabase meetings + tasks
// ═══════════════════════════════════════════

function syncMeetings() {
  var config = getConfig();
  if (!config.sbUrl || !config.sbKey) {
    var e1 = { error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set in Script Properties' };
    Logger.log('RESULT: ' + JSON.stringify(e1));
    return e1;
  }

  var label = findLabel();
  if (!label) {
    var e2 = { error: 'Gmail label "' + LABEL_NAME + '" not found', created: 0 };
    Logger.log('RESULT: ' + JSON.stringify(e2));
    return e2;
  }
  var processedLabel = getOrCreateProcessedLabel();

  var threads = label.getThreads(0, 25);

  // Lookups built once and shared across all meetings this run.
  var teamMap    = getTeamNameMap(config);     // lowercase name → team_members.id
  var projectMap = getProjectNameMap(config);  // lowercase name → projects.id
  // Task-level dedupe: text index of every active (not Completed) task, built
  // once so a duplicate commitment never gets added a second time.
  var taskDedupe = buildTaskDedupeIndex(config);

  var todayStr = fmtDate(new Date());
  var found = 0, created = 0, skipped = 0, tasksCreated = 0;

  for (var t = 0; t < threads.length; t++) {
    // One summary email == one thread. Use the latest message as the summary so
    // a reply in the thread can never spawn a second Meeting row.
    var messages = threads[t].getMessages();
    var msg = messages[messages.length - 1];
    found++;

    // Idempotency guard: a thread already carrying the "processed" label was
    // handled on a previous run. Strip the trigger label so it stops coming back
    // every run (otherwise old, done summaries get re-read and blow the Gmail
    // daily quota) and move on.
    if (threadHasLabel(threads[t], processedLabel)) {
      try { threads[t].removeLabel(label); } catch (ux) { /* permission — ignore */ }
      skipped++; continue;
    }

    var msgId = msg.getId();

    // Primary idempotency guard: has a meeting already been written for this Gmail
    // message id? This is the direct equivalent of the Airtable Meeting-UUID lookup
    // and is robust even if the processed-label was removed. The partial unique
    // index uq_meetings_org_uuid(org_id, meeting_uuid) is the DB-side backstop.
    if (meetingExistsForUuid(config, msgId)) {
      try { threads[t].addLabel(processedLabel); } catch (ux) { /* ignore */ }
      try { threads[t].removeLabel(label); }       catch (ux) { /* ignore */ }
      skipped++; continue;
    }

    var parsed = parseMeeting(msg);

    // ---- Tasks FIRST, so their ids can be linked into the meeting ----
    var taskIds = createTasksForMeeting(config, parsed, projectMap, todayStr, { dedupe: taskDedupe });
    tasksCreated += taskIds.length;

    // ---- Attendees → team_members ids (jsonb array), rest → External text ----
    var attIds = [], external = [];
    for (var a = 0; a < parsed.attendees.length; a++) {
      var nm = correctName(parsed.attendees[a]);
      var recId = matchTeamMember(nm, teamMap);
      if (recId) { if (attIds.indexOf(recId) === -1) attIds.push(recId); }
      else if (external.indexOf(nm) === -1) external.push(nm);
    }

    // ---- Meeting-level project link(s) if one is clearly named in the subject ----
    var projIds = [];
    if (parsed.projectName) {
      var pid = matchProject(parsed.projectName, projectMap);
      if (pid) projIds.push(pid);
    }

    // ---- Build + insert the Meeting row (complete, in one shot) ----
    var mrow = {
      org_id:        ORG_ID,
      name:          parsed.meetingName,
      date:          fmtDate(parsed.date),
      status:        'Done',                 // fully processed with tasks linked
      summary:       parsed.aiSummary,
      action_points: parsed.actionPointsText,
      source:        parsed.source,
      attendees:     attIds,                 // jsonb array of team_members ids
      tasks:         taskIds,                // jsonb array of tasks ids
      transcript:    parsed.transcript,      // raw summary/transcript text
      meeting_uuid:  msgId,                  // Gmail message id (dedupe key)
      projects:      projIds,                // jsonb array of project ids ([] if none)
    };
    if (parsed.zoomMid)        mrow.zoom_mid      = parsed.zoomMid;
    if (external.length)       mrow.ext_attendees = external.join(', ');
    if (parsed.recordingLink)  mrow.recording     = parsed.recordingLink;

    var mcreated = sbInsert(config, SB.meetings, mrow);
    if (mcreated === DUPLICATE) {
      // 409 from the unique index — another run already wrote this meeting. Treat
      // as already-processed (don't error the run), mark the thread and move on.
      try { threads[t].addLabel(processedLabel); } catch (ux) { /* ignore */ }
      try { threads[t].removeLabel(label); }       catch (ux) { /* ignore */ }
      skipped++; continue;
    }
    if (!mcreated || !mcreated.length) {
      // Meeting insert failed — leave the trigger label so it retries next run.
      // Any tasks already created are protected from duplication by the dedupe
      // index (they are now active tasks the next run will recognise).
      continue;
    }
    created++;

    // Mark processed, then drop the trigger label.
    try { threads[t].addLabel(processedLabel); } catch (ux) { /* ignore */ }
    try { threads[t].removeLabel(label); }       catch (ux) { /* ignore */ }

    Utilities.sleep(400);
  }

  var result = {
    success: true,
    threadsScanned: threads.length,
    messagesFound: found,
    meetingsCreated: created,
    skippedExisting: skipped,
    tasksCreated: tasksCreated,
    tasksSkippedDuplicate: taskDedupe.skipped,
  };
  Logger.log('RESULT: ' + JSON.stringify(result));
  return result;
}

// Create every task for a parsed meeting (one row each, all columns set), DM each
// non-Kevin assignee, and return the new task ids so the caller can link them into
// the meeting. Shared by the live sync and the repair action.
function createTasksForMeeting(config, parsed, projectMap, todayStr, opts) {
  var notify = !(opts && opts.notify === false);   // repair back-fills silently
  var dedupe = opts && opts.dedupe;                 // shared active-task text index
  var taskIds = [];
  var isWeekly = parsed.isWeeklyCheckin;
  // Collaborators = the team members who were present at this meeting. Stored as
  // the same [{email}] shape the Airtable multipleCollaborators field used, which
  // is what the Tasks page reads out of the jsonb column.
  var collabEmails = presentCollaboratorEmails(parsed.attendees);
  var collabValue  = collabEmails.map(function (e) { return { email: e }; });

  for (var p = 0; p < parsed.tasks.length; p++) {
    var item = parsed.tasks[p];
    var ownerRaw = item.owner;
    if (!ownerRaw && isWeekly) ownerRaw = 'Mica';     // weekly check-in default
    var email = resolveAssigneeEmail(ownerRaw);

    // Duplicate guard — comprehensive text test against every active task and
    // against tasks already created earlier in this run.
    if (dedupe && dedupe.has(item.text)) { dedupe.skipped++; continue; }

    var row = {
      org_id:        ORG_ID,
      name:          item.text,
      assignee:      email,                  // plain email text column
      due_date:      todayStr,               // always the creation date
      status:        TASK_DEFAULT_STATUS,    // 'Today'
      time_estimate: TASK_DEFAULT_TIME,      // default 15 min
      priority:      TASK_DEFAULT_PRIORITY,  // default Not Urgent
    };
    if (parsed.aiSummary)   row.description   = parsed.aiSummary;  // from summary section
    if (collabValue.length) row.collaborators = collabValue;       // team present
    if (item.cadence)       row.recurring     = item.cadence;

    // Weekly check-in special case: Project priority + Profit project link.
    if (isWeekly) {
      row.priority = 'Project';
      var profitId = matchProject('Profit', projectMap);
      if (profitId) row.project_id = profitId;
    }

    var createdRows = sbInsert(config, SB.tasks, row);
    if (!createdRows || !createdRows.length) continue;
    var taskId = createdRows[0].id;

    taskIds.push(taskId);
    if (dedupe) dedupe.add(item.text);   // later items dedupe against this one too

    // Slack DM the assignee (except Kevin) via the always-on worker.
    if (notify && email !== KEVIN_EMAIL) {
      notifySlack(config, slackEmailFor(email), item.text, taskId, todayStr,
                  TASK_DEFAULT_TIME);
    }
    if (taskIds.length % 4 === 0) Utilities.sleep(1000);
  }
  return taskIds;
}


// ═══════════════════════════════════════════
// Repair — close out meetings not yet "Done"
// ═══════════════════════════════════════════

// A meeting is "stuck" when its row exists but task creation never finished, so
// the action points never became tasks. Because `transcript` is now stored on the
// meeting row (same as Airtable), this rebuilds the missing tasks from that
// transcript, links them, and sets Status "Done" — identical to the Airtable
// repair. A meeting that already has linked tasks is just flipped to "Done" (never
// re-created), and one with no usable transcript is left visible for a human.
//
// Run it any of three ways:
//   • open  <web-app-url>/exec?action=repair   ← bookmark this, one click
//   • run   repairStuckMeetings()              from the Apps Script editor
//   • (optionally) add a daily time trigger on repairStuckMeetings as a safety net
function repairStuckMeetings() {
  var config = getConfig();
  if (!config.sbUrl || !config.sbKey) {
    var e1 = { error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set in Script Properties' };
    Logger.log('REPAIR: ' + JSON.stringify(e1));
    return e1;
  }

  var projectMap = getProjectNameMap(config);
  var todayStr   = fmtDate(new Date());
  var stuck      = getStuckMeetings(config);
  // Same task-level dedupe the live sync uses, so repair never back-fills a task
  // that already exists as an active task.
  var taskDedupe = buildTaskDedupeIndex(config);

  var repaired = 0, tasksCreated = 0, closedExisting = 0, skippedNoContent = 0;

  for (var i = 0; i < stuck.length; i++) {
    var rec = stuck[i];
    var existingLinks = rec.tasks || [];

    // Already has tasks (a partial run) — just close it out; never re-create.
    if (existingLinks.length > 0) {
      sbUpdate(config, SB.meetings, rec.id, mkStatus('Done'));
      closedExisting++;
      continue;
    }

    // No tasks and no usable transcript to rebuild from — leave it visible so it's
    // obvious it needs a human, rather than silently flipping an empty record.
    if (String(rec.transcript || '').trim().length < 20) {
      skippedNoContent++;
      continue;
    }

    var parsed  = parseMeetingFromRecord(rec);
    var taskIds = createTasksForMeeting(config, parsed, projectMap, todayStr, { notify: false, dedupe: taskDedupe });

    var close = mkStatus('Done');
    if (taskIds.length) close.tasks = taskIds;
    // Backfill metadata the original parse may have got wrong: a fuller summary and
    // a descriptive name (only when the current one is a generic placeholder).
    if (parsed.aiSummary) close.summary = parsed.aiSummary;
    if (parsed.meetingName && isReplaceableName(parsed.currentName)) close.name = parsed.meetingName;
    sbUpdate(config, SB.meetings, rec.id, close);

    repaired++;
    tasksCreated += taskIds.length;
    Utilities.sleep(400);
  }

  var result = {
    success: true,
    stuckFound: stuck.length,
    meetingsRepaired: repaired,
    tasksCreated: tasksCreated,
    tasksSkippedDuplicate: taskDedupe.skipped,
    closedAlreadyHadTasks: closedExisting,
    skippedNoContent: skippedNoContent,
  };
  Logger.log('REPAIR: ' + JSON.stringify(result));
  return result;
}

// All Meeting rows that haven't reached "Done", plus any wrongly closed to "Done"
// with no tasks whose transcript clearly listed action items (the Supabase twin of
// the Airtable getStuckMeetings recovery net).
function getStuckMeetings(config) {
  var rows = sbSelect(config, SB.meetings,
    'select=id,status,tasks,transcript,name&order=created_at.asc&limit=100000');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var st = r.status;
    var nLinks = (r.tasks || []).length;
    if (st === 'Summarised' || st === 'Tasks Created') { out.push(r); continue; }
    if (st === 'Done' && nLinks === 0 &&
        /next steps|action items|action points|follow[\s-]?ups/i.test(String(r.transcript || ''))) {
      out.push(r);
    }
  }
  return out;
}

// Rebuild the parsed-meeting shape createTasksForMeeting needs, using the stored
// transcript on the meeting row (the same section/owner parsing the live sync uses
// applies cleanly).
function parseMeetingFromRecord(rec) {
  var body      = rec.transcript || '';
  var name      = rec.name || '';
  var nextSteps = extractSection(body, ['next steps', 'action items', 'action points', 'tasks', 'follow-ups', 'follow ups']);
  var summarySec = extractSection(body, ['quick recap', 'summary', 'overview', 'recap']);
  var aiSummary = cleanSummaryText(summarySec || firstChars(body, 1500));
  var isWeeklyCheckin = /weekly check[\s-]?in|weekly check\b|weekly catch[\s-]?up/.test((name + ' ' + body).toLowerCase());
  var attendees = extractAttendees(body, nextSteps);
  var tasks     = extractGroupedActionItems(nextSteps, isWeeklyCheckin);
  return {
    tasks: tasks, isWeeklyCheckin: isWeeklyCheckin, attendees: attendees,
    aiSummary: aiSummary,
    currentName: name,
    meetingName: deriveMeetingName('', body),   // body-only; no original subject on the row
  };
}

// A name that carries no real information — empty, generic, or a canned fallback.
function isReplaceableName(s) {
  s = String(s || '').trim();
  if (!s) return true;
  if (isGenericMeetingName(s)) return true;
  return /^(project meeting|meeting summary|weekly check-?in)$/i.test(s);
}

function mkStatus(s) { return { status: s }; }


// ═══════════════════════════════════════════
// Parse one Gmail message into meeting data
// (identical regex parsing to the Airtable version)
// ═══════════════════════════════════════════

function parseMeeting(msg) {
  var subject = msg.getSubject() || '';
  var from    = msg.getFrom() || '';
  var date    = msg.getDate();

  // Choose the richer of the plain-text and HTML bodies.
  var plainBody = msg.getPlainBody() || '';
  var htmlBody  = htmlToText(msg.getBody() || '');
  var body = plainBody;
  if (sectionScore(htmlBody) > sectionScore(plainBody) || plainBody.trim().length < 40) {
    body = htmlBody;
  }
  var lowSubj = subject.toLowerCase();
  var lowBody = body.toLowerCase();
  var isLoom  = /loom/.test(lowSubj) || /loom\.com/.test(lowBody) || /from:.*loom/.test(from.toLowerCase());

  // Recording link + Zoom meeting id (zoomMid → the meetings.zoom_mid column).
  var recordingLink = extractLink(body, isLoom);
  var zoomMid = (body.match(/[?&]mid=([A-Za-z0-9%+\/=]+)/) || [])[1] || '';
  if (zoomMid) { try { zoomMid = decodeURIComponent(zoomMid); } catch (z) {} }

  // Sections
  var summary  = extractSection(body, ['quick recap', 'summary', 'overview', 'recap']);
  var nextSteps = extractSection(body, ['next steps', 'action items', 'action points', 'tasks', 'follow-ups', 'follow ups']);
  var aiSummary = cleanSummaryText(summary || firstChars(body, 1500));
  var actionLines = splitBullets(nextSteps);

  // Meeting name — short plain-language label
  var meetingName = deriveMeetingName(subject, body);
  var isWeeklyCheckin = /weekly check[\s-]?in|weekly check\b|weekly catch[\s-]?up/.test(lowSubj + ' ' + lowBody);

  // Attendees
  var attendees = extractAttendees(body, nextSteps);

  // Project, if explicitly named in the subject ("X Project Meeting")
  var projectName = (subject.match(/([A-Z][\w&]+(?:\s+[A-Z][\w&]+)*)\s+project\b/i) || [])[1] || '';

  // Tasks from the action lines.
  var tasks = extractGroupedActionItems(nextSteps, isWeeklyCheckin);

  return {
    meetingName: meetingName,
    date: date,
    recordingLink: recordingLink,
    zoomMid: zoomMid,
    transcript: firstChars(body, 95000),
    aiSummary: aiSummary,
    actionPointsText: actionLines.length ? '• ' + actionLines.join('\n• ') : (nextSteps || ''),
    source: isLoom ? 'Loom Email' : 'Inbound Email',
    attendees: attendees,
    projectName: projectName,
    isWeeklyCheckin: isWeeklyCheckin,
    tasks: tasks,
  };
}

// "<Person> will <do X> [by <date>] [every <cadence>]" → task object.
function parseActionLine(line) {
  var clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 6) return null;

  var m = clean.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:will|to|is going to|should|needs to|agreed to|'ll)\b/);
  if (!m) m = clean.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*[:\-]\s+/);
  if (!m) return null;

  var owner = m[1];
  var ownerFirst = owner.split(' ')[0];
  if (/^(The|This|That|We|They|It|Next|Action|Summary|Quick|Recap)$/i.test(ownerFirst)) return null;
  if (ACTION_VERBS.indexOf(ownerFirst.toLowerCase().replace(/[^a-z]/g, '')) !== -1) return null;

  var cadence = detectCadence(clean);
  return { owner: owner, text: capitalise(clean), cadence: cadence };
}

function detectCadence(text) {
  var t = text.toLowerCase();
  if (/\b(daily|every day|each day)\b/.test(t)) return 'Daily';
  if (/\b(fortnightly|every two weeks|every other week)\b/.test(t)) return 'Fortnightly';
  if (/\b(weekly|every week|each week)\b/.test(t)) return 'Weekly';
  if (/\b(monthly|every month|each month)\b/.test(t)) return 'Monthly';
  if (/\b(quarterly|every quarter)\b/.test(t)) return 'Quarterly';
  if (/\b(bi-?annually|twice a year)\b/.test(t)) return 'Bi-Annually';
  if (/\b(annually|every year|yearly)\b/.test(t)) return 'Annually';
  return '';
}

var ACTION_VERBS = ['update','send','review','prepare','create','draft','call',
  'check','schedule','finalise','finalize','book','order','follow','complete',
  'add','set','build','write','confirm','track','post','email','plan','organise',
  'organize','arrange','submit','research','contact','assign','record','publish',
  'test','fix','design','chase','collate','compile','reconcile','upload','share',
  'respond','reply','liaise','notify','talk','speak','refer','return','present',
  'report','attend','agree','commit','use','make','appeal','work','approve',
  'escalate','migrate','transition','draft','remind','reach','respond'];

function parseImperativeLine(line) {
  var clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 6) return null;
  var first = clean.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (ACTION_VERBS.indexOf(first) === -1) return null;
  return { owner: null, text: capitalise(clean), cadence: detectCadence(clean) };
}


// ═══════════════════════════════════════════
// Text extraction helpers (verbatim from the Airtable version)
// ═══════════════════════════════════════════

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|td|th|li|h[1-6]|ul|ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&[#\w]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sectionScore(s) {
  var t = String(s || '').toLowerCase();
  var marks = ['next steps', 'action items', 'action points', 'quick recap',
               'overview', 'summary', 'follow-ups', 'follow ups'];
  var n = 0;
  for (var i = 0; i < marks.length; i++) { if (t.indexOf(marks[i]) !== -1) n++; }
  return n;
}

function extractSection(body, headings) {
  var lines = String(body || '').split('\n');
  for (var h = 0; h < headings.length; h++) {
    var head = headings[h];
    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i].trim();
      var l = rawLine.toLowerCase().replace(/[:\-\s]+$/, '');
      var startsWith = l.indexOf(head) === 0;
      var exact = (l === head || l === head + ':' || (startsWith && l.length <= head.length + 2));
      var inlineRemainder = '';
      if (!exact && startsWith) {
        var rem = rawLine.slice(head.length).replace(/^[:\-–—\s]+/, '').trim();
        if (rem && isPersonHeading(rem)) inlineRemainder = rem;
      }
      if (!exact && !inlineRemainder) continue;
      var out = [];
      if (inlineRemainder) out.push(inlineRemainder);
      for (var j = i + 1; j < lines.length; j++) {
        var raw = lines[j].trim();
        if (!raw) continue;
        if (isHeading(raw)) break;
        if (isHeadingStart(raw)) break;
        if (isSectionBoundary(raw)) break;
        out.push(raw);
      }
      if (out.length) return out.join('\n');
    }
  }
  return '';
}

function isHeading(line) {
  var l = line.replace(/[:\s]+$/, '').toLowerCase();
  var heads = ['quick recap', 'summary', 'overview', 'recap', 'next steps',
               'action items', 'action points', 'tasks', 'follow-ups', 'follow ups',
               'attendees', 'participants', 'details'];
  return heads.indexOf(l) !== -1;
}

function isHeadingStart(line) {
  var t = String(line || '').trim();
  if (/^[•\*\-–—·]/.test(t)) return false;
  var low = t.toLowerCase();
  var heads = ['summary', 'next steps', 'action items', 'action points',
               'quick recap', 'overview', 'follow-ups', 'follow ups',
               'attendees', 'participants'];
  for (var i = 0; i < heads.length; i++) {
    if (low.indexOf(heads[i]) === 0) return true;
  }
  return false;
}

function isUrlLine(line) {
  return /^<?https?:\/\//.test(String(line || '').trim());
}

function endsMidPhrase(text) {
  var t = String(text || '').replace(/\s+$/, '');
  if (/[.!?:]$/.test(t)) return false;
  var last = (t.split(/\s+/).pop() || '').toLowerCase().replace(/[^a-z]/g, '');
  return /^(to|with|for|and|of|the|a|an|from|on|in|by|at|or|nor|but|into|onto|via|per|as|that|their|its|his|her|your|our|amp)$/.test(last);
}

function isSectionBoundary(line) {
  if (/^(thank you|thanks[,!]|the zoom team|view in zoom|view meeting recap|watch:|join:|unsubscribe|sent from|ai can make mistakes|please rate|shareable link|recording duration|duration:|©)/i.test(line)) return true;
  if (/^https?:\/\/\S+$/.test(line)) return true;
  if (/^\d{1,4}\s+\w+.*\b(blvd|street|st|ave|avenue|road|rd|suite)\b/i.test(line)) return true;
  return false;
}

function sectionLines(section) {
  return String(section || '').split('\n')
    .map(function (s) { return s.replace(/^[\s•\*\-–—·]+/, '').trim(); })
    .filter(function (s) { return s.length > 0; });
}

function isPersonHeading(line) {
  var l = String(line || '').replace(/[:\-–—\s]+$/, '').trim();
  if (!l || l.length > 30) return false;
  if (/[.!?]$/.test(String(line).trim())) return false;
  var words = l.split(/\s+/);
  if (words.length > 3) return false;
  var firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (ACTION_VERBS.indexOf(firstWord) !== -1) return false;
  if (/^(collaboration|collaborate|team|group|everyone|all|shared|joint|others?|general)$/i.test(l)) return 'GROUP';
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (/^(and|&|\/|the|of|with)$/i.test(w)) continue;
    if (!/^[A-Z][A-Za-z'’.\-]*$/.test(w)) return false;
  }
  return 'PERSON';
}

function extractGroupedActionItems(section, isWeekly) {
  var raw = String(section || '').split('\n');
  var hasBullets = raw.some(function (l) { return /^\s*[•\*\-–—·]\s+/.test(l); });

  var units = [];
  for (var i = 0; i < raw.length; i++) {
    var trimmed = raw[i].trim();
    if (!trimmed) continue;
    if (isUrlLine(trimmed)) continue;
    var bm = trimmed.match(/^[•\*\-–—·]\s+(.+)$/);
    if (bm) { units.push({ kind: 'bullet', text: bm[1].trim() }); continue; }
    if (isPersonHeading(trimmed)) {
      var prevU = units.length ? units[units.length - 1] : null;
      if (hasBullets && prevU && prevU.kind === 'bullet' && endsMidPhrase(prevU.text)) {
        prevU.text += ' ' + trimmed; continue;
      }
      units.push({ kind: 'line', text: trimmed }); continue;
    }
    if (!hasBullets) { units.push({ kind: 'line', text: trimmed }); continue; }
    if (parseActionLine(trimmed)) { units.push({ kind: 'line', text: trimmed }); continue; }
    if (units.length && units[units.length - 1].kind === 'bullet') {
      units[units.length - 1].text += ' ' + trimmed;
    } else {
      units.push({ kind: 'line', text: trimmed });
    }
  }

  var items = [], currentOwner = null;
  for (var u = 0; u < units.length; u++) {
    var text = units[u].text.replace(/\s+/g, ' ').trim();
    var inline = parseActionLine(text);
    if (inline) { items.push(inline); currentOwner = inline.owner; continue; }

    if (units[u].kind === 'line') {
      var ht = isPersonHeading(text);
      if (ht === 'PERSON') { currentOwner = text.replace(/[:\-–—\s]+$/, '').trim(); continue; }
      if (ht === 'GROUP')  { currentOwner = null; continue; }
    }
    if (text.length < 6) continue;

    if (currentOwner) {
      items.push({ owner: currentOwner, text: capitalise(text), cadence: detectCadence(text) });
      continue;
    }
    var lead = text.match(/^([A-Z][a-zA-Z]+)\s+(?:and|&)\s+[A-Z][a-zA-Z]+\s*[:\-]\s*(.+)$/);
    if (lead) {
      items.push({ owner: lead[1], text: capitalise(lead[2]), cadence: detectCadence(text) });
    } else if (isWeekly) {
      var imp = parseImperativeLine(text);
      if (imp) items.push(imp);
    }
  }
  return items;
}

function splitBullets(section) {
  if (!section) return [];
  return section.split('\n')
    .map(function (s) { return s.replace(/^[\s•\*\-–•·]+/, '').trim(); })
    .filter(function (s) { return s.length > 3; });
}

function extractAttendees(body, nextSteps) {
  var names = {};
  var pm = body.match(/(?:attendees|participants|present)\s*[:\-]\s*([^\n]+)/i);
  if (pm) {
    pm[1].split(/[,;]|\band\b/i).forEach(function (n) {
      var nm = n.replace(/<[^>]+>/g, '').replace(/\([^)]*\)/g, '').trim();
      if (/^[A-Z][a-zA-Z]+/.test(nm) && nm.length < 40) names[nm] = true;
    });
  }
  splitBullets(nextSteps).forEach(function (l) {
    var m = l.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*[:\-]/);
    if (m) names[m[1]] = true;
    var m2 = l.match(/^([A-Z][a-zA-Z]+)\s+will\b/);
    if (m2) names[m2[1]] = true;
  });
  sectionLines(nextSteps).forEach(function (l) {
    var clean = l.replace(/[:\-–—\s]+$/, '').trim();
    if (isPersonHeading(l) === 'PERSON' && clean.split(/\s+/).length <= 2) names[clean] = true;
  });
  return Object.keys(names);
}

function deriveMeetingName(subject, body) {
  var s = String(subject || '')
    .replace(/^(re|fwd|fw):\s*/i, '')
    .replace(/^.*?\b(?:is ready|is now available|assets are ready|recording is ready|summary)\b\s*[:\-–—]\s*/i, '')
    .replace(/^(?:your\s+)?(?:loom|zoom|fathom|otter|cloud recording)\b[\s:–—-]*/i, '')
    .replace(/\s*[-–—|:]?\s*(?:are\s+ready|is now available|is ready|recording|meeting summary|summary)[\s!.]*$/i, '')
    .replace(/\s+[|–—]\s+.*$/, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length >= 4 && s.length <= 60 && !isGenericMeetingName(s)) return s;
  var topic = topicHeadingFromBody(body);
  if (topic) return topic;
  var low = (subject + ' ' + body).toLowerCase();
  if (/weekly check|catch[\s-]?up/.test(low)) return 'Weekly Check-in';
  if (/project/.test(low)) return 'Project Meeting';
  return 'Meeting Summary';
}

function isGenericMeetingName(s) {
  return /\b(personal meeting room|meeting room|cloud recording|recording|meeting assets|assets)\b/i.test(s) ||
         /^meeting(\s+summary)?$/i.test(s.trim());
}

function cleanSummaryText(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  var heads = '(?:next steps|action items|action points|follow[\\s-]?ups)';
  var m = s.match(new RegExp('[.!?]\\s+' + heads + '\\b', 'i'));
  if (!m) m = s.match(new RegExp('\\b' + heads + '\\s+[A-Z][a-z]+', ''));
  if (m && m.index > 40) s = s.slice(0, m.index + (m[0].match(/^[.!?]/) ? 1 : 0)).trim();
  return s.replace(/[\s;,]+$/, '').trim();
}

function topicHeadingFromBody(body) {
  var lines = String(body || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].trim().match(/^summary\s+(.+)$/i);
    if (m) {
      var t = m[1].replace(/[:\s]+$/, '').trim();
      if (isCleanTitle(t)) return capitalise(t);
    }
  }
  var sec = extractSection(body, ['summary', 'overview', 'quick recap', 'recap']);
  if (!sec) return '';
  var first = (sectionLines(sec)[0] || '').replace(/[:\s]+$/, '').trim();
  if (isCleanTitle(first)) return capitalise(first);
  return '';
}

function isCleanTitle(s) {
  s = String(s || '').trim();
  return s.length >= 6 && s.length <= 60 && s.split(/\s+/).length <= 9 && !/[.!?]$/.test(s);
}

function extractLink(body, isLoom) {
  if (isLoom) {
    var lm = body.match(/https?:\/\/(?:www\.)?loom\.com\/share\/[A-Za-z0-9]+/);
    if (lm) return lm[0];
  }
  var zm = body.match(/https?:\/\/[A-Za-z0-9.\-]*zoom\.us\/rec\/[^\s"<>]+/);
  if (zm) return zm[0];
  var any = body.match(/https?:\/\/[^\s"<>]*(?:loom\.com|zoom\.us|fathom\.video|otter\.ai)[^\s"<>]*/);
  return any ? any[0] : '';
}

function firstChars(s, n) {
  s = String(s || '');
  return s.length > n ? s.substring(0, n) : s;
}

function capitalise(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}


// ═══════════════════════════════════════════
// Task-level de-duplication (verbatim logic; source is Supabase)
// ═══════════════════════════════════════════

// Pull the names of every active (not Completed) task from Supabase. NULL-status
// rows count as active too (they are not "Completed").
function getActiveTaskNames(config) {
  var rows = sbSelect(config, SB.tasks, 'select=name&or=(status.is.null,status.neq.Completed)&limit=100000');
  var out = [];
  for (var i = 0; i < rows.length; i++) { if (rows[i].name) out.push(rows[i].name); }
  return out;
}

var KNOWN_OWNER_NAMES = (function () {
  var s = {};
  for (var i = 0; i < PEOPLE.length; i++) {
    for (var j = 0; j < PEOPLE[i].names.length; j++) {
      var full = PEOPLE[i].names[j];
      s[full] = 1;
      s[full.split(/\s+/)[0]] = 1;
    }
  }
  return s;
})();

function leadingOwnerSpan(t) {
  var m = t.match(/^([A-Za-z'’.\-]+(?:\s+[A-Za-z'’.\-]+)?)\s+(?:will|'ll|is going to|going to|agreed to|needs? to|should|to)\s+/i);
  if (m && isKnownOwner(m[1])) return m[0].length;
  var m2 = t.match(/^([A-Za-z'’.\-]+(?:\s+[A-Za-z'’.\-]+)?)\s*[:\-–—]\s+/);
  if (m2 && isKnownOwner(m2[1])) return m2[0].length;
  return 0;
}
function isKnownOwner(phrase) {
  var low = String(phrase || '').toLowerCase().trim();
  return !!(KNOWN_OWNER_NAMES[low] || KNOWN_OWNER_NAMES[low.split(/\s+/)[0]]);
}

function normalizeTaskText(s) {
  var t = String(s || '').trim();
  var span = leadingOwnerSpan(t);
  if (span) t = t.slice(span);
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

var TASK_STOPWORDS = { 'a':1,'an':1,'the':1,'to':1,'of':1,'for':1,'and':1,'or':1,
  'in':1,'on':1,'at':1,'by':1,'with':1,'this':1,'that':1,'is':1,'are':1,'be':1,
  'will':1,'please':1,'need':1,'needs':1,'should':1,'must':1,'it':1,'we':1,
  'our':1,'up':1,'out':1,'all':1,'any':1,'his':1,'her':1,'their':1,'from':1 };

function taskTokens(s) {
  var norm = normalizeTaskText(s);
  var words = norm ? norm.split(' ') : [];
  var set = {};
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.length < 2 || TASK_STOPWORDS[w]) continue;
    w = w.replace(/(ing|ed|es|s)$/, '');
    if (w.length >= 4 && w.charAt(w.length - 1) === 'e') w = w.slice(0, -1);
    if (w.length < 2) continue;
    set[w] = 1;
  }
  return set;
}

function objSize(o) { var n = 0; for (var k in o) if (o.hasOwnProperty(k)) n++; return n; }

function taskNums(s) {
  var out = {}, m = String(s || '').match(/\d+/g) || [];
  for (var i = 0; i < m.length; i++) out[String(parseInt(m[i], 10))] = 1;
  return out;
}

function numsDiffer(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  if (!ka.length || !kb.length) return false;
  var aExtra = false, bExtra = false;
  for (var i = 0; i < ka.length; i++) { if (!b[ka[i]]) { aExtra = true; break; } }
  for (var j = 0; j < kb.length; j++) { if (!a[kb[j]]) { bExtra = true; break; } }
  return aExtra && bExtra;
}

function tokensMatch(a, aSize, b, bSize) {
  if (!aSize || !bSize) return false;
  var inter = 0, keys = Object.keys(a);
  for (var i = 0; i < keys.length; i++) { if (b[keys[i]]) inter++; }
  var jaccard = inter / (aSize + bSize - inter);
  if (jaccard >= 0.8) return true;
  var smaller = aSize < bSize ? aSize : bSize;
  if (smaller >= 4 && inter === smaller) return true;
  return false;
}

function makeTaskDedupeIndex() {
  var norms = {}, tokenSets = [];
  return {
    skipped: 0,
    has: function (text) {
      var n = normalizeTaskText(text);
      if (!n) return false;
      if (norms[n]) return true;
      var ts = taskTokens(text), size = objSize(ts);
      if (!size) return false;
      var nums = taskNums(text);
      for (var i = 0; i < tokenSets.length; i++) {
        if (tokensMatch(ts, size, tokenSets[i].set, tokenSets[i].size) &&
            !numsDiffer(nums, tokenSets[i].nums)) return true;
      }
      return false;
    },
    add: function (text) {
      var n = normalizeTaskText(text);
      if (!n) return;
      norms[n] = true;
      var ts = taskTokens(text);
      tokenSets.push({ set: ts, size: objSize(ts), nums: taskNums(text) });
    }
  };
}

function buildTaskDedupeIndex(config) {
  var idx = makeTaskDedupeIndex();
  var names = getActiveTaskNames(config);
  for (var i = 0; i < names.length; i++) idx.add(names[i]);
  return idx;
}


// ═══════════════════════════════════════════
// Supabase lookups (team + project name → id maps)
// ═══════════════════════════════════════════

// lowercase name → team_members.id. Keyed by the generated `name` column, the
// legacy `member` value and the `member_email`, so any of them resolves. The
// Supabase ids equal the migrated Airtable record ids.
function getTeamNameMap(config) {
  var map = {};
  var rows = sbSelect(config, SB.team, 'select=id,name,member,member_email');
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    [r.name, r.member].forEach(function (nm) {
      if (nm) map[String(nm).toLowerCase().trim()] = r.id;
    });
    if (r.member_email) map[String(r.member_email).toLowerCase().trim()] = r.id;
  }
  return map;
}

function getProjectNameMap(config) {
  var map = {};
  var rows = sbSelect(config, SB.projects, 'select=id,name');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].name) map[String(rows[i].name).toLowerCase().trim()] = rows[i].id;
  }
  return map;
}

function matchTeamMember(name, teamMap) {
  var low = String(name || '').toLowerCase().trim();
  if (teamMap[low]) return teamMap[low];
  var keys = Object.keys(teamMap);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(low) === 0 || low.indexOf(keys[i]) === 0) return teamMap[keys[i]];
  }
  return null;
}

function matchProject(name, projectMap) {
  var low = String(name || '').toLowerCase().trim();
  if (projectMap[low]) return projectMap[low];
  var keys = Object.keys(projectMap);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(low) !== -1 || low.indexOf(keys[i]) !== -1) return projectMap[keys[i]];
  }
  return null;
}


// ═══════════════════════════════════════════
// Supabase REST helpers (PostgREST)
// ═══════════════════════════════════════════

function sbHeaders(config, extra) {
  var h = {
    'apikey':        config.sbKey,
    'Authorization': 'Bearer ' + config.sbKey,
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// GET rows. `query` is a raw PostgREST query string (without leading "?").
function sbSelect(config, table, query) {
  var url = config.sbUrl + '/rest/v1/' + table + (query ? ('?' + query) : '');
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: sbHeaders(config),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    Logger.log('sbSelect ' + table + ' [' + resp.getResponseCode() + ']: ' + resp.getContentText());
    return [];
  }
  try { return JSON.parse(resp.getContentText()) || []; }
  catch (e) { Logger.log('sbSelect parse ' + table + ': ' + e); return []; }
}

// Sentinel returned by sbInsert on a unique-constraint conflict (409 / 23505),
// so callers can treat a race-lost insert as "already processed" rather than an
// error. Distinct from null (a real failure) and from a row array (success).
var DUPLICATE = { __duplicate: true };

// INSERT a row (or rows). Returns the created row array (with generated ids), the
// DUPLICATE sentinel on a unique-constraint conflict, or null on any other
// failure. Uses Prefer: return=representation so ids come back.
function sbInsert(config, table, rows) {
  var payload = Array.isArray(rows) ? rows : [rows];
  var resp = UrlFetchApp.fetch(config.sbUrl + '/rest/v1/' + table, {
    method: 'post',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code === 409 || /\b23505\b|duplicate key value/i.test(text)) {
    return DUPLICATE;   // unique index (e.g. uq_meetings_org_uuid) — already exists
  }
  if (code !== 200 && code !== 201) {
    Logger.log('sbInsert ' + table + ' [' + code + ']: ' + text);
    return null;
  }
  try {
    var data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  } catch (e) { Logger.log('sbInsert parse ' + table + ': ' + e); return null; }
}

// Has a meeting already been written for this Gmail message id (in Kevin's org)?
// Direct equivalent of the Airtable Meeting-UUID lookup.
function meetingExistsForUuid(config, msgId) {
  if (!msgId) return false;
  var q = 'select=id&org_id=eq.' + encodeURIComponent(ORG_ID) +
          '&meeting_uuid=eq.' + encodeURIComponent(msgId) + '&limit=1';
  var rows = sbSelect(config, SB.meetings, q);
  return rows.length > 0;
}

// PATCH one row by id.
function sbUpdate(config, table, id, cols) {
  var url = config.sbUrl + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id);
  var resp = UrlFetchApp.fetch(url, {
    method: 'patch',
    headers: sbHeaders(config, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
    payload: JSON.stringify(cols),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code !== 200 && code !== 204) {
    Logger.log('sbUpdate ' + table + ' [' + code + ']: ' + resp.getContentText());
    return false;
  }
  return true;
}


// ═══════════════════════════════════════════
// Slack notification — via the always-on worker (unchanged)
// ═══════════════════════════════════════════

function notifySlack(config, recipientEmail, taskName, taskId, dueDate, estimate) {
  try {
    UrlFetchApp.fetch(config.slackUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        recipientEmail: recipientEmail,
        taskName: taskName,
        taskId: taskId,
        dueDate: dueDate,
        estimate: estimate,
        actorName: 'Meetings Intake',
        action: 'assigned'
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('slack notify failed: ' + e);   // never fail the run over Slack
  }
}


// ═══════════════════════════════════════════
// Misc
// ═══════════════════════════════════════════

function fmtDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function pad(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
