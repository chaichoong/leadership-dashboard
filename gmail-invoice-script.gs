/**
 * Gmail Invoice Parser — Google Apps Script (v2)
 *
 * SETUP:
 *   1. Go to script.google.com → New Project
 *   2. Paste this code
 *   3. IMPORTANT: Enable the Drive Advanced Service:
 *      - In the left sidebar, click the "+" next to "Services"
 *      - Scroll to "Drive API" → click "Add"
 *   4. Deploy → New Deployment → Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   5. Copy the URL into dashboard.html as GMAIL_SCRIPT_URL
 *
 * FEATURES:
 *   - Reads Gmail "3. to pay" label
 *   - Extracts invoice data from email body + subject across all thread messages
 *   - OCR reads PDF/image attachments when amount not found in text
 *   - Caches OCR results so repeat requests are fast
 *   - ?action=markPaid&threadId=xxx  →  moves email to "4: paid" label
 */

function doGet(e) {
  try {
    var params = e ? (e.parameter || {}) : {};

    // ── Action: Mark as Paid ──
    if (params.action === 'markPaid' && params.threadId) {
      return handleMarkPaid(params.threadId);
    }

    // ── Default: Return invoice list ──
    var label = GmailApp.getUserLabelByName('3. to pay');
    if (!label) {
      return jsonResponse({ error: 'Label "3. to pay" not found', invoices: [] });
    }

    var threads = label.getThreads(0, 50);
    var seen = {};
    var invoices = [];
    var cache = PropertiesService.getScriptProperties();

    for (var t = 0; t < threads.length; t++) {
      var thread = threads[t];
      var threadId = thread.getId();
      if (seen[threadId]) continue;
      seen[threadId] = true;

      var messages = thread.getMessages();
      var latestMsg = messages[messages.length - 1];
      var latestSubject = latestMsg.getSubject() || '';
      var latestFrom = latestMsg.getFrom() || '';
      var latestDate = latestMsg.getDate();
      var msgId = latestMsg.getId();

      // Combine body text from ALL messages in thread
      // CRITICAL: try getPlainBody() first, fall back to getBody() (HTML) with tags stripped
      var fullBody = '';
      var allSubjects = '';
      for (var mi = 0; mi < messages.length; mi++) {
        var plain = messages[mi].getPlainBody() || '';
        if (!plain || plain.trim().length < 20) {
          // HTML-only email (QuickBooks, Xero, Stripe, etc.) — strip HTML tags
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

      // Collect all attachments across the thread
      var allAttachments = [];
      for (var mi2 = 0; mi2 < messages.length; mi2++) {
        var atts = messages[mi2].getAttachments();
        for (var ai = 0; ai < atts.length; ai++) {
          allAttachments.push(atts[ai]);
        }
      }

      // --- Extract payee ---
      var payee = latestFrom.replace(/<[^>]+>/, '').replace(/"/g, '').trim();

      // --- Extract from body + subject ---
      var amount = extractAmount(fullBody, allSubjects);
      var dueDate = extractDueDate(fullBody);
      var ref = extractRef(fullBody, allSubjects);

      // --- Check attachment types ---
      var hasPdf = false;
      var hasImage = false;
      for (var a = 0; a < allAttachments.length; a++) {
        var ct = allAttachments[a].getContentType() || '';
        if (ct === 'application/pdf') hasPdf = true;
        if (ct.indexOf('image/') === 0 && allAttachments[a].getSize() > 5000) hasImage = true;
      }

      // --- OCR attachments if amount still unknown ---
      if (amount === null && (hasPdf || hasImage)) {
        var cacheKey = 'ocr_v3_' + threadId;
        var cached = cache.getProperty(cacheKey);

        if (cached) {
          try {
            var ocrData = JSON.parse(cached);
            if (ocrData.amount !== null && ocrData.amount !== undefined) amount = ocrData.amount;
            if (!dueDate && ocrData.dueDate) dueDate = ocrData.dueDate;
            if (!ref && ocrData.ref) ref = ocrData.ref;
          } catch (parseErr) { /* ignore bad cache */ }
        } else {
          // OCR the first suitable attachment (PDF first, then images)
          var ocrText = '';
          // Try PDFs first
          for (var a2 = 0; a2 < allAttachments.length && !ocrText; a2++) {
            if (allAttachments[a2].getContentType() === 'application/pdf') {
              try { ocrText = ocrAttachment(allAttachments[a2]); } catch (err) { /* skip */ }
            }
          }
          // Then try images if no PDF text found
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

            // Cache for future requests
            try {
              cache.setProperty(cacheKey, JSON.stringify({
                amount: ocrAmount, dueDate: ocrDueDate, ref: ocrRef
              }));
            } catch (cacheErr) { /* storage full, ignore */ }
          }
        }
      }

      invoices.push({
        id: msgId,
        threadId: threadId,
        payee: payee,
        desc: latestSubject,
        amount: amount,
        emailDate: fmtDate(latestDate),
        dueDate: dueDate,
        ref: ref,
        hasAttachment: allAttachments.length > 0,
        hasPdf: hasPdf,
        gmailUrl: 'https://mail.google.com/mail/u/0/#all/' + msgId
      });
    }

    return jsonResponse({
      invoices: invoices,
      refreshedAt: new Date().toISOString(),
      count: invoices.length
    });

  } catch (e) {
    return jsonResponse({ error: String(e), invoices: [] });
  }
}


// ═══════════════════════════════════════════
// OCR — Extract text from PDF/image via Drive
// ═══════════════════════════════════════════

function ocrAttachment(attachment) {
  var blob = attachment.copyBlob();
  var tempFile = DriveApp.createFile(blob);
  try {
    // Drive Advanced Service: insert as Google Doc with OCR enabled
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
// Mark as Paid — move to "4: paid" label
// ═══════════════════════════════════════════

function handleMarkPaid(threadId) {
  try {
    var thread = GmailApp.getThreadById(threadId);
    if (!thread) return jsonResponse({ error: 'Thread not found', success: false });

    var toPayLabel = GmailApp.getUserLabelByName('3. to pay');
    var paidLabel  = GmailApp.getUserLabelByName('4: paid');
    if (!toPayLabel || !paidLabel) {
      return jsonResponse({ error: 'Labels not found', success: false });
    }

    thread.removeLabel(toPayLabel);
    thread.addLabel(paidLabel);

    // Clear OCR cache for this thread
    try { PropertiesService.getScriptProperties().deleteProperty('ocr_v3_' + threadId); } catch (x) {}

    return jsonResponse({ success: true, threadId: threadId });
  } catch (e) {
    return jsonResponse({ error: String(e), success: false });
  }
}


// ═══════════════════════════════════════════
// Amount extraction
// ═══════════════════════════════════════════

function extractAmount(body, subject) {
  // Combined text: body first, then subjects
  var texts = [body, subject];
  for (var t = 0; t < texts.length; t++) {
    var txt = texts[t] || '';

    // 1. Explicit total/due patterns
    var totalPatterns = [
      /(?:Total|Amount due|Balance due|Amount remaining|Amount outstanding|total amount of|Total due|total payable|Amount\s+remaining)\s*[:\s]*£\s*([\d,]+\.?\d*)/i,
      /(?:Balance due|Amount due|Total due)\s*£\s*([\d,]+\.?\d*)/i,
      /£\s*([\d,]+\.\d{2})\s*(?:GBP|due)/i
    ];
    for (var i = 0; i < totalPatterns.length; i++) {
      var m = txt.match(totalPatterns[i]);
      if (m) return parseFloat(m[1].replace(/,/g, ''));
    }

    // 2. DUE DD/MM/YYYY £amount pattern (QuickBooks style)
    var dueAmtMatch = txt.match(/DUE\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*£\s*([\d,]+\.?\d*)/i);
    if (dueAmtMatch) return parseFloat(dueAmtMatch[1].replace(/,/g, ''));
  }

  // 3. Generic £amount pattern from body — take the LAST match
  //    (the last £ figure is more likely the total/balance than the first line item)
  var bodyText = body || '';
  var allAmounts = [];
  var genericRe = /£\s*([\d,]+\.\d{2})/g;
  var gm;
  while ((gm = genericRe.exec(bodyText)) !== null) {
    allAmounts.push(parseFloat(gm[1].replace(/,/g, '')));
  }
  if (allAmounts.length > 0) return allAmounts[allAmounts.length - 1];

  // 4. Subject line £amount
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
// Invoice reference extraction (strict)
// Only matches refs that contain at least one digit
// ═══════════════════════════════════════════

function extractRef(body, subject) {
  var patterns = [
    // Explicit labelled refs: "Invoice No. 41496", "Invoice #ONYX888-0219"
    /(?:Invoice|INVOICE)\s*(?:NO\.?|#|Ref\.?|Reference|number)[:\.\s]+([A-Z0-9][\w\-]{2,20})/i,
    // INV-nnnn pattern (Xero etc)
    /(INV-\d{3,10})/i,
    // Estimate No.: 1724
    /(?:Estimate|ESTIMATE)\s*(?:NO\.?|#)[:\.\s]+(\d{3,10})/i,
    // "invoice reference PRS049387"
    /(?:invoice\s+reference)[:\.\s]+([A-Z0-9][\w\-]{3,20})/i,
    // "Invoice 41496 from" (subject line pattern)
    /Invoice\s+(\d{3,10})\s+from/i,
    // "#ONYX888-0219" style
    /#([A-Z0-9][\w\-]{4,20})/
  ];
  var sources = [subject || '', body || '']; // check subject first for cleaner refs
  for (var s = 0; s < sources.length; s++) {
    for (var i = 0; i < patterns.length; i++) {
      var m = sources[s].match(patterns[i]);
      if (m && m[1] && /\d/.test(m[1])) return m[1]; // must contain at least one digit
    }
  }
  return null;
}


// ═══════════════════════════════════════════
// Date helpers
// ═══════════════════════════════════════════

function parseDateStr(str) {
  if (!str) return null;
  // DD/MM/YYYY or DD-MM-YYYY
  var slashMatch = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slashMatch) {
    var d = slashMatch[1], m = slashMatch[2], y = slashMatch[3];
    if (y.length === 2) y = '20' + y;
    return y + '-' + pad(m) + '-' + pad(d);
  }
  // DD Month YYYY
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
