/**
 * Gmail Meetings Intake — Google Apps Script (always-on, server-side)
 *
 * Mirrors gmail-invoice-script.gs. Runs on Google's servers on a time trigger,
 * so it works even when the Claude desktop app is closed and the whole team can
 * rely on it from any device. It watches the Gmail label "15. meeting summary",
 * turns each Zoom/Loom/email meeting summary into a Meetings record + Tasks in
 * the Operations Director Airtable base, and DMs each non-Kevin assignee via the
 * existing slack-notify Cloudflare Worker. Parsing is regex-only — no AI key.
 *
 * SETUP:
 *   1. Go to script.google.com → New Project
 *   2. Paste this code
 *   3. Set Script Properties (Project Settings → Script properties):
 *        AIRTABLE_PAT  = your Airtable Personal Access Token (a real secret —
 *                        only ever lives here, never in chat or in git)
 *        AIRTABLE_BASE = appnqjDpqDniH3IRl            (optional, this is default)
 *        SLACK_NOTIFY_URL = https://slack-notify.kevinbrittain.workers.dev/  (optional default)
 *   4. Deploy → New Deployment → Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Triggers (clock icon) → Add Trigger → choose function `syncMeetings`
 *        - Event source: Time-driven → Minutes timer → Every 5 minutes
 *
 * ACTIONS (via query string on the web-app URL):
 *   ?action=sync   → run the intake now and return a JSON summary
 *   ?action=repair → finish any Meeting records stuck at "Summarised":
 *                    create + link their missing tasks and set them to "Done".
 *                    Safe to re-run; never duplicates tasks. Bookmark this URL
 *                    as your one-click "fix stuck meetings" button.
 *   ?action=count  → how many threads currently carry the label
 *   (no action)    → { status: 'ok' } health check
 */

// ═══════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    pat:       props.getProperty('AIRTABLE_PAT'),
    base:      props.getProperty('AIRTABLE_BASE') || 'appnqjDpqDniH3IRl',
    slackUrl:  props.getProperty('SLACK_NOTIFY_URL') || 'https://slack-notify.kevinbrittain.workers.dev/',
  };
}

// Trigger label
var LABEL_NUMBER = 15;
var LABEL_NAME   = '15. meeting summary';

// Airtable table IDs
var T = {
  meetings: 'tblNodbh9B3WLzCIK',
  tasks:    'tblqB8b22hKBL4PF1',
  team:     'tblco0p2OnlLQVAX7',
  projects: 'tblHrpTMd5LNYn8v1',
};

// Meetings field IDs
var MF = {
  name:        'fldWSPqwJMMAA1mxm',  // Meeting Name
  date:        'fldTMJFKGqr9VCTns',  // Meeting Date
  status:      'fldUKM6X8PFxbF1HU',  // Status (singleSelect)
  attendees:   'fldZLnxcXALQj2C97',  // Attendees (link → Team Members)
  externalAtt: 'fldxLuW7F8e4acS4x',  // External Attendees (text)
  aiSummary:   'fld7hO6M1Pcsxp1BC',  // AI Summary
  actionPts:   'fldwkgiZ6JdPBgEeU',  // Action Points
  tasks:       'fld3NpfT3Sbmy3obd',  // Tasks (link → Tasks)
  recording:   'fldrHJGXyIVyPlqCA',  // Recording Link
  projects:    'fldZLoHMIDW63Qefr',  // Projects (link → Projects)
  transcript:  'fld64w959SI4T8FHh',  // Transcript
  uuid:        'fldsSily22hDP31us',  // Meeting UUID (dedupe key = Gmail message id)
  providerId:  'fldz4Zu9t2Qx5hKGM',  // Transcript Provider ID (Zoom mid)
  source:      'fldAmaevMBxmpezx2',  // Source (singleSelect)
};

// Tasks field IDs
var TF = {
  name:          'fldgFjGBw6bTKJFCD',  // Task Name (primary)
  dueDate:       'fld7XP8w8kbxfETV4',  // Due Date
  assignee:      'fldELMncVJYPDRJNc',  // Assignee (singleCollaborator → write {email})
  priority:      'fldS21RwmwOqt71LI',  // Priority (singleSelect: Project/Urgent/Not Urgent/High)
  timeEst:       'fld10VzzbiNNgRmIi',  // Time Estimate (singleSelect: 15 min ...)
  description:   'fldRGhBQViKZKtkQ6',  // Description (richText) ← meeting AI summary
  collaborators: 'fldcq3t6uAPgWSOP8',  // Collaborators (multipleCollaborators → [{email}])
  recurring:     'fldNhDWBX5gQm2p6b',  // Cadence (singleSelect: Daily/Weekly/.../None)
  projects:      'fldBg0rQy0FrOAkRN',  // Projects (link → Projects)
};

// Field-level defaults applied to EVERY task created from a meeting.
var TASK_DEFAULT_TIME     = '15 min';
var TASK_DEFAULT_PRIORITY = 'Not Urgent';

var TEAM_PRIMARY    = 'flds7xoRFQhcRTnbB'; // Team Members "Name"
var PROJECT_PRIMARY = 'fldiMZICg1KOORpte'; // Projects "Project Name"

var KEVIN_EMAIL = 'kevin@runpreneur.org.uk';

// name → Airtable collaborator email. Assignee is a singleCollaborator, so an
// email that is NOT a base collaborator cannot be written — unknown owners fall
// back to Kevin so a task is never silently dropped. slackEmail (where present)
// is the address the Slack worker needs to find that person's DM.
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

// Resolve a spoken name to a KNOWN collaborator email, or null if not a base
// collaborator. Used for the collaborators list (must never invent a user).
function knownEmailForName(rawName) {
  if (!rawName) return null;
  var low = correctName(rawName).toLowerCase();
  for (var i = 0; i < PEOPLE.length; i++) {
    for (var j = 0; j < PEOPLE[i].names.length; j++) {
      if (PEOPLE[i].names[j] === low) return PEOPLE[i].email;
    }
  }
  // First-name match (e.g. "Rob Jackson said..." vs map "rob")
  var first = low.split(/\s+/)[0];
  for (var k = 0; k < PEOPLE.length; k++) {
    if (PEOPLE[k].names.indexOf(first) !== -1) return PEOPLE[k].email;
  }
  return null;
}

// Resolve a spoken name to a writable assignee email (defaults to Kevin so a
// task is never dropped just because the owner isn't a base collaborator).
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
    if (name.indexOf(prefix + '.') === 0 ||
        name.indexOf(prefix + ':') === 0 ||
        name.indexOf(prefix + ' ') === 0) {
      return labels[i];
    }
  }
  return null;
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

    return jsonResponse({ status: 'ok', message: 'Gmail Meetings Intake v1' });
  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}


// ═══════════════════════════════════════════
// Main intake — Gmail → Airtable Meetings + Tasks
// ═══════════════════════════════════════════

function syncMeetings() {
  var config = getConfig();
  if (!config.pat) {
    var e1 = { error: 'AIRTABLE_PAT not set in Script Properties' };
    Logger.log('RESULT: ' + JSON.stringify(e1));
    return e1;
  }

  var label = findLabel();
  if (!label) {
    var e2 = { error: 'Gmail label "' + LABEL_NAME + '" not found', created: 0 };
    Logger.log('RESULT: ' + JSON.stringify(e2));
    return e2;
  }

  var threads = label.getThreads(0, 25);

  // Dedupe set: every Meeting UUID already in Airtable (= processed Gmail msg ids)
  var existingUuids = getExistingMeetingUuids(config);
  var teamMap     = getLinkNameMap(config, T.team, TEAM_PRIMARY);
  var projectMap  = getLinkNameMap(config, T.projects, PROJECT_PRIMARY);

  var todayStr = fmtDate(new Date());
  var found = 0, created = 0, skipped = 0, tasksCreated = 0;

  for (var t = 0; t < threads.length; t++) {
    // One summary email == one thread. Use the latest message as the summary so
    // a reply in the thread can never spawn a second Meeting record.
    var messages = threads[t].getMessages();
    var msg = messages[messages.length - 1];
    found++;
    var msgId = msg.getId();

    if (existingUuids[msgId]) { skipped++; continue; }   // already processed

    {
      var parsed = parseMeeting(msg);

      // ---- Build the Meeting record ----
      var fields = {};
      fields[MF.name]       = parsed.meetingName;
      fields[MF.date]       = fmtDate(parsed.date);
      fields[MF.transcript] = parsed.transcript;
      fields[MF.aiSummary]  = parsed.aiSummary;
      fields[MF.actionPts]  = parsed.actionPointsText;
      fields[MF.source]     = parsed.source;
      fields[MF.uuid]       = msgId;
      fields[MF.status]     = 'Summarised';
      if (parsed.recordingLink) fields[MF.recording]  = parsed.recordingLink;
      if (parsed.zoomMid)       fields[MF.providerId] = parsed.zoomMid;

      // Attendees → link known team members, stash the rest as External
      var attLinks = [], external = [];
      for (var a = 0; a < parsed.attendees.length; a++) {
        var nm = correctName(parsed.attendees[a]);
        var recId = matchTeamMember(nm, teamMap);
        if (recId) { if (attLinks.indexOf(recId) === -1) attLinks.push(recId); }
        else if (external.indexOf(nm) === -1) external.push(nm);
      }
      if (attLinks.length) fields[MF.attendees]   = attLinks;
      if (external.length) fields[MF.externalAtt] = external.join(', ');

      // Project link if one is clearly named
      if (parsed.projectName) {
        var pid = matchProject(parsed.projectName, projectMap);
        if (pid) fields[MF.projects] = [pid];
      }

      var meetingId = createRecord(config, T.meetings, fields);
      if (!meetingId) { continue; }   // create failed — leave label, retry next run
      created++;
      existingUuids[msgId] = meetingId;

      // ---- Tasks from action points ----
      var taskIds = createTasksForMeeting(config, parsed, projectMap, todayStr);
      tasksCreated += taskIds.length;

      // Link the new tasks back into the meeting, then close it out.
      var close = {};
      if (taskIds.length) close[MF.tasks] = taskIds;
      close[MF.status] = 'Done';
      updateRecord(config, T.meetings, meetingId, close);

      // Best-effort unlabel (dedupe on UUID is the real safeguard).
      try { threads[t].removeLabel(label); } catch (ux) { /* permission — ignore */ }

      Utilities.sleep(400);
    }
  }

  var result = {
    success: true,
    threadsScanned: threads.length,
    messagesFound: found,
    meetingsCreated: created,
    skippedExisting: skipped,
    tasksCreated: tasksCreated,
  };
  Logger.log('RESULT: ' + JSON.stringify(result));
  return result;
}

// Create every task for a parsed meeting (two-phase: name+assignee, then all
// fields), DM each non-Kevin assignee, and return the new task ids so the caller
// can link them into the meeting. Shared by the live sync and the repair action
// so both paths build tasks identically.
function createTasksForMeeting(config, parsed, projectMap, todayStr) {
  var taskIds = [];
  var isWeekly = parsed.isWeeklyCheckin;
  // Collaborators = the team members who were present at this meeting.
  var collabEmails = presentCollaboratorEmails(parsed.attendees);
  var collabValue  = collabEmails.map(function (e) { return { email: e }; });

  for (var p = 0; p < parsed.tasks.length; p++) {
    var item = parsed.tasks[p];
    var ownerRaw = item.owner;
    if (!ownerRaw && isWeekly) ownerRaw = 'Mica';     // weekly check-in default
    var email = resolveAssigneeEmail(ownerRaw);

    // Phase 1: create with name + assignee only (lets base automation run)
    var tFields = {};
    tFields[TF.name]     = item.text;
    tFields[TF.assignee] = { email: email };
    var taskId = createRecord(config, T.tasks, tFields);
    if (!taskId) continue;

    // Phase 2: fill every relevant field.
    var upd = {};
    upd[TF.dueDate]     = todayStr;                 // always the creation date
    upd[TF.timeEst]     = TASK_DEFAULT_TIME;        // default 15 min
    upd[TF.priority]    = TASK_DEFAULT_PRIORITY;    // default Not Urgent
    if (parsed.aiSummary) upd[TF.description] = parsed.aiSummary;   // from AI summary
    if (collabValue.length) upd[TF.collaborators] = collabValue;    // team present
    if (item.cadence) upd[TF.recurring] = item.cadence;

    // Weekly check-in special case: Project priority + Profit project link.
    if (isWeekly) {
      upd[TF.priority] = 'Project';
      var profitId = matchProject('Profit', projectMap);
      if (profitId) upd[TF.projects] = [profitId];
    }
    updateRecord(config, T.tasks, taskId, upd);

    taskIds.push(taskId);

    // Slack DM the assignee (except Kevin) via the always-on worker.
    if (email !== KEVIN_EMAIL) {
      notifySlack(config, slackEmailFor(email), item.text, taskId, todayStr,
                  TASK_DEFAULT_TIME);
    }
    if (taskIds.length % 4 === 0) Utilities.sleep(1000);
  }
  return taskIds;
}


// ═══════════════════════════════════════════
// Repair — finish records stuck at "Summarised"
// ═══════════════════════════════════════════

// A meeting record is "stuck" when the email was parsed and the record created
// (Status "Summarised") but task creation never finished — so the action points
// never became tasks. The live sync can't fix it (it dedupes on Meeting UUID and
// skips the already-created record), so this is the manual recovery path.
//
// Run it any of three ways:
//   • open  <web-app-url>/exec?action=repair   ← bookmark this, one click
//   • run   repairStuckMeetings()              from the Apps Script editor
//   • (optionally) add a daily time trigger on repairStuckMeetings as a safety net
//
// Safe to re-run: a record that already has linked tasks is just flipped to
// "Done" (never re-created), so you can never get duplicate tasks.
function repairStuckMeetings() {
  var config = getConfig();
  if (!config.pat) {
    var e1 = { error: 'AIRTABLE_PAT not set in Script Properties' };
    Logger.log('REPAIR: ' + JSON.stringify(e1));
    return e1;
  }

  var projectMap = getLinkNameMap(config, T.projects, PROJECT_PRIMARY);
  var todayStr   = fmtDate(new Date());
  var stuck      = getStuckMeetings(config);

  var repaired = 0, tasksCreated = 0, closedExisting = 0, skippedNoContent = 0;

  for (var i = 0; i < stuck.length; i++) {
    var rec = stuck[i];
    var existingLinks = rec.fields[MF.tasks] || [];

    // Already has tasks (a partial run) — just close it out; never re-create.
    if (existingLinks.length > 0) {
      updateRecord(config, T.meetings, rec.id, mkStatus('Done'));
      closedExisting++;
      continue;
    }

    // No tasks and no usable transcript to rebuild from — leave it visible
    // (still "Summarised") so it's obvious it needs a human, rather than
    // silently flipping an empty record to "Done".
    if (String(rec.fields[MF.transcript] || '').trim().length < 20) {
      skippedNoContent++;
      continue;
    }

    var parsed  = parseMeetingFromRecord(rec);
    var taskIds = createTasksForMeeting(config, parsed, projectMap, todayStr);

    var close = mkStatus('Done');
    if (taskIds.length) close[MF.tasks] = taskIds;
    updateRecord(config, T.meetings, rec.id, close);

    repaired++;
    tasksCreated += taskIds.length;
    Utilities.sleep(400);
  }

  var result = {
    success: true,
    stuckFound: stuck.length,
    meetingsRepaired: repaired,
    tasksCreated: tasksCreated,
    closedAlreadyHadTasks: closedExisting,
    skippedNoContent: skippedNoContent,
  };
  Logger.log('REPAIR: ' + JSON.stringify(result));
  return result;
}

// All Meeting records that haven't reached "Done" — i.e. stuck at the
// intermediate "Summarised" (or legacy "Tasks Created") state.
function getStuckMeetings(config) {
  var out = [], offset = null;
  var fieldParams = [MF.status, MF.tasks, MF.transcript, MF.aiSummary, MF.name]
    .map(function (f) { return 'fields%5B%5D=' + f; }).join('&');
  do {
    var url = 'https://api.airtable.com/v0/' + config.base + '/' + T.meetings +
      '?' + fieldParams + '&returnFieldsByFieldId=true&pageSize=100';
    if (offset) url += '&offset=' + offset;
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + config.pat },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) { Logger.log('stuck list: ' + resp.getContentText()); break; }
    var data = JSON.parse(resp.getContentText());
    (data.records || []).forEach(function (r) {
      var st = r.fields[MF.status];
      if (st === 'Summarised' || st === 'Tasks Created') out.push(r);
    });
    offset = data.offset || null;
  } while (offset);
  return out;
}

// Rebuild the parsed-meeting shape that createTasksForMeeting needs, using the
// fields already stored on the Meeting record (the Transcript holds the email
// body, so the same section/owner parsing the live sync uses applies cleanly).
function parseMeetingFromRecord(rec) {
  var f = rec.fields || {};
  var body      = f[MF.transcript] || '';
  var name      = f[MF.name] || '';
  var aiSummary = f[MF.aiSummary] || '';
  var nextSteps = extractSection(body, ['next steps', 'action items', 'action points', 'tasks', 'follow-ups', 'follow ups']);
  var isWeeklyCheckin = /weekly check[\s-]?in|weekly check\b|weekly catch[\s-]?up/.test((name + ' ' + body).toLowerCase());
  var attendees = extractAttendees(body, nextSteps);
  var tasks     = extractGroupedActionItems(nextSteps, isWeeklyCheckin);
  return { tasks: tasks, isWeeklyCheckin: isWeeklyCheckin, attendees: attendees, aiSummary: aiSummary };
}

function mkStatus(s) { var o = {}; o[MF.status] = s; return o; }


// ═══════════════════════════════════════════
// Parse one Gmail message into meeting data
// ═══════════════════════════════════════════

function parseMeeting(msg) {
  var subject = msg.getSubject() || '';
  var from    = msg.getFrom() || '';
  var date    = msg.getDate();

  // Choose the richer of the plain-text and HTML bodies. Zoom summaries put the
  // structured "Next steps / Quick recap / Summary" content in the HTML part,
  // while the plain-text part is often sparse — so pick whichever exposes more
  // recognised section headings (falling back to HTML if plain text is empty).
  var plainBody = msg.getPlainBody() || '';
  var htmlBody  = htmlToText(msg.getBody() || '');
  var body = plainBody;
  if (sectionScore(htmlBody) > sectionScore(plainBody) || plainBody.trim().length < 40) {
    body = htmlBody;
  }
  var lowSubj = subject.toLowerCase();
  var lowBody = body.toLowerCase();
  var isLoom  = /loom/.test(lowSubj) || /loom\.com/.test(lowBody) || /from:.*loom/.test(from.toLowerCase());

  // Recording link + Zoom meeting id
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

  // Attendees — from a "Next steps grouped by person" structure or a participants line
  var attendees = extractAttendees(body, nextSteps);

  // Project, if explicitly named in the subject ("X Project Meeting")
  var projectName = (subject.match(/([A-Z][\w&]+(?:\s+[A-Z][\w&]+)*)\s+project\b/i) || [])[1] || '';

  // Tasks from the action lines. Handles three real-world shapes:
  //  1. Inline owner   — "Mica will draft the SOP by Friday."
  //  2. Grouped by person — a bare name heading ("Erica") followed by imperative
  //     bullets ("Create a workflow…") that all belong to that person. This is
  //     the standard Zoom "Next steps" format.
  //  3. Weekly check-in owner-less imperative ("Update the tracker daily") → Mica.
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
// Only returns a task when there is a clear owner + commitment.
function parseActionLine(line) {
  var clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 6) return null;

  // Owner is the leading name before a commitment verb.
  var m = clean.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:will|to|is going to|should|needs to|agreed to|'ll)\b/);
  // "Next steps grouped by person" lines often start "Name: do X"
  if (!m) m = clean.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*[:\-]\s+/);
  if (!m) return null;

  var owner = m[1];
  var ownerFirst = owner.split(' ')[0];
  // Skip filler that isn't really a person (very rough guard).
  if (/^(The|This|That|We|They|It|Next|Action|Summary|Quick|Recap)$/i.test(ownerFirst)) return null;
  // Reject imperative lines mis-read as "Name to …" — e.g. "Respond to Hayden",
  // "Talk to the council", "Reply to the email". The leading word is a verb,
  // not a person, so leave it for the grouped-owner / weekly handlers.
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

// Fallback for weekly check-ins: action lines often have no named owner
// ("Update the profit tracker daily"). Treat an imperative verb-first line
// as a task with no owner (caller defaults the assignee to Mica for weekly).
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
// Text extraction helpers
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

// How many recognised section headings a body exposes — used to pick the richer
// of the plain-text vs HTML body.
function sectionScore(s) {
  var t = String(s || '').toLowerCase();
  var marks = ['next steps', 'action items', 'action points', 'quick recap',
               'overview', 'summary', 'follow-ups', 'follow ups'];
  var n = 0;
  for (var i = 0; i < marks.length; i++) { if (t.indexOf(marks[i]) !== -1) n++; }
  return n;
}

// Pull the body of a labelled section up to the next section heading. Internal
// blank lines are skipped (Zoom groups "Next steps" into per-person sub-blocks
// separated by blank lines), and a footer/sign-off/URL line ends the section.
function extractSection(body, headings) {
  var lines = String(body || '').split('\n');
  for (var h = 0; h < headings.length; h++) {
    var head = headings[h];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim().toLowerCase().replace(/[:\-\s]+$/, '');
      if (l === head || l === head + ':' || l.indexOf(head) === 0 && l.length <= head.length + 2) {
        var out = [];
        for (var j = i + 1; j < lines.length; j++) {
          var raw = lines[j].trim();
          if (!raw) continue;                  // skip blanks — don't end the section
          if (isHeading(raw)) break;           // next known section ends this one
          if (isSectionBoundary(raw)) break;   // footer / sign-off / bare URL ends it
          out.push(raw);
        }
        if (out.length) return out.join('\n');
      }
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

// A line that marks the end of the meaningful summary content (email footer,
// sign-off, share link, address, rating prompt).
function isSectionBoundary(line) {
  if (/^(thank you|thanks[,!]|the zoom team|view in zoom|view meeting recap|watch:|join:|unsubscribe|sent from|ai can make mistakes|please rate|shareable link|recording duration|duration:|©)/i.test(line)) return true;
  if (/^https?:\/\/\S+$/.test(line)) return true;                         // bare URL line
  if (/^\d{1,4}\s+\w+.*\b(blvd|street|st|ave|avenue|road|rd|suite)\b/i.test(line)) return true;
  return false;
}

// Split a section into ordered, bullet-stripped, non-empty lines (keeps short
// name-heading lines, unlike splitBullets which drops anything ≤3 chars).
function sectionLines(section) {
  return String(section || '').split('\n')
    .map(function (s) { return s.replace(/^[\s•\*\-–—·]+/, '').trim(); })
    .filter(function (s) { return s.length > 0; });
}

// Is this line a person-name heading (Zoom groups tasks under "Erica", "Mica"…)
// or a shared-group heading ("Collaboration")? Returns 'PERSON', 'GROUP', or false.
function isPersonHeading(line) {
  var l = String(line || '').replace(/[:\-–—\s]+$/, '').trim();
  if (!l || l.length > 30) return false;
  if (/[.!?]$/.test(String(line).trim())) return false;     // a full sentence, not a heading
  var words = l.split(/\s+/);
  if (words.length > 3) return false;
  var firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (ACTION_VERBS.indexOf(firstWord) !== -1) return false;  // imperative, not a name
  if (/^(collaboration|collaborate|team|group|everyone|all|shared|joint|others?|general)$/i.test(l)) return 'GROUP';
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (/^(and|&|\/|the|of|with)$/i.test(w)) continue;       // connectors are fine
    if (!/^[A-Z][A-Za-z'’.\-]*$/.test(w)) return false;       // every name word is capitalised
  }
  return 'PERSON';
}

// Turn a "Next steps" section into task objects, inheriting the current person
// heading for owner-less imperative bullets. Inline "Name will/Name:" forms and
// "Name and Name:" shared lines are also recognised.
function extractGroupedActionItems(section, isWeekly) {
  var lines = sectionLines(section);
  var items = [], currentOwner = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Inline owner form always wins ("Mica will…", "Mica: …").
    var inline = parseActionLine(line);
    if (inline) { items.push(inline); currentOwner = inline.owner; continue; }

    // Bare name / group heading switches the owner context.
    var ht = isPersonHeading(line);
    if (ht === 'PERSON') { currentOwner = line.replace(/[:\-–—\s]+$/, '').trim(); continue; }
    if (ht === 'GROUP')  { currentOwner = null; continue; }

    if (line.length < 6) continue;

    // Imperative bullet — assign to the person heading it sits under.
    if (currentOwner) {
      items.push({ owner: currentOwner, text: capitalise(line), cadence: detectCadence(line) });
      continue;
    }
    // No current owner: catch a "Name and Name: do X" shared line, else (weekly only) keep it.
    var lead = line.match(/^([A-Z][a-zA-Z]+)\s+(?:and|&)\s+[A-Z][a-zA-Z]+\s*[:\-]\s*(.+)$/);
    if (lead) {
      items.push({ owner: lead[1], text: capitalise(lead[2]), cadence: detectCadence(line) });
    } else if (isWeekly) {
      var imp = parseImperativeLine(line);
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
  // Explicit participants line
  var pm = body.match(/(?:attendees|participants|present)\s*[:\-]\s*([^\n]+)/i);
  if (pm) {
    pm[1].split(/[,;]|\band\b/i).forEach(function (n) {
      var nm = n.replace(/<[^>]+>/g, '').replace(/\([^)]*\)/g, '').trim();
      if (/^[A-Z][a-zA-Z]+/.test(nm) && nm.length < 40) names[nm] = true;
    });
  }
  // "Next steps grouped by person" — leading names act as attendees too
  splitBullets(nextSteps).forEach(function (l) {
    var m = l.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*[:\-]/);
    if (m) names[m[1]] = true;
    var m2 = l.match(/^([A-Z][a-zA-Z]+)\s+will\b/);
    if (m2) names[m2[1]] = true;
  });
  // Standalone person-name sub-headings (Zoom groups tasks under "Erica", "Mica").
  sectionLines(nextSteps).forEach(function (l) {
    var clean = l.replace(/[:\-–—\s]+$/, '').trim();
    if (isPersonHeading(l) === 'PERSON' && clean.split(/\s+/).length <= 2) names[clean] = true;
  });
  return Object.keys(names);
}

function deriveMeetingName(subject, body) {
  var s = String(subject || '')
    .replace(/^(re|fwd|fw):\s*/i, '')
    // Strip provider/notification prefixes (anything up to a colon) e.g.
    // "Your Loom is ready: Sales sync" → "Sales sync",
    // "Zoom: Meeting assets are ready: Weekly Check-in" → "Weekly Check-in".
    .replace(/^.*?\b(?:is ready|is now available|assets are ready|recording is ready|summary)\b\s*[:\-–—]\s*/i, '')
    // Strip leading provider words if they survived.
    .replace(/^(?:your\s+)?(?:loom|zoom|fathom|otter|cloud recording)\b[\s:–—-]*/i, '')
    // Strip trailing notification phrases.
    .replace(/\s*[-–—|:]?\s*(?:are\s+ready|is now available|is ready|recording|meeting summary|summary)[\s!.]*$/i, '')
    // Only cut on a SPACED separator (a real divider like " | " or " – "),
    // never a bare hyphen — that keeps "Check-in", "Follow-up", "Catch-up".
    .replace(/\s+[|–—]\s+.*$/, '')
    .replace(/\s+/g, ' ').trim();
  // Use the cleaned subject only when it's a meaningful length AND isn't a generic
  // provider/room phrase ("…Personal Meeting Room", "Cloud Recording").
  if (s.length >= 4 && s.length <= 60 && !isGenericMeetingName(s)) return s;
  // Otherwise derive a descriptive name from the body — Zoom puts a short topic
  // heading at the top of its "Summary" section (e.g. "Meeting Automation Module
  // Implementation"), which captures the gist far better than a canned fallback.
  var topic = topicHeadingFromBody(body);
  if (topic) return topic;
  var low = (subject + ' ' + body).toLowerCase();
  if (/weekly check|catch[\s-]?up/.test(low)) return 'Weekly Check-in';
  if (/project/.test(low)) return 'Project Meeting';
  return 'Meeting Summary';
}

// A subject so generic it tells you nothing about the meeting — e.g. a Zoom
// "Personal Meeting Room" assets-ready notice. These should defer to a
// content-derived name instead.
function isGenericMeetingName(s) {
  return /\b(personal meeting room|meeting room|cloud recording|recording|meeting assets|assets)\b/i.test(s) ||
         /^meeting(\s+summary)?$/i.test(s.trim());
}

// Pull a short, title-like topic heading from the body's detailed "Summary"
// section (Zoom/Fathom lead each summary block with an <h3> topic title).
// Returns '' when no clean title-line is found.
// Tidy a summary: collapse the email's hard line-wrapping into clean prose and,
// defensively, drop any trailing section heading that bled in ("…before launch.
// Next steps Erica" → "…before launch.").
function cleanSummaryText(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  var cut = s.search(/\b(next steps|action items|action points|follow[\s-]?ups)\b/i);
  if (cut > 40) s = s.slice(0, cut).trim();
  return s;
}

function topicHeadingFromBody(body) {
  var sec = extractSection(body, ['summary', 'overview', 'quick recap', 'recap']);
  if (!sec) return '';
  var first = (sectionLines(sec)[0] || '').replace(/[:\s]+$/, '').trim();
  if (first.length >= 6 && first.length <= 60 &&
      first.split(/\s+/).length <= 9 && !/[.!?]$/.test(first)) {
    return capitalise(first);
  }
  return '';
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
// Airtable REST helpers
// ═══════════════════════════════════════════

function getExistingMeetingUuids(config) {
  var map = {};
  var offset = null;
  do {
    var url = 'https://api.airtable.com/v0/' + config.base + '/' + T.meetings +
      '?fields%5B%5D=' + MF.uuid + '&returnFieldsByFieldId=true&pageSize=100';
    if (offset) url += '&offset=' + offset;
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + config.pat },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) { Logger.log('uuid list: ' + resp.getContentText()); break; }
    var data = JSON.parse(resp.getContentText());
    (data.records || []).forEach(function (r) {
      var u = r.fields[MF.uuid];
      if (u) map[u] = r.id;
    });
    offset = data.offset || null;
  } while (offset);
  return map;
}

// Build a {lowercaseName: recordId} map for a linked table's primary field.
function getLinkNameMap(config, tableId, primaryFieldId) {
  var map = {};
  var offset = null;
  do {
    var url = 'https://api.airtable.com/v0/' + config.base + '/' + tableId +
      '?fields%5B%5D=' + primaryFieldId + '&returnFieldsByFieldId=true&pageSize=100';
    if (offset) url += '&offset=' + offset;
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + config.pat },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) { Logger.log('link map: ' + resp.getContentText()); break; }
    var data = JSON.parse(resp.getContentText());
    (data.records || []).forEach(function (r) {
      var v = r.fields[primaryFieldId];
      if (v && typeof v === 'object' && v.name) v = v.name;
      if (v) map[String(v).toLowerCase().trim()] = r.id;
    });
    offset = data.offset || null;
  } while (offset);
  return map;
}

function matchTeamMember(name, teamMap) {
  var low = String(name || '').toLowerCase().trim();
  if (teamMap[low]) return teamMap[low];
  // First-name / contains match
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

// Create a record; returns the new record id (or null on failure).
function createRecord(config, tableId, fields) {
  var url = 'https://api.airtable.com/v0/' + config.base + '/' + tableId;
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + config.pat, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ fields: fields, typecast: true }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) { Logger.log('create ' + tableId + ': ' + resp.getContentText()); return null; }
  return JSON.parse(resp.getContentText()).id;
}

function updateRecord(config, tableId, recordId, fields) {
  var url = 'https://api.airtable.com/v0/' + config.base + '/' + tableId + '/' + recordId;
  var resp = UrlFetchApp.fetch(url, {
    method: 'patch',
    headers: { 'Authorization': 'Bearer ' + config.pat, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ fields: fields, typecast: true }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) { Logger.log('update ' + tableId + ': ' + resp.getContentText()); return false; }
  return true;
}


// ═══════════════════════════════════════════
// Slack notification — via the always-on worker
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
