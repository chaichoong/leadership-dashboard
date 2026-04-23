/**
 * Contractor Bot — Airtable Scripting Action
 * ===========================================
 * Routes inbound Slack messages from external contractors into the Tasks table.
 *
 * Trigger: Airtable automation "When a Slack message is posted" (channel
 *   #property-management) → this script. The Slack event payload is passed in
 *   via input variables (see INPUT VARIABLES below).
 *
 * Intents handled (classified by Claude):
 *   1. new_job       — contractor reports a new maintenance job
 *   2. status_update — contractor reports progress on an existing job
 *   3. list_request  — contractor asks "what's on my list"
 *   4. unknown       — bot replies asking for clarification
 *
 * External dependencies:
 *   - Claude proxy:  https://claude-proxy.kevinbrittain.workers.dev
 *       Accepts:  POST { model, max_tokens, system, messages: [{role, content}] }
 *       Returns:  Anthropic-standard { content: [{type: "text", text: "..."}] }
 *   - Slack Web API:  https://slack.com/api/chat.postMessage
 *       Requires a bot token with scopes: chat:write, users:read
 *
 * Configuration lives at the TOP of this script. Update once the contractor
 * collaborator IDs are known.
 */

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

// Contractor lookup: Slack user ID → Airtable collaborator user record.
// Populate usrIds once Gary/Roy/Rob have accepted their Airtable invites.
const CONTRACTORS = {
  U0A9XD12YPN: { name: 'Gary Marsh',  firstName: 'Gary',  airtableUserId: 'usrTODO_GARY' },
  U0AAN4CTVQQ: { name: 'Roy Lavin',   firstName: 'Roy',   airtableUserId: 'usrTODO_ROY' },
  U0A9MDFKA59: { name: 'Rob Jackson', firstName: 'Rob',   airtableUserId: 'usrTODO_ROB' },
};

// Slack bot token — MUST be set as an Airtable automation secret rather than
// hard-coded. Placeholder shown for clarity; read it from input variables.
// See README for setup.

// Airtable table IDs / field IDs (match the rest of the web app).
const TABLE_TASKS = 'tblqB8b22hKBL4PF1';
const TABLE_PROPERTIES = 'tbl6f0OkAmTC2jbuG';
const FIELD = {
  // Tasks
  taskName:         'fldgFjGBw6bTKJFCD', // single line text
  description:      'fldRGhBQViKZKtkQ6', // richText
  status:           'fldx4qCw17UfrKpaN', // singleSelect — Upcoming / Today / Completed / …
  priority:         'fldS21RwmwOqt71LI', // singleSelect — Urgent / High / Project / Not Urgent
  assignee:         'fldELMncVJYPDRJNc', // singleCollaborator
  properties:       'fldZKFvEpJ6NZeFKz', // multipleRecordLinks → Properties
  maintenanceTick:  'fldSEUvVA98as1HW6', // checkbox
  attachments:      'fldEbs9cscRr8elcw', // multipleAttachments
  notes:            'fldR7apBzSp3oxFxz', // long text (contractor-updatable notes)
  dueDate:          'fld7XP8w8kbxfETV4', // date
  timeEstimate:     'fld10VzzbiNNgRmIi', // singleSelect
  // Properties
  propertyName:     'fldy2t735TV5e1DIL', // single line text
};

const CLAUDE_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';
const MODEL_FAST   = 'claude-haiku-4-5-20251001';

// ─── INPUT VARIABLES (from Airtable automation trigger) ───────────────────────

const {
  messageText,    // string — the Slack message body
  slackUserId,    // string — e.g. "U0A9XD12YPN"
  slackTs,        // string — message timestamp (used to reply in thread)
  threadTs,       // string | null — if the message is already a thread reply
  channel,        // string — channel ID, e.g. "C09EMKREPJL"
  slackBotToken,  // string — xoxb-… (set as automation secret)
} = input.config();

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

await main();

async function main() {
  const contractor = CONTRACTORS[slackUserId];
  if (!contractor) {
    // Message is from Kevin/Mica/Ericamae or a non-contractor — ignore silently.
    output.set('skipped', 'not a contractor');
    return;
  }

  const text = (messageText || '').trim();
  if (!text) {
    output.set('skipped', 'empty message');
    return;
  }

  const intent = await classifyIntent(text);
  output.set('intent', intent);

  switch (intent) {
    case 'new_job':
      await handleNewJob(contractor, text);
      break;
    case 'status_update':
      await handleStatusUpdate(contractor, text);
      break;
    case 'list_request':
      await handleListRequest(contractor);
      break;
    default:
      await replyInThread(
        `Hi ${contractor.firstName}, I'm not sure what you need. Try:\n` +
        `• *New job* — describe what needs doing and at which property\n` +
        `• *Update* — tell me if you've started or finished a job\n` +
        `• *My list* — ask "what's on my list" to see your open jobs`
      );
  }
}

// ─── INTENT CLASSIFICATION ────────────────────────────────────────────────────

async function classifyIntent(text) {
  const system =
    `You classify short Slack messages from maintenance contractors into exactly one of:\n` +
    `  new_job        — reporting a new job that needs doing\n` +
    `  status_update  — reporting progress on an existing job (started, done, blocked, adding a note)\n` +
    `  list_request   — asking to see their open jobs / current workload\n` +
    `  unknown        — anything else, or too ambiguous\n\n` +
    `Respond with ONLY the single label, no other text.`;

  const label = await callClaude({
    system,
    messages: [{ role: 'user', content: text }],
    maxTokens: 10,
  });
  const clean = (label || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  if (['new_job', 'status_update', 'list_request', 'unknown'].includes(clean)) return clean;
  return 'unknown';
}

// ─── HANDLER 1: NEW JOB ───────────────────────────────────────────────────────

async function handleNewJob(contractor, text) {
  // Step A: ask Claude to extract structured fields from the message.
  const extraction = await extractNewJobFields(text);

  // Step B: property match.
  const propertyMatches = await matchProperty(extraction.propertyHint);
  if (propertyMatches.length === 0) {
    await replyInThread(
      `Hi ${contractor.firstName}, I couldn't work out which property that's at. ` +
      `Can you reply with the property name or address?`
    );
    return;
  }
  if (propertyMatches.length > 1) {
    const list = propertyMatches.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}`).join('\n');
    await replyInThread(
      `A few properties match. Which one?\n${list}\nReply with the number or the full address.`
    );
    return;
  }
  const property = propertyMatches[0];

  // Step C: priority mapping (High Priority → Urgent, Low Priority → Not Urgent).
  const priority = extraction.priority === 'High Priority' ? 'Urgent' : 'Not Urgent';

  // Step D: create the task.
  const tasksTable = base.getTable(TABLE_TASKS);
  const newId = await tasksTable.createRecordAsync({
    [FIELD.taskName]:        extraction.taskName,
    [FIELD.description]:     text, // full original message as the description
    [FIELD.status]:          { name: 'Upcoming' },
    [FIELD.priority]:        { name: priority },
    [FIELD.assignee]:        { id: contractor.airtableUserId },
    [FIELD.properties]:      [{ id: property.id }],
    [FIELD.maintenanceTick]: true,
  });

  // Step E: reply in thread confirming.
  await replyInThread(
    `✅ Logged, ${contractor.firstName}.\n` +
    `*${extraction.taskName}*\n` +
    `📍 ${property.name}\n` +
    `⚡ Priority: ${priority}\n` +
    `Added to your list.`
  );
}

async function extractNewJobFields(text) {
  const system =
    `Extract structured fields from a maintenance contractor's Slack message about a new job.\n\n` +
    `Respond with ONLY valid JSON (no markdown, no code fences) matching:\n` +
    `{\n` +
    `  "taskName": "short 3-7 word title, e.g. 'Fix boiler - no hot water'",\n` +
    `  "propertyHint": "the property name/address mentioned, or empty string",\n` +
    `  "priority": "High Priority" or "Low Priority"\n` +
    `}\n\n` +
    `High Priority = health/safety risk, no heating/hot water, water leaks, structural,\n` +
    `security, electrical faults, gas, fire safety, flooding, sewage.\n` +
    `Low Priority = cosmetic, non-urgent, wear and tear, painting, external/garden.`;

  const raw = await callClaude({
    system,
    messages: [{ role: 'user', content: text }],
    maxTokens: 200,
  });
  try {
    return JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
  } catch (e) {
    return { taskName: text.slice(0, 60), propertyHint: '', priority: 'Low Priority' };
  }
}

async function matchProperty(hint) {
  if (!hint) return [];
  const propertiesTable = base.getTable(TABLE_PROPERTIES);
  const query = await propertiesTable.selectRecordsAsync({
    fields: [FIELD.propertyName],
  });
  const needle = hint.toLowerCase();
  return query.records
    .map(r => ({ id: r.id, name: r.getCellValueAsString(FIELD.propertyName) }))
    .filter(p => p.name && p.name.toLowerCase().includes(needle));
}

// ─── HANDLER 2: STATUS UPDATE ─────────────────────────────────────────────────

async function handleStatusUpdate(contractor, text) {
  const openTasks = await fetchOpenTasksFor(contractor);
  if (openTasks.length === 0) {
    await replyInThread(`${contractor.firstName}, you don't have any open jobs right now.`);
    return;
  }

  // Ask Claude to figure out which task + what kind of update.
  const match = await matchStatusUpdate(text, openTasks);

  if (match.matchedTaskIndex === -1) {
    await replyInThread(
      `I can't tell which job you mean, ${contractor.firstName}. Your open jobs:\n` +
      openTasks.map((t, i) => `${i + 1}. ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`).join('\n') +
      `\nReply with the number or job name.`
    );
    return;
  }

  const target = openTasks[match.matchedTaskIndex];
  const tasksTable = base.getTable(TABLE_TASKS);

  if (match.action === 'completed') {
    await tasksTable.updateRecordAsync(target.id, {
      [FIELD.status]: { name: 'Completed' },
    });
    await replyInThread(`✅ Marked complete: *${target.taskName}*. Nice one ${contractor.firstName}.`);
  } else if (match.action === 'in_progress') {
    await tasksTable.updateRecordAsync(target.id, {
      [FIELD.status]: { name: 'Today' },
    });
    await replyInThread(`👍 Got it — *${target.taskName}* is now in progress.`);
  } else if (match.action === 'note') {
    const newNote = buildNotePrefix(contractor) + match.noteText;
    const combined = target.notes ? target.notes + '\n\n' + newNote : newNote;
    await tasksTable.updateRecordAsync(target.id, {
      [FIELD.notes]: combined,
    });
    await replyInThread(`📝 Note added to *${target.taskName}*.`);
  } else {
    await replyInThread(`I caught your message but wasn't sure what to do with it.`);
  }
}

async function matchStatusUpdate(text, openTasks) {
  const taskList = openTasks.map((t, i) => `${i}: ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`).join('\n');
  const system =
    `A contractor has sent a Slack message about their work. Match it to one of the open jobs\n` +
    `below and classify the action.\n\n` +
    `OPEN JOBS:\n${taskList}\n\n` +
    `Respond with ONLY valid JSON (no markdown):\n` +
    `{\n` +
    `  "matchedTaskIndex": number  // 0-based index, or -1 if no confident match\n` +
    `  "action": "completed" | "in_progress" | "note"\n` +
    `  "noteText": string  // empty unless action === "note"; the user's note content\n` +
    `}\n\n` +
    `Examples:\n` +
    `- "done with the boiler" → completed, match the boiler job\n` +
    `- "started the Elmdon leak" → in_progress\n` +
    `- "waiting for a part on the front door job" → note, noteText contains the waiting message`;

  const raw = await callClaude({
    system,
    messages: [{ role: 'user', content: text }],
    maxTokens: 250,
  });
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
    return {
      matchedTaskIndex: Number.isInteger(parsed.matchedTaskIndex) ? parsed.matchedTaskIndex : -1,
      action: parsed.action || 'note',
      noteText: parsed.noteText || text,
    };
  } catch (e) {
    return { matchedTaskIndex: -1, action: 'note', noteText: text };
  }
}

// ─── HANDLER 3: LIST REQUEST ──────────────────────────────────────────────────

async function handleListRequest(contractor) {
  const tasks = await fetchOpenTasksFor(contractor);
  if (tasks.length === 0) {
    await replyInThread(`✨ Nothing on your list, ${contractor.firstName}. All clear.`);
    return;
  }

  const lines = tasks.map((t, i) => {
    const pri = t.priority === 'Urgent' ? ' 🔴' : '';
    const prop = t.propertyName ? ` — ${t.propertyName}` : '';
    return `${i + 1}. *${t.taskName}*${prop}${pri}`;
  });
  await replyInThread(
    `${contractor.firstName}, here's your list (${tasks.length}):\n${lines.join('\n')}`
  );
}

// ─── DATA HELPERS ─────────────────────────────────────────────────────────────

async function fetchOpenTasksFor(contractor) {
  const tasksTable = base.getTable(TABLE_TASKS);
  const query = await tasksTable.selectRecordsAsync({
    fields: [
      FIELD.taskName, FIELD.status, FIELD.priority, FIELD.assignee,
      FIELD.properties, FIELD.notes, FIELD.maintenanceTick,
    ],
  });

  return query.records
    .map(r => {
      const assignee = r.getCellValue(FIELD.assignee);
      const status = r.getCellValue(FIELD.status);
      const priority = r.getCellValue(FIELD.priority);
      const props = r.getCellValue(FIELD.properties) || [];
      return {
        id: r.id,
        taskName: r.getCellValueAsString(FIELD.taskName),
        assigneeId: assignee && assignee.id,
        status: status && status.name,
        priority: priority && priority.name,
        propertyName: props[0] ? props[0].name : '',
        notes: r.getCellValueAsString(FIELD.notes),
        maintenanceTicket: r.getCellValue(FIELD.maintenanceTick),
      };
    })
    .filter(t =>
      t.assigneeId === contractor.airtableUserId &&
      t.status !== 'Completed'
    )
    .sort((a, b) => {
      // Urgent first
      const pa = a.priority === 'Urgent' ? 0 : 1;
      const pb = b.priority === 'Urgent' ? 0 : 1;
      return pa - pb;
    });
}

function buildNotePrefix(contractor) {
  const now = new Date();
  const d = now.toLocaleDateString('en-GB');
  const t = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `[${contractor.firstName} — ${d} ${t}] `;
}

// ─── EXTERNAL API CALLS ───────────────────────────────────────────────────────

async function callClaude({ system, messages, maxTokens }) {
  const resp = await fetch(CLAUDE_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_FAST,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Claude proxy error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const text = data.content && data.content[0] && data.content[0].text;
  return text || '';
}

async function replyInThread(text) {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + slackBotToken,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs || slackTs, // reply in thread of the original message
    }),
  });
  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Slack post failed: ${data.error}`);
  }
}
