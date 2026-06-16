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
        tasksCreated++;

        // Slack DM the assignee (except Kevin) via the always-on worker.
        if (email !== KEVIN_EMAIL) {
          notifySlack(config, slackEmailFor(email), item.text, taskId, todayStr,
                      TASK_DEFAULT_TIME);
        }
        if (taskIds.length % 4 === 0) Utilities.sleep(1000);
      }

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


// ═══════════════════════════════════════════
// Parse one Gmail message into meeting data
// ═══════════════════════════════════════════

function parseMeeting(msg) {
  var subject = msg.getSubject() || '';
  var from    = msg.getFrom() || '';
  var date    = msg.getDate();

  // Prefer plain body; fall back to a stripped HTML body.
  var body = msg.getPlainBody() || '';
  if (!body || body.trim().length < 40) {
    body = htmlToText(msg.getBody() || '');
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
  var aiSummary = summary || firstChars(body, 1500);
  var actionLines = splitBullets(nextSteps);

  // Meeting name — short plain-language label
  var meetingName = deriveMeetingName(subject, body);
  var isWeeklyCheckin = /weekly check[\s-]?in|weekly check\b|weekly catch[\s-]?up/.test(lowSubj + ' ' + lowBody);

  // Attendees — from a "Next steps grouped by person" structure or a participants line
  var attendees = extractAttendees(body, nextSteps);

  // Project, if explicitly named in the subject ("X Project Meeting")
  var projectName = (subject.match(/([A-Z][\w&]+(?:\s+[A-Z][\w&]+)*)\s+project\b/i) || [])[1] || '';

  // Tasks from the action lines. A clear owner + commitment always makes a task.
  // For weekly check-ins ONLY, an owner-less imperative ("Update the tracker
  // daily") also becomes a task — it gets assigned to the weekly default (Mica).
  var tasks = [];
  for (var i = 0; i < actionLines.length; i++) {
    var parsedTask = parseActionLine(actionLines[i]);
    if (!parsedTask && isWeeklyCheckin) parsedTask = parseImperativeLine(actionLines[i]);
    if (parsedTask) tasks.push(parsedTask);
  }

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
  // Skip filler that isn't really a person (very rough guard).
  if (/^(The|This|That|We|They|It|Next|Action|Summary|Quick|Recap)$/i.test(owner.split(' ')[0])) return null;

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
  'test','fix','design','chase','collate','compile','reconcile','upload','share'];

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

// Pull the body of a labelled section up to the next ALL-CAPS-ish heading.
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
          if (!raw) { if (out.length) break; else continue; }
          // Stop at the next section heading
          if (isHeading(raw)) break;
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
    .replace(/\s*[-–—|:]?\s*(?:is now available|is ready|recording|meeting summary|summary)\s*$/i, '')
    // Only cut on a SPACED separator (a real divider like " | " or " – "),
    // never a bare hyphen — that keeps "Check-in", "Follow-up", "Catch-up".
    .replace(/\s+[|–—]\s+.*$/, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length >= 4 && s.length <= 60) return s;
  var low = (subject + ' ' + body).toLowerCase();
  if (/weekly check|catch[\s-]?up/.test(low)) return 'Weekly Check-in';
  if (/project/.test(low)) return 'Project Meeting';
  return 'Meeting Summary';
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
