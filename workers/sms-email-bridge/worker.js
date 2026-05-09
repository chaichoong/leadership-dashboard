/**
 * SMS-to-Email Bridge Worker
 *
 * Polls GHL every minute for new inbound SMS messages and forwards them
 * as emails via Resend, so SMS appears in Gmail for Inbound Comms triage.
 *
 * Also accepts direct webhook POSTs as a secondary path.
 *
 * Environment variables (set as Worker secrets):
 *   RESEND_API_KEY     - Resend API key
 *   RECIPIENT_EMAIL    - Gmail address to receive SMS-as-email
 *   GHL_API_KEY        - GoHighLevel Private Integration Token
 *   GHL_LOCATION_ID    - GoHighLevel location ID
 *   FROM_EMAIL         - Sending address (e.g. sms@operationsdirector.co.uk)
 *
 * KV Namespace:
 *   SMS_STATE          - Tracks last-processed message timestamp
 */

export default {
  /* ------------------------------------------------------------------ */
  /*  HTTP handler (health, test, webhook fallback)                      */
  /* ------------------------------------------------------------------ */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'sms-email-bridge', mode: 'polling' });
    }

    if (url.pathname === '/test' && request.method === 'GET') {
      const lastPoll = await env.SMS_STATE.get('lastPollTime');
      const lastMsgTs = await env.SMS_STATE.get('lastMessageTimestamp');
      const forwardedCount = await env.SMS_STATE.get('forwardedCount');
      return json({
        status: 'ok',
        configured: {
          resend: !!env.RESEND_API_KEY,
          recipient: !!env.RECIPIENT_EMAIL,
          ghl: !!env.GHL_API_KEY,
          locationId: !!env.GHL_LOCATION_ID,
          fromEmail: env.FROM_EMAIL || 'sms@operationsdirector.co.uk',
        },
        polling: {
          lastPoll: lastPoll || 'never',
          lastMessageTimestamp: lastMsgTs || 'none',
          forwardedCount: parseInt(forwardedCount || '0', 10),
        },
      });
    }

    // Reset checkpoint (for testing/debug)
    if (url.pathname === '/reset' && request.method === 'POST') {
      const secret = request.headers.get('x-webhook-secret');
      if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
        return json({ error: 'Unauthorized' }, 401);
      }
      await env.SMS_STATE.delete('lastMessageTimestamp');
      await env.SMS_STATE.put('forwardedCount', '0');
      return json({ status: 'reset' });
    }

    // Manual trigger for testing
    if (url.pathname === '/poll' && request.method === 'POST') {
      const secret = request.headers.get('x-webhook-secret');
      if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const result = await pollGhlMessages(env);
      return json(result);
    }

    // SMS reply: send a message back through GHL
    if (url.pathname === '/ghl-reply' && request.method === 'POST') {
      return handleSmsReply(request, env);
    }

    // Webhook fallback (if GHL webhooks ever get configured)
    if (url.pathname === '/webhook/inbound-sms' && request.method === 'POST') {
      return handleInboundSms(request, env);
    }

    return json({ error: 'Not found' }, 404);
  },

  /* ------------------------------------------------------------------ */
  /*  Cron handler — polls GHL every minute                              */
  /* ------------------------------------------------------------------ */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollGhlMessages(env));
  },
};


/* ------------------------------------------------------------------ */
/*  Poll GHL for new inbound SMS messages                              */
/* ------------------------------------------------------------------ */

async function pollGhlMessages(env) {
  const locationId = env.GHL_LOCATION_ID;
  if (!locationId || !env.GHL_API_KEY) {
    return { status: 'skipped', reason: 'missing GHL credentials' };
  }

  await env.SMS_STATE.put('lastPollTime', new Date().toISOString());

  // Get the timestamp of the last message we processed (stored as epoch ms)
  const lastTimestamp = parseInt(await env.SMS_STATE.get('lastMessageTimestamp') || '0', 10);
  // If first run, default to 60 minutes ago to catch recent messages
  const effectiveTimestamp = lastTimestamp || (Date.now() - 60 * 60 * 1000);

  try {
    // Search for recent conversations sorted by last message date
    const searchUrl = new URL('https://services.leadconnectorhq.com/conversations/search');
    searchUrl.searchParams.set('locationId', locationId);
    searchUrl.searchParams.set('limit', '20');
    searchUrl.searchParams.set('sort', 'desc');
    searchUrl.searchParams.set('sortBy', 'last_message_date');

    const convResp = await fetch(searchUrl.toString(), {
      headers: {
        Authorization: `Bearer ${env.GHL_API_KEY}`,
        Version: '2021-07-28',
      },
    });

    if (!convResp.ok) {
      const errText = await convResp.text();
      console.error('GHL conversations search failed:', convResp.status, errText);
      return { status: 'error', detail: `GHL API ${convResp.status}` };
    }

    const data = await convResp.json();
    const conversations = data.conversations || [];

    let forwarded = 0;
    let highestTimestamp = effectiveTimestamp;

    // Process each conversation that has new messages since our last poll
    for (const conv of conversations) {
      // conv.lastMessageDate is epoch ms from GHL
      const convTs = typeof conv.lastMessageDate === 'number'
        ? conv.lastMessageDate
        : new Date(conv.lastMessageDate).getTime();

      // Skip conversations where last message is older than our checkpoint
      if (convTs <= effectiveTimestamp) continue;

      // Only process SMS/phone conversations with inbound messages
      if (conv.type !== 'TYPE_PHONE') continue;
      if (conv.lastMessageDirection !== 'inbound') continue;

      // Fetch the actual messages for this conversation
      const messages = await fetchConversationMessages(conv.id, env);

      for (const msg of messages) {
        // Parse message timestamp (ISO string from GHL)
        const msgTs = new Date(msg.dateAdded).getTime();

        // Skip messages we've already processed
        if (msgTs <= effectiveTimestamp) continue;
        // Forward all inbound phone activity (SMS=2, Call=1, Voicemail=4/5)
        // Skip emails (3), system activity (28, 31), and outbound messages
        if (msg.direction !== 'inbound') continue;
        if (msg.type === 3 || msg.type === 28 || msg.type === 31) continue;

        const isSms = (msg.type === 2);
        const isCall = (msg.type === 1);
        const rawBody = msg.body || msg.message || '';

        // Determine the tag and message content
        let tag, body;
        if (isSms) {
          if (!rawBody.trim()) continue;
          tag = 'SMS';
          body = rawBody;
        } else if (isCall) {
          tag = 'Missed Call';
          body = rawBody.trim() || 'Missed call received. Please call back or follow up.';
        } else {
          // Voicemail or other phone types
          tag = 'Voicemail';
          body = rawBody.trim() || 'Voicemail received. Check GHL for the recording.';
        }

        const contactName = conv.fullName || conv.contactName || '';
        const phone = msg.from || conv.phone || '';
        const conversationId = conv.id;
        const timestamp = msg.dateAdded;

        await forwardSmsAsEmail(env, {
          contactName,
          phone,
          body,
          conversationId,
          contactId: conv.contactId || '',
          timestamp,
          tag,
        });

        forwarded++;

        if (msgTs > highestTimestamp) {
          highestTimestamp = msgTs;
        }
      }

      // Also update for conversations we checked (even if no new inbound SMS)
      if (convTs > highestTimestamp) {
        highestTimestamp = convTs;
      }
    }

    // Update checkpoint (always store as epoch ms)
    if (highestTimestamp > effectiveTimestamp) {
      await env.SMS_STATE.put('lastMessageTimestamp', String(highestTimestamp));
    }

    // Update forwarded count
    if (forwarded > 0) {
      const prev = parseInt(await env.SMS_STATE.get('forwardedCount') || '0', 10);
      await env.SMS_STATE.put('forwardedCount', String(prev + forwarded));
    }

    return { status: 'ok', forwarded, conversationsChecked: conversations.length };

  } catch (err) {
    console.error('Poll error:', err.message);
    return { status: 'error', detail: err.message };
  }
}


/* ------------------------------------------------------------------ */
/*  Fetch messages for a specific conversation                         */
/* ------------------------------------------------------------------ */

async function fetchConversationMessages(conversationId, env) {
  try {
    const resp = await fetch(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages?limit=10`,
      {
        headers: {
          Authorization: `Bearer ${env.GHL_API_KEY}`,
          Version: '2021-07-28',
        },
      }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    // GHL nests messages: { messages: { messages: [...], lastMessageId, nextPage } }
    const wrapper = data.messages || data.data || {};
    if (Array.isArray(wrapper)) return wrapper;
    return wrapper.messages || [];
  } catch {
    return [];
  }
}


/* ------------------------------------------------------------------ */
/*  Forward a single SMS as email                                      */
/* ------------------------------------------------------------------ */

async function forwardSmsAsEmail(env, sms) {
  const contactName = sms.contactName || sms.phone || 'Unknown';
  const phone = sms.phone || '';
  const conversationId = sms.conversationId || '';
  const tag = sms.tag || 'SMS';
  const messagePreview = sms.body.length > 60
    ? sms.body.substring(0, 57) + '...'
    : sms.body;

  const subject = `[${tag}] ${contactName}: ${messagePreview}`;
  const fromEmail = env.FROM_EMAIL || 'sms@operationsdirector.co.uk';
  const fromName = `${tag} from ${contactName}`;

  const htmlBody = buildEmailHtml({
    contactName,
    phone,
    body: sms.body,
    conversationId,
    timestamp: sms.timestamp || new Date().toISOString(),
    tag,
  });

  const plainBody = [
    `${tag} from ${contactName}`,
    phone ? `Phone: ${phone}` : '',
    `Received: ${sms.timestamp || new Date().toISOString()}`,
    '',
    sms.body,
    '',
    `---`,
    `GHL Conversation: ${conversationId}`,
  ].filter(Boolean).join('\n');

  const result = await sendViaResend(env, {
    from: `${fromName} <${fromEmail}>`,
    to: env.RECIPIENT_EMAIL,
    subject,
    html: htmlBody,
    text: plainBody,
    replyTo: env.RECIPIENT_EMAIL,
    headers: {
      'X-SMS-ConversationId': conversationId,
      'X-SMS-Phone': phone,
      'X-SMS-ContactName': contactName,
    },
  });

  console.log(`Forwarded SMS from ${contactName} (${phone}), emailId: ${result.id}`);
  return result;
}


/* ------------------------------------------------------------------ */
/*  SMS reply handler — sends reply through GHL as SMS                 */
/* ------------------------------------------------------------------ */

async function handleSmsReply(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  // Auth: accept the GHL API key in header or use the Worker's own key
  const providedKey = request.headers.get('x-ghl-key') || env.GHL_API_KEY;
  if (!providedKey) {
    return json({ error: 'No GHL API key available' }, 401);
  }

  const { conversationId, message, type } = payload;
  if (!conversationId || !message) {
    return json({ error: 'Missing conversationId or message' }, 400);
  }

  try {
    // GHL requires contactId to send messages. Look it up from the conversation.
    let contactId = payload.contactId;
    if (!contactId) {
      const convResp = await fetch(
        `https://services.leadconnectorhq.com/conversations/${conversationId}`,
        {
          headers: {
            Authorization: `Bearer ${providedKey}`,
            Version: '2021-07-28',
          },
        }
      );
      if (convResp.ok) {
        const convData = await convResp.json();
        contactId = (convData.conversation || convData).contactId;
      }
    }

    if (!contactId) {
      return json({ error: 'Could not resolve contactId for this conversation' }, 400);
    }

    const resp = await fetch(
      `https://services.leadconnectorhq.com/conversations/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${providedKey}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
        body: JSON.stringify({
          type: 'SMS',
          contactId,
          conversationId,
          message,
        }),
      }
    );

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('GHL send SMS failed:', resp.status, errBody);
      return json({ error: 'GHL SMS send failed', detail: errBody }, resp.status);
    }

    const result = await resp.json();
    return json({ status: 'sent', messageId: result.messageId || result.id });
  } catch (err) {
    console.error('GHL reply error:', err.message);
    return json({ error: 'SMS reply failed', detail: err.message }, 502);
  }
}


/* ------------------------------------------------------------------ */
/*  Webhook handler (fallback if GHL webhooks get configured later)    */
/* ------------------------------------------------------------------ */

async function handleInboundSms(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const secret = request.headers.get('x-webhook-secret');
  if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const sms = normalisePayload(payload);
  if (!sms.body) {
    return json({ status: 'ignored', reason: 'no message body' });
  }

  if (!sms.contactName && sms.contactId && env.GHL_API_KEY) {
    sms.contactName = await lookupContactName(sms.contactId, env);
  }

  try {
    const result = await forwardSmsAsEmail(env, sms);
    return json({ status: 'forwarded', emailId: result.id });
  } catch (err) {
    console.error('Resend send failed:', err.message);
    return json({ error: 'Email delivery failed', detail: err.message }, 502);
  }
}


/* ------------------------------------------------------------------ */
/*  GHL payload normalisation (for webhook path)                       */
/* ------------------------------------------------------------------ */

function normalisePayload(p) {
  if (p.type === 'InboundMessage' || p.type === 'OutboundMessage') {
    return {
      body: p.body || p.message || '',
      phone: p.phone || p.from || '',
      contactName: p.contactName || p.name || '',
      contactId: p.contactId || '',
      conversationId: p.conversationId || '',
      timestamp: p.dateAdded || p.createdAt || '',
    };
  }

  if (p.message && typeof p.message === 'object') {
    return {
      body: p.message.body || p.message.message || '',
      phone: p.message.phone || p.contact?.phone || '',
      contactName: p.contact?.name || p.contact?.contactName || '',
      contactId: p.contact?.id || p.contactId || '',
      conversationId: p.message.conversationId || p.conversationId || '',
      timestamp: p.message.dateAdded || p.message.createdAt || '',
    };
  }

  return {
    body: p.body || p.message || '',
    phone: p.phone || p.from || '',
    contactName: p.contactName || p.name || p.fullName || '',
    contactId: p.contactId || '',
    conversationId: p.conversationId || '',
    timestamp: p.dateAdded || p.createdAt || '',
  };
}


/* ------------------------------------------------------------------ */
/*  Contact name lookup via GHL API                                    */
/* ------------------------------------------------------------------ */

async function lookupContactName(contactId, env) {
  try {
    const resp = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      {
        headers: {
          Authorization: `Bearer ${env.GHL_API_KEY}`,
          Version: '2021-07-28',
        },
      }
    );
    if (!resp.ok) return '';
    const data = await resp.json();
    const c = data.contact || data;
    return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || '';
  } catch {
    return '';
  }
}


/* ------------------------------------------------------------------ */
/*  Email HTML builder                                                 */
/* ------------------------------------------------------------------ */

function buildEmailHtml({ contactName, phone, body, conversationId, timestamp, tag }) {
  const escapedBody = escapeHtml(body).replace(/\n/g, '<br>');
  const escapedName = escapeHtml(contactName);
  const escapedPhone = escapeHtml(phone);
  const formattedTime = new Date(timestamp).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const isSms = (tag === 'SMS');
  const borderColour = isSms ? '#2C6E49' : '#C6A15B';
  const bgColour = isSms ? '#f0fdf4' : '#fefce8';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${bgColour}; border-left: 4px solid ${borderColour}; padding: 16px; border-radius: 4px; margin-bottom: 16px;">
    <div style="font-weight: 600; color: #1C2422; font-size: 16px;">
      ${tag} from ${escapedName}
    </div>
    <div style="color: #5A6660; font-size: 13px; margin-top: 4px;">
      ${escapedPhone ? escapedPhone + ' &middot; ' : ''}${formattedTime}
    </div>
  </div>

  <div style="font-size: 15px; line-height: 1.6; color: #1C2422; padding: 8px 0;">
    ${escapedBody}
  </div>

  <div style="border-top: 1px solid #DDE1D9; margin-top: 24px; padding-top: 12px; font-size: 11px; color: #8A928C;">
    ${isSms
      ? `Use Inbound Comms to reply as SMS to ${escapedName}.`
      : `Call back ${escapedName}${escapedPhone ? ' on ' + escapedPhone : ''}.`}
  </div>

  <!-- SMS Bridge Marker -->
  <div data-sms-bridge="true"
       data-ghl-conversation-id="${escapeHtml(conversationId)}"
       data-ghl-phone="${escapedPhone}"
       data-ghl-contact="${escapedName}"
       style="display:none !important; font-size:0; line-height:0; height:0; overflow:hidden;">
    SMS_BRIDGE_ID:${escapeHtml(conversationId)}
  </div>
</body>
</html>`;
}


/* ------------------------------------------------------------------ */
/*  Resend API                                                         */
/* ------------------------------------------------------------------ */

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
      reply_to: email.replyTo,
      headers: email.headers || {},
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${errBody}`);
  }

  return resp.json();
}


/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Secret',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
