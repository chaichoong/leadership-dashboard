// apple-inbound worker — voice tasks, text/voice forwarding
// Cloudflare Worker: apple-inbound.kevinbrittain.workers.dev

const AIRTABLE_BASE = 'appnqjDpqDniH3IRl';
const TABLE_TASKS   = 'tblqB8b22hKBL4PF1';
const TABLE_PROJECTS = 'tblHrpTMd5LNYn8v1';
const TABLE_TEAM_MEMBERS = 'tblco0p2OnlLQVAX7';
const AIRTABLE_URL  = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_TASKS}`;
const RECIPIENT_EMAIL = 'kevinbrittain@gmail.com';

const FIELD = {
  taskName:     'fldgFjGBw6bTKJFCD',
  description:  'fldRGhBQViKZKtkQ6',
  status:       'fldx4qCw17UfrKpaN',
  isInbound:    'fldueazD67F7fUGee',
  assignee:     'fldELMncVJYPDRJNc',
  priority:     'fldS21RwmwOqt71LI',
  sender:       'fldzf4xlbrQuktx0i',
  dateReceived: 'fldR4peEZRXo7tjoI',
  messageBody:  'fldiSNijdCy5GXuzL',
  attachments:  'fldEbs9cscRr8elcw',
  collaborators:'fldcq3t6uAPgWSOP8',
  dueDate:      'fld7XP8w8kbxfETV4',
  timeEstimate: 'fld10VzzbiNNgRmIi',
  projects:     'fldBg0rQy0FrOAkRN',
  business:     'fldLu1Y4GzyWcDoxr',
};

// Project table field IDs (for reading project details to cascade to tasks)
const PF = {
  name:         'fldiMZICg1KOORpte',
  completed:    'fldliObR7TdTdjht7',
  business:     'fldtdJTFkMtldxEVf',
  projCollabs:  'fldN5l2H4WCsM0S3x',
};

const TEAM = [
  { key: 'kevin', name: 'Kevin Brittain', email: 'kevin@runpreneur.org.uk' },
  { key: 'mica',  name: 'Mica Albovias',  email: 'micaa.work@gmail.com' },
  { key: 'erica', name: 'Ericamae Atenta', email: 'atentaerica@gmail.com' },
  { key: 'gary',  name: 'Gary Marsh',      email: 'gkm.property.maintenance@outlook.com' },
  { key: 'rob',   name: 'Rob Jackson',     email: 'rjm320@hotmail.com' },
  { key: 'roy',   name: 'Roy Lavin',       email: 'roy.lavin1978@gmail.com' },
];

const VALID_PRIORITIES    = ['Project', 'Urgent', 'Not Urgent'];
const VALID_TIME_ESTIMATES = ['15 min', '30 min', '45 min', '1 hr', '2 hr', '3 hr', '4 hr', '8 hr'];
const VALID_STATUSES      = ['Today', 'Upcoming', 'Overdue'];

const KEVIN_EMAIL  = 'kevin@runpreneur.org.uk';
const SLACK_POST_URL   = 'https://slack.com/api/chat.postMessage';
const SLACK_LOOKUP_URL = 'https://slack.com/api/users.lookupByEmail';
const ANTHROPIC_URL    = 'https://api.anthropic.com/v1/messages';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
      const key = decodeURIComponent(url.pathname.slice('/files/'.length));
      return serveR2File(key, env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', worker: 'apple-inbound' });
    }
    // Diagnostic endpoint: test the parsing pipeline with a sample transcription
    if (request.method === 'GET' && url.pathname === '/test-parse') {
      if (!verifyBearer(request, env.BEARER_TOKEN)) {
        return json({ error: 'Unauthorized' }, 401);
      }
      try {
        const testText = url.searchParams.get('q') || 'This is a task for Kevin to build a module for meeting notes due next week, one hour, project based for operations director modules';
        const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Europe/London' }).slice(0, 10);
        // Test Airtable connectivity directly
        const tmUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_TEAM_MEMBERS}?fields[]=fldh16yvEgBy8uLKQ&returnFieldsByFieldId=true&pageSize=2`;
        const tmRes = await fetch(tmUrl, { headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` } });
        const tmStatus = tmRes.status;
        const tmBody = tmRes.ok ? await tmRes.json() : await tmRes.text();

        const pjUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_PROJECTS}?fields[]=${PF.name}&returnFieldsByFieldId=true&pageSize=2`;
        const pjRes = await fetch(pjUrl, { headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` } });
        const pjStatus = pjRes.status;
        const pjBody = pjRes.ok ? await pjRes.json() : await pjRes.text();

        const teamMembers = await fetchTeamMembers(env);
        const projects = await fetchProjects(env, teamMembers);
        const projectList = projects.map(p => `- "${p.name}" (ID: ${p.id})`).join('\n');
        const parsed = await parseWithClaude(env, testText, todayStr, projectList);
        const projectId = resolveProjectId(parsed.projectId, projects);
        const matchedProject = projectId ? projects.find(p => p.id === projectId) : null;
        return json({
          input: testText,
          today: todayStr,
          hasApiKey: !!env.ANTHROPIC_API_KEY,
          hasAirtablePat: !!env.AIRTABLE_PAT,
          airtablePatLength: env.AIRTABLE_PAT ? env.AIRTABLE_PAT.length : 0,
          teamMembersApiStatus: tmStatus,
          teamMembersApiResponse: tmRes.ok ? `${(tmBody.records||[]).length} records` : tmBody,
          projectsApiStatus: pjStatus,
          projectsApiResponse: pjRes.ok ? `${(pjBody.records||[]).length} records` : pjBody,
          projectCount: projects.length,
          teamMemberCount: Object.keys(teamMembers).length,
          projectList: projects.map(p => p.name),
          parsed,
          resolvedProjectId: projectId,
          matchedProjectName: matchedProject ? matchedProject.name : null,
        });
      } catch (err) {
        return json({ error: 'Test failed', detail: String(err), stack: err.stack }, 500);
      }
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }
    if (!verifyBearer(request, env.BEARER_TOKEN)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    try {
      if (url.pathname === '/voice-task')    return await handleVoiceTask(request, env);
      if (url.pathname === '/text-forward')  return await handleTextForward(request, env);
      if (url.pathname === '/voice-forward') return await handleVoiceForward(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('apple-inbound error:', err && err.stack || err);
      return json({ error: 'Internal error', detail: String(err) }, 500);
    }
  }
};

// ─── Voice Task (with AI parsing) ───────────────────────────────────

async function handleVoiceTask(request, env) {
  const body = await parseBody(request);
  const rawText = body.task_name || body.text || body.transcription || '';
  if (!rawText.trim()) {
    return json({ error: 'task_name or text is required' }, 400);
  }

  const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Europe/London' }).slice(0, 10);

  // Fetch team members (for collaborator resolution) and active projects
  const teamMembers = await fetchTeamMembers(env);
  const projects = await fetchProjects(env, teamMembers);
  const projectList = projects.map(p => `- "${p.name}" (ID: ${p.id})`).join('\n');

  // Parse the voice transcription with Claude
  const parsed = await parseWithClaude(env, rawText, todayStr, projectList);

  // Resolve assignee
  const assigneeEmail = resolveAssignee(parsed.assignee);

  // Resolve due date
  const dueDate = parsed.dueDate || todayStr;

  // Derive status from due date
  const status = deriveStatus(dueDate, todayStr);

  // Resolve time estimate to nearest valid option
  const timeEstimate = resolveTimeEstimate(parsed.timeMinutes);

  // Resolve priority
  const priority = VALID_PRIORITIES.includes(parsed.priority) ? parsed.priority : 'Not Urgent';

  // Resolve project — Claude returns the Airtable record ID directly
  const projectId = resolveProjectId(parsed.projectId, projects);
  const matchedProject = projectId ? projects.find(p => p.id === projectId) : null;

  // Build Airtable fields
  const fields = {
    [FIELD.taskName]:     parsed.taskTitle || rawText.trim(),
    [FIELD.status]:       status,
    [FIELD.priority]:     priority,
    [FIELD.dateReceived]: todayStr,
    [FIELD.dueDate]:      dueDate,
    [FIELD.timeEstimate]: timeEstimate,
    [FIELD.assignee]:     { email: assigneeEmail },
  };

  if (parsed.description) {
    fields[FIELD.description] = parsed.description;
  }

  // CASCADE from project: link project, inherit business + collaborators
  if (projectId) {
    fields[FIELD.projects] = [projectId];
    // When linked to a project, priority is always "Project"
    fields[FIELD.priority] = 'Project';

    if (matchedProject) {
      // Inherit business from project
      if (matchedProject.businessId) {
        fields[FIELD.business] = [matchedProject.businessId];
      }
      // Inherit collaborators from project
      if (matchedProject.collaboratorEmails && matchedProject.collaboratorEmails.length) {
        fields[FIELD.collaborators] = matchedProject.collaboratorEmails.map(email => ({ email }));
      }
    }
  }

  const record = await createAirtableRecord(fields, env);

  const finalPriority = fields[FIELD.priority];
  if (env.SLACK_BOT_TOKEN) {
    const parts = [`New task from Apple Watch: *${parsed.taskTitle || rawText.trim()}*`];
    if (matchedProject) parts.push(`Project: ${matchedProject.name}`);
    parts.push(`Due: ${dueDate} | ${timeEstimate} | ${finalPriority}`);
    await notifySlack(env, parts.join('\n'));
  }

  return json({
    ok: true,
    recordId: record.id,
    task: parsed.taskTitle || rawText.trim(),
    parsed: { dueDate, timeEstimate, priority: finalPriority, status, project: matchedProject ? matchedProject.name : null, assignee: assigneeEmail },
  });
}

// ─── Claude AI Parsing ──────────────────────────────────────────────

async function parseWithClaude(env, transcription, todayStr, projectList) {
  // Fallback if no API key configured
  if (!env.ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — falling back to defaults');
    return { taskTitle: transcription.trim(), dueDate: todayStr, timeMinutes: 15, priority: 'Not Urgent', assignee: 'kevin', projectId: null, description: null };
  }

  const todayDate = new Date(todayStr + 'T12:00:00Z');
  const dayOfWeek = todayDate.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });

  const systemPrompt = `You extract structured task data from voice transcriptions. Today is ${dayOfWeek} ${todayStr}. Respond with ONLY valid JSON, no markdown fences.

Team members: ${TEAM.map(t => t.key + ' (' + t.name + ')').join(', ')}

Active projects:
${projectList || '(none)'}

Valid priorities: Project, Urgent, Not Urgent
- "Project" means a task linked to a strategic project or module build
- "Urgent" means time-sensitive or blocking
- "Not Urgent" is the default

Valid time estimates (in minutes): 15, 30, 45, 60, 120, 180, 240, 480

Rules:
- "next week" means the Monday of the next calendar week (ISO week starting Monday)
- "tomorrow" means ${todayStr} + 1 day
- "end of week" means the coming Friday
- "this week" means today through Friday
- If no due date is mentioned, use today
- If no time estimate is mentioned, default to 30 minutes
- If no assignee is mentioned, default to "kevin"
- Extract a clean, concise task title (imperative voice, under 80 chars)
- If the transcription contains extra context beyond the title, put it in description

PROJECT MATCHING (critical):
- The user may refer to a project using loose keywords, abbreviations, or context clues
- Match the intent to the closest active project from the list above
- Examples: "operations director building modules" matches a project about building OD modules; "module building" or "OD modules" also match
- If the user says the task is "project-based" or mentions it relates to a project, you MUST try to match one
- Return the exact Airtable record ID (starts with "rec") from the project list, not the project name
- If no project matches, return null for projectId`;

  const userPrompt = `Parse this voice transcription into a task:

"${transcription}"

Return JSON: { "taskTitle": "...", "dueDate": "YYYY-MM-DD", "timeMinutes": <number>, "priority": "...", "assignee": "<team key>", "projectId": "<exact rec... ID from project list or null>", "description": "<extra context or null>" }`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // Model ID lives in wrangler.toml [vars] — never hardcode it here.
        model: env.AI_MODEL_DEFAULT,
        max_tokens: 300,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Claude API error:', res.status, errText);
      return fallbackParse(transcription, todayStr);
    }

    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';

    // Strip markdown fences if present
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      taskTitle:   typeof parsed.taskTitle === 'string' ? parsed.taskTitle : transcription.trim(),
      dueDate:     typeof parsed.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate) ? parsed.dueDate : todayStr,
      timeMinutes: typeof parsed.timeMinutes === 'number' ? parsed.timeMinutes : 30,
      priority:    typeof parsed.priority === 'string' ? parsed.priority : 'Not Urgent',
      assignee:    typeof parsed.assignee === 'string' ? parsed.assignee : 'kevin',
      projectId:   typeof parsed.projectId === 'string' && parsed.projectId.startsWith('rec') ? parsed.projectId : null,
      description: typeof parsed.description === 'string' ? parsed.description : null,
    };
  } catch (err) {
    console.error('Claude parse failed:', err);
    return fallbackParse(transcription, todayStr);
  }
}

function fallbackParse(transcription, todayStr) {
  return {
    taskTitle: transcription.trim(),
    dueDate: todayStr,
    timeMinutes: 30,
    priority: 'Not Urgent',
    assignee: 'kevin',
    projectId: null,
    description: null,
  };
}

// ─── Field Resolvers ────────────────────────────────────────────────

function resolveAssignee(key) {
  if (!key) return KEVIN_EMAIL;
  const member = TEAM.find(t => t.key === key.toLowerCase());
  return member ? member.email : KEVIN_EMAIL;
}

function resolveTimeEstimate(minutes) {
  if (!minutes || typeof minutes !== 'number') return '30 min';
  const map = { 15: '15 min', 30: '30 min', 45: '45 min', 60: '1 hr', 120: '2 hr', 180: '3 hr', 240: '4 hr', 480: '8 hr' };
  // Find the closest valid option
  let best = '30 min';
  let bestDiff = Infinity;
  for (const [mins, label] of Object.entries(map)) {
    const diff = Math.abs(Number(mins) - minutes);
    if (diff < bestDiff) { bestDiff = diff; best = label; }
  }
  return best;
}

function deriveStatus(dueDate, todayStr) {
  if (!dueDate) return 'Today';
  if (dueDate === todayStr) return 'Today';
  if (dueDate < todayStr) return 'Overdue';
  return 'Upcoming';
}

function resolveProjectId(projectId, projects) {
  if (!projectId) return null;
  // Validate the ID exists in our project list (prevents hallucinated IDs)
  const match = projects.find(p => p.id === projectId);
  return match ? match.id : null;
}

// ─── Airtable Helpers ───────────────────────────────────────────────

// Fetch Team Members table — maps record IDs to emails for collaborator resolution
async function fetchTeamMembers(env) {
  const tmMember = 'fldh16yvEgBy8uLKQ'; // singleCollaborator field (holds Airtable user + email)
  const tmActive = 'fld2YLfcPqSe6b60u'; // active checkbox
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_TEAM_MEMBERS}?fields[]=${tmMember}&fields[]=${tmActive}&returnFieldsByFieldId=true&pageSize=100`;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` },
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('Failed to fetch team members:', res.status, errBody);
      return {};
    }
    const data = await res.json();
    // Build map: record ID → email
    const map = {};
    for (const r of (data.records || [])) {
      const member = r.fields[tmMember];
      if (member && member.email) {
        map[r.id] = member.email;
      }
    }
    return map;
  } catch (err) {
    console.error('Team members fetch error:', err);
    return {};
  }
}

async function fetchProjects(env, teamMemberMap) {
  const fieldParams = [PF.name, PF.completed, PF.business, PF.projCollabs]
    .map(f => `fields[]=${f}`).join('&');
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_PROJECTS}?${fieldParams}&returnFieldsByFieldId=true&pageSize=100`;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}` },
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error('Failed to fetch projects:', res.status, errBody);
      return [];
    }
    const data = await res.json();
    return (data.records || [])
      .map(r => {
        const f = r.fields;
        // Business is a linked record field — extract the first record ID
        const bizRaw = f[PF.business];
        const businessId = Array.isArray(bizRaw) ? bizRaw[0] : (typeof bizRaw === 'string' ? bizRaw : null);
        // Collaborators — resolve Team Member record IDs to emails
        const collabRaw = f[PF.projCollabs] || [];
        const collabIds = Array.isArray(collabRaw) ? collabRaw : [];
        const collabEmails = collabIds
          .map(id => teamMemberMap[id])
          .filter(Boolean);
        return {
          id: r.id,
          name: f[PF.name] || '',
          completed: !!f[PF.completed],
          businessId,
          collaboratorEmails: collabEmails,
        };
      })
      .filter(p => p.name && !p.completed);
  } catch (err) {
    console.error('Project fetch error:', err);
    return [];
  }
}

async function createAirtableRecord(fields, env) {
  const res = await fetch(AIRTABLE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.AIRTABLE_PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable create failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ─── Text Forward (unchanged) ───────────────────────────────────────

async function handleTextForward(request, env) {
  const body = await parseBody(request);
  const text = body.text || body.message || body.content || '';
  if (!text.trim()) {
    return json({ error: 'text or message is required' }, 400);
  }
  const sender = body.sender || body.from || 'Unknown sender';
  const subject = `Text message for processing - from ${sender}`;
  const fromEmail = env.FROM_EMAIL || 'shortcuts@operationsdirector.co.uk';

  await sendViaResend(env, {
    from: `Apple Shortcut <${fromEmail}>`,
    to: RECIPIENT_EMAIL,
    subject,
    html: buildTextEmailHtml(text.trim(), sender),
    text: `Forwarded text message\nFrom: ${sender}\n\n${text.trim()}`,
  });

  if (env.SLACK_BOT_TOKEN) {
    await notifySlack(env, `Text forwarded to inbound from ${sender}`);
  }
  return json({ ok: true, subject });
}

// ─── Voice Forward (unchanged) ──────────────────────────────────────

async function handleVoiceForward(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let audioData, audioFilename, sender, transcription;

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('audio') || formData.get('file') || formData.get('voice');
    if (!file) return json({ error: 'audio file is required in form data' }, 400);
    audioData = await file.arrayBuffer();
    audioFilename = file.name || `voice-${Date.now()}.m4a`;
    sender = formData.get('sender') || formData.get('from') || 'Unknown sender';
    transcription = formData.get('transcription') || formData.get('notes') || formData.get('text') || '';
  } else {
    const body = await parseBody(request);
    if (body.audio_base64) {
      audioData = base64ToArrayBuffer(body.audio_base64);
      audioFilename = body.filename || `voice-${Date.now()}.m4a`;
    } else {
      return json({ error: 'audio file or audio_base64 is required' }, 400);
    }
    sender = body.sender || body.from || 'Unknown sender';
    transcription = body.transcription || body.notes || body.text || '';
  }

  const r2Key = `voice/${Date.now()}-${audioFilename}`;
  await env.ATTACHMENTS.put(r2Key, audioData, {
    httpMetadata: { contentType: guessAudioMime(audioFilename) },
  });
  const workerUrl = new URL(request.url);
  const publicUrl = `${workerUrl.origin}/files/${encodeURIComponent(r2Key)}`;
  const subject = `Voice message for processing - from ${sender}`;
  const fromEmail = env.FROM_EMAIL || 'shortcuts@operationsdirector.co.uk';

  await sendViaResend(env, {
    from: `Apple Shortcut <${fromEmail}>`,
    to: RECIPIENT_EMAIL,
    subject,
    html: buildVoiceEmailHtml(sender, publicUrl, audioFilename, transcription),
    text: buildVoiceEmailText(sender, publicUrl, transcription),
  });

  if (env.SLACK_BOT_TOKEN) {
    await notifySlack(env, `Voice message forwarded to inbound from ${sender}`);
  }
  return json({ ok: true, audioUrl: publicUrl });
}

// ─── Email Builders ─────────────────────────────────────────────────

async function sendViaResend(env, email) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: email.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${errBody}`);
  }
  return resp.json();
}

function buildTextEmailHtml(text, sender) {
  return `<div style="font-family:sans-serif;max-width:600px">
  <h3 style="color:#333">Forwarded text message</h3>
  <p><strong>From:</strong> ${escHtml(sender)}</p>
  <hr style="border:none;border-top:1px solid #ddd">
  <div style="white-space:pre-wrap;color:#222;line-height:1.6">${escHtml(text)}</div>
</div>`;
}

function buildVoiceEmailHtml(sender, audioUrl, filename, transcription) {
  const transcriptionBlock = transcription
    ? `<h4 style="color:#555">Transcription</h4>
  <div style="white-space:pre-wrap;color:#222;line-height:1.6;background:#f9f9f9;padding:12px;border-radius:6px">${escHtml(transcription)}</div>`
    : '<p style="color:#888"><em>No transcription provided. Listen to the audio below.</em></p>';
  return `<div style="font-family:sans-serif;max-width:600px">
  <h3 style="color:#333">Voice message for processing</h3>
  <p><strong>From:</strong> ${escHtml(sender)}</p>
  <hr style="border:none;border-top:1px solid #ddd">
  ${transcriptionBlock}
  <h4 style="color:#555">Audio file</h4>
  <p><a href="${escHtml(audioUrl)}" style="color:#2C6E49">${escHtml(filename)}</a></p>
</div>`;
}

function buildVoiceEmailText(sender, audioUrl, transcription) {
  let text = `Voice message for processing\nFrom: ${sender}\n\n`;
  if (transcription) text += `Transcription:\n${transcription}\n\n`;
  text += `Audio: ${audioUrl}`;
  return text;
}

// ─── Slack ──────────────────────────────────────────────────────────

async function notifySlack(env, message) {
  try {
    const slackId = await lookupSlackUser(env, KEVIN_EMAIL);
    if (!slackId) return;
    await fetch(SLACK_POST_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: slackId, text: message }),
    });
  } catch (err) {
    console.error('Slack notify failed (non-fatal):', err);
  }
}

async function lookupSlackUser(env, email) {
  const res = await fetch(`${SLACK_LOOKUP_URL}?email=${encodeURIComponent(email)}`, {
    headers: { 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.ok ? data.user.id : null;
}

// ─── R2 / Utilities ─────────────────────────────────────────────────

async function serveR2File(key, env) {
  const obj = await env.ATTACHMENTS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(obj.body, { headers });
}

function verifyBearer(request, expectedToken) {
  if (!expectedToken) return false;
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${expectedToken}`;
}

async function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return request.json();
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  const text = await request.text();
  try { return JSON.parse(text); }
  catch { return { text }; }
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function guessAudioMime(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimes = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac', caf: 'audio/x-caf' };
  return mimes[ext] || 'audio/mp4';
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
