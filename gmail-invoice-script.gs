/**
 * Gmail Invoice Sync — Google Apps Script (v3 — Airtable-backed)
 *
 * SETUP:
 *   1. Go to script.google.com → New Project
 *   2. Paste this code
 *   3. IMPORTANT: Enable the Drive Advanced Service:
 *      - In the left sidebar, click the "+" next to "Services"
 *      - Scroll to "Drive API" → click "Add"
 *   4. Set Script Properties (File → Project properties → Script properties):
 *      - AIRTABLE_PAT  = your Airtable Personal Access Token
 *      - AIRTABLE_BASE = appnqjDpqDniH3IRl
 *      - AIRTABLE_TABLE = tblkOTKIG2Tyiy9aM
 *   5. Deploy → New Deployment → Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   6. Copy the URL into dashboard index.html as GMAIL_SCRIPT_URL
 *   7. Set up a time-driven trigger:
 *      - Triggers → Add Trigger → syncGmailToAirtable
 *      - Time-driven → Minutes timer → Every 15 minutes
 *
 * ACTIONS (via query string):
 *   ?action=sync          → Manually trigger Gmail → Airtable sync
 *   ?action=markPaid&threadId=xxx → Move email to "4: paid" label + update Airtable
 *   ?action=count         → Returns { gmailCount: N } for the "3: to pay" label
 *
 * Label lookup is by leading number prefix (3:, 3., or 3 ) so a future
 * rename does not silently break the sync. Falls back to exact name match.
 *   (no action)           → Returns { status: 'ok' }
 */

// ═══════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════

function getConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    pat:   props.getProperty('AIRTABLE_PAT'),
    base:  props.getProperty('AIRTABLE_BASE') || 'appnqjDpqDniH3IRl',
    table: props.getProperty('AIRTABLE_TABLE') || 'tblkOTKIG2Tyiy9aM',
  };
}

// Airtable field IDs
var FIELDS = {
  threadId:      'fld1qMPjybCraA54H',
  payee:         'fldBVAMn9vA1by7MN',
  desc:          'fldT0onwVg9JDJ1sv',
  amount:        'fldauZCUSWeIfGryG',
  emailDate:     'fldEpaivUV4uXW3DP',
  dueDate:       'fldrZ0BrweP0VCVyR',
  ref:           'fldKq7JbfOIxeu1ai',
  hasAttachment: 'fldt8sjSwrfzcfwwJ',
  hasPdf:        'fldSJg8aLjPlD75rz',
  gmailUrl:      'fldeFqA4TVNzDEMCh',
  msgId:         'fldnbLSFMemMuLSzP',
  status:        'fldJ5InUPlY4t7MgP',
  paidDate:      'fld9GqL9RlLWPAymx',
  isEstimate:    'fld4DNJoLG76I4xvz',
};


// ═══════════════════════════════════════════
// Label lookup — robust against rename
// ═══════════════════════════════════════════
//
// Looks up a Gmail label by its leading number prefix (e.g. "3:", "3.",
// or "3 "). Falls back to exact-name match. Means a label rename like
// "3. to pay" → "3: to pay" doesn't break the sync.
function findLabelByNumber(num, fallbackName) {
  if (fallbackName) {
    var byName = GmailApp.getUserLabelByName(fallbackName);
    if (byName) return byName;
  }
  var prefix = String(num);
  var labels = GmailApp.getUserLabels();
  for (var i = 0; i < labels.length; i++) {
    var name = labels[i].getName();
    if (name.indexOf(prefix + ':') === 0 ||
        name.indexOf(prefix + '.') === 0 ||
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

    if (params.action === 'markPaid' && params.threadId) {
      return handleMarkPaid(params.threadId);
    }

    if (params.action === 'count') {
      var label = findLabelByNumber(3, '3: to pay');
      var count = label ? label.getThreads(0, 100).length : 0;
      return jsonResponse({ gmailCount: count });
    }

    if (params.action === 'sync') {
      var result = syncGmailToAirtable();
      return jsonResponse(result);
    }

    return jsonResponse({ status: 'ok', message: 'Gmail Invoice Sync v3' });

  } catch (err) {
    return jsonResponse({ error: String(err) });
  }
}


// ═══════════════════════════════════════════
// Gmail → Airtable Sync
// ═══════════════════════════════════════════

function syncGmailToAirtable() {
  var config = getConfig();
  if (!config.pat) return { error: 'AIRTABLE_PAT not set in Script Properties' };

  var label = findLabelByNumber(3, '3: to pay');
  if (!label) return { error: 'Gmail label starting with "3:" not found', synced: 0 };

  var threads = label.getThreads(0, 50);
  var cache = PropertiesService.getScriptProperties();

  // Fetch existing Airtable records to avoid duplicates
  var existingThreadIds = getExistingThreadIds(config);

  var created = 0;
  var updated = 0;

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var threadId = thread.getId();

    // Parse the email
    var parsed = parseThread(thread, cache);

    if (existingThreadIds[threadId]) {
      // Record exists — only update fields that were originally extracted (not user-edited ones)
      // We update: payee, desc, gmailUrl (in case message ID changed)
      // We do NOT overwrite: amount, dueDate, ref (user may have manually entered these)
      updated++;
      continue; // Skip updates for now — user edits take priority
    }

    // Create new record in Airtable
    var fields = {};
    fields[FIELDS.threadId] = threadId;
    fields[FIELDS.msgId] = parsed.msgId;
    fields[FIELDS.payee] = parsed.payee;
    fields[FIELDS.desc] = parsed.desc;
    if (parsed.amount !== null) fields[FIELDS.amount] = parsed.amount;
    fields[FIELDS.emailDate] = parsed.emailDate;
    if (parsed.dueDate) fields[FIELDS.dueDate] = parsed.dueDate;
    if (parsed.ref) fields[FIELDS.ref] = parsed.ref;
    if (parsed.hasAttachment) fields[FIELDS.hasAttachment] = true;
    if (parsed.hasPdf) fields[FIELDS.hasPdf] = true;
    fields[FIELDS.gmailUrl] = parsed.gmailUrl;
    fields[FIELDS.status] = parsed.isEstimate ? 'Estimate' : 'Unpaid';
    if (parsed.isEstimate) fields[FIELDS.isEstimate] = true;

    createAirtableRecord(config, fields);
    created++;

    // Rate limit: Airtable allows 5 requests/second
    if (created % 4 === 0) Utilities.sleep(1200);
  }

  return { success: true, threadsScanned: threads.length, created: created, skippedExisting: updated };
}


// ═══════════════════════════════════════════
// Parse a Gmail thread into invoice data
// ═══════════════════════════════════════════

function parseThread(thread, cache) {
  var threadId = thread.getId();
  var messages = thread.getMessages();
  var latestMsg = messages[messages.length - 1];
  var latestSubject = latestMsg.getSubject() || '';
  var latestFrom = latestMsg.getFrom() || '';
  var latestDate = latestMsg.getDate();
  var msgId = latestMsg.getId();

  // Combine body text from ALL messages in thread
  var fullBody = '';
  var allSubjects = '';
  for (var mi = 0; mi < messages.length; mi++) {
    var plain = messages[mi].getPlainBody() || '';
    if (!plain || plain.trim().length < 20) {
      var html = messages[mi].getBody() || '';
      plain = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|tr|td|th|li|h[1-6])[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&pound;/gi, '£')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#47;/gi, '/')
        .replace(/&[#\w]+;/gi, ' ')
        .replace(/\s+/g, ' ');
    }
    fullBody += plain + '\n';
    allSubjects += (messages[mi].getSubject() || '') + '\n';
  }

  // Collect all attachments
  var allAttachments = [];
  for (var mi2 = 0; mi2 < messages.length; mi2++) {
    var atts = messages[mi2].getAttachments();
    for (var ai = 0; ai < atts.length; ai++) {
      allAttachments.push(atts[ai]);
    }
  }

  var payee = latestFrom.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
  var amount = extractAmount(fullBody, allSubjects);
  var dueDate = extractDueDate(fullBody);
  var ref = extractRef(fullBody, allSubjects);

  var hasPdf = false;
  var hasImage = false;
  for (var a = 0; a < allAttachments.length; a++) {
    var ct = allAttachments[a].getContentType() || '';
    if (ct === 'application/pdf') hasPdf = true;
    if (ct.indexOf('image/') === 0 && allAttachments[a].getSize() > 5000) hasImage = true;
  }

  // OCR attachments if amount still unknown
  if (amount === null && (hasPdf || hasImage)) {
    var cacheKey = 'ocr_v3_' + threadId;
    var cached = cache.getProperty(cacheKey);

    if (cached) {
      try {
        var ocrData = JSON.parse(cached);
        if (ocrData.amount !== null && ocrData.amount !== undefined) amount = ocrData.amount;
        if (!dueDate && ocrData.dueDate) dueDate = ocrData.dueDate;
        if (!ref && ocrData.ref) ref = ocrData.ref;
      } catch (parseErr) { /* ignore */ }
    } else {
      var ocrText = '';
      for (var a2 = 0; a2 < allAttachments.length && !ocrText; a2++) {
        if (allAttachments[a2].getContentType() === 'application/pdf') {
          try { ocrText = ocrAttachment(allAttachments[a2]); } catch (err) { /* skip */ }
        }
      }
      if (!ocrText || ocrText.length < 10) {
        for (var a3 = 0; a3 < allAttachments.length && (!ocrText || ocrText.length < 10); a3++) {
          var ct3 = allAttachments[a3].getContentType() || '';
          if (ct3.indexOf('image/') === 0 && allAttachments[a3].getSize() > 5000) {
            try { ocrText = ocrAttachment(allAttachments[a3]); } catch (err2) { /* skip */ }
          }
        }
      }

      if (ocrText && ocrText.length > 10) {
        var ocrAmount = extractAmount(ocrText, '');
        var ocrDueDate = extractDueDate(ocrText);
        var ocrRef = extractRef(ocrText, '');

        if (ocrAmount !== null) amount = ocrAmount;
        if (!dueDate && ocrDueDate) dueDate = ocrDueDate;
        if (!ref && ocrRef) ref = ocrRef;

        try {
          cache.setProperty(cacheKey, JSON.stringify({
            amount: ocrAmount, dueDate: ocrDueDate, ref: ocrRef
          }));
        } catch (cacheErr) { /* storage full */ }
      }
    }
  }

  // Detect estimate vs invoice
  var isEstimate = /\b(estimate|quotation|quote)\b/i.test(latestSubject + ' ' + fullBody.substring(0, 500));

  return {
    threadId: threadId,
    msgId: msgId,
    payee: payee,
    desc: latestSubject,
    amount: amount,
    emailDate: fmtDate(latestDate),
    dueDate: dueDate,
    ref: ref,
    hasAttachment: allAttachments.length > 0,
    hasPdf: hasPdf,
    gmailUrl: 'https://mail.google.com/mail/u/0/#all/' + msgId,
    isEstimate: isEstimate,
  };
}


// ═══════════════════════════════════════════
// Airtable API Helpers
// ═══════════════════════════════════════════

function getExistingThreadIds(config) {
  var map = {};
  var offset = null;

  do {
    var url = 'https://api.airtable.com/v0/' + config.base + '/' + config.table +
      '?fields%5B%5D=' + FIELDS.threadId +
      '&returnFieldsByFieldId=true' +
      '&pageSize=100';
    if (offset) url += '&offset=' + offset;

    var resp = UrlFetchApp.fetch(url, {
      headers: { 'Authorization': 'Bearer ' + config.pat },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      Logger.log('Airtable list error: ' + resp.getContentText());
      break;
    }

    var data = JSON.parse(resp.getContentText());
    (data.records || []).forEach(function(r) {
      var tid = r.fields[FIELDS.threadId];
      if (tid) map[tid] = r.id;
    });

    offset = data.offset || null;
  } while (offset);

  return map;
}

function createAirtableRecord(config, fields) {
  var url = 'https://api.airtable.com/v0/' + config.base + '/' + config.table;
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + config.pat,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('Airtable create error: ' + resp.getContentText());
  }
  return resp.getResponseCode() === 200;
}

function updateAirtableRecord(config, recordId, fields) {
  var url = 'https://api.airtable.com/v0/' + config.base + '/' + config.table + '/' + recordId;
  var resp = UrlFetchApp.fetch(url, {
    method: 'patch',
    headers: {
      'Authorization': 'Bearer ' + config.pat,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('Airtable update error: ' + resp.getContentText());
  }
  return resp.getResponseCode() === 200;
}


// ═══════════════════════════════════════════
// Mark as Paid — Gmail label move + Airtable update
// ═══════════════════════════════════════════

function handleMarkPaid(threadId) {
  try {
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) return jsonResponse({ error: 'Thread not found', success: false });

    var toPayLabel = findLabelByNumber(3, '3: to pay');
    var paidLabel  = findLabelByNumber(4, '4: paid');
    if (!toPayLabel || !paidLabel) {
      return jsonResponse({ error: 'Labels not found', success: false });
    }

    thread.removeLabel(toPayLabel);
    thread.addLabel(paidLabel);

    // Clear OCR cache
    try { PropertiesService.getScriptProperties().deleteProperty('ocr_v3_' + threadId); } catch (x) {}

    // Also update Airtable if the record exists
    var config = getConfig();
    if (config.pat) {
      var existing = getExistingThreadIds(config);
      if (existing[threadId]) {
        var fields = {};
        fields[FIELDS.status] = 'Paid';
        fields[FIELDS.paidDate] = fmtDate(new Date());
        updateAirtableRecord(config, existing[threadId], fields);
      }
    }

    return jsonResponse({ success: true, threadId: threadId });
  } catch (e) {
    return jsonResponse({ error: String(e), success: false });
  }
}


// ═══════════════════════════════════════════
// OCR — Extract text from PDF/image via Drive
// ═══════════════════════════════════════════

function ocrAttachment(attachment) {
  var blob = attachment.copyBlob();
  var tempFile = DriveApp.createFile(blob);
  try {
    var resource = { title: 'tmp_invoice_ocr', mimeType: 'application/vnd.google-apps.document' };
    var docFile = Drive.Files.insert(resource, blob, { ocr: true, ocrLanguage: 'en' });
    var doc = DocumentApp.openById(docFile.id);
    var text = doc.getBody().getText();
    DriveApp.getFileById(docFile.id).setTrashed(true);
    return text || '';
  } catch (e) {
    return '';
  } finally {
    try { tempFile.setTrashed(true); } catch (x) {}
  }
}


// ═══════════════════════════════════════════
// Amount extraction
// ═══════════════════════════════════════════

function extractAmount(body, subject) {
  var texts = [body, subject];
  for (var t = 0; t < texts.length; t++) {
    var txt = texts[t] || '';

    var totalPatterns = [
      /(?:Total|Amount due|Balance due|Amount remaining|Amount outstanding|total amount of|Total due|total payable|Amount\s+remaining)\s*[:\s]*£\s*([\d,]+\.?\d*)/i,
      /(?:Balance due|Amount due|Total due)\s*£\s*([\d,]+\.?\d*)/i,
      /£\s*([\d,]+\.\d{2})\s*(?:GBP|due)/i
    ];
    for (var i = 0; i < totalPatterns.length; i++) {
      var m = txt.match(totalPatterns[i]);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }

    var dueAmtMatch = txt.match(/DUE\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*£\s*([\d,]+\.?\d*)/i);
    if (dueAmtMatch) return parseFloat(dueAmtMatch[1].replace(/,/g, ''));
  }

  var bodyText = body || '';
  var allAmounts = [];
  var genericRe = /£\s*([\d,]+\.\d{2})/g;
  var gm;
  while ((gm = genericRe.exec(bodyText)) !== null) {
    allAmounts.push(parseFloat(gm[1].replace(/,/g, '')));
  }
  if (allAmounts.length > 0) return allAmounts[allAmounts.length - 1];

  var subjectMatch = (subject || '').match(/£\s*([\d,]+\.?\d*)/);
  if (subjectMatch) return parseFloat(subjectMatch[1].replace(/,/g, ''));

  return null;
}


// ═══════════════════════════════════════════
// Due date extraction
// ═══════════════════════════════════════════

function extractDueDate(body) {
  if (!body) return null;
  var patterns = [
    /(?:DUE|Due date|Payment due|due by|Due)\s*[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(?:due)\s+(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})/i,
    /(?:due on)\s+(\d{1,2}\s+\w+\s+\d{4})/i,
    /(?:payment\s+(?:is\s+)?(?:due|required))\s+(?:on|by|within\s+\d+\s+days\s+of)\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = body.match(patterns[i]);
    if (m) return parseDateStr(m[1]);
  }
  return null;
}


// ═══════════════════════════════════════════
// Invoice reference extraction
// ═══════════════════════════════════════════

function extractRef(body, subject) {
  var patterns = [
    /(?:Invoice|INVOICE)\s*(?:NO\.?|#|Ref\.?|Reference|number)[:\.\s]+([A-Z0-9][\w\-]{2,20})/i,
    /(INV-\d{3,10})/i,
    /(?:Estimate|ESTIMATE)\s*(?:NO\.?|#)[:\.\s]+(\d{3,10})/i,
    /(?:invoice\s+reference)[:\.\s]+([A-Z0-9][\w\-]{3,20})/i,
    /Invoice\s+(\d{3,10})\s+from/i,
    /#([A-Z0-9][\w\-]{4,20})/
  ];
  var sources = [subject || '', body || ''];
  for (var s = 0; s < sources.length; s++) {
    for (var i = 0; i < patterns.length; i++) {
      var m = sources[s].match(patterns[i]);
      if (m && m[1] && /\d/.test(m[1])) return m[1];
    }
  }
  return null;
}


// ═══════════════════════════════════════════
// Date helpers
// ═══════════════════════════════════════════

function parseDateStr(str) {
  if (!str) return null;
  var slashMatch = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slashMatch) {
    var d = slashMatch[1], m = slashMatch[2], y = slashMatch[3];
    if (y.length === 2) y = '20' + y;
    return y + '-' + pad(m) + '-' + pad(d);
  }
  var months = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',
    jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',
    sep:'09',oct:'10',nov:'11',dec:'12' };
  var wordMatch = str.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (wordMatch) {
    var mon = months[wordMatch[2].toLowerCase()];
    if (mon) return wordMatch[3] + '-' + mon + '-' + pad(wordMatch[1]);
  }
  return null;
}

function fmtDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function pad(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
