/**
 * Google Calendar Proxy for Task Manager OS
 *
 * SETUP:
 * 1. Go to https://script.google.com and create a new project
 * 2. Paste this entire file into Code.gs
 * 3. Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone (or Anyone with the link)
 * 4. Authorize when prompted (allows script to read your calendar)
 * 5. Copy the Web app URL and paste it into GCAL_SCRIPT_URL in
 *    os/tasks/index.html
 *
 * The script returns today's calendar events as JSON.
 * It only reads events — it never creates, modifies, or deletes anything.
 */

function doGet(e) {
  try {
    var dateParam = e && e.parameter && e.parameter.date;
    var targetDate = dateParam ? new Date(dateParam + 'T00:00:00') : new Date();

    // Set to start and end of the target day
    var dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);

    var dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    var calendar = CalendarApp.getDefaultCalendar();
    var events = calendar.getEvents(dayStart, dayEnd);

    var result = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var isAllDay = ev.isAllDayEvent();

      result.push({
        summary: ev.getTitle(),
        start: isAllDay ? formatDate(ev.getAllDayStartDate()) : formatDateTime(ev.getStartTime()),
        end: isAllDay ? formatDate(ev.getAllDayEndDate()) : formatDateTime(ev.getEndTime()),
        location: ev.getLocation() || '',
        description: (ev.getDescription() || '').substring(0, 200),
        allDay: isAllDay,
        status: ev.getMyStatus ? ev.getMyStatus().toString() : '',
      });
    }

    var output = JSON.stringify({ events: result, date: formatDate(targetDate), count: result.length });
    return ContentService.createTextOutput(output)
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    var errorOutput = JSON.stringify({ error: err.message, events: [] });
    return ContentService.createTextOutput(errorOutput)
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function formatDateTime(date) {
  var h = date.getHours().toString().padStart(2, '0');
  var m = date.getMinutes().toString().padStart(2, '0');
  return h + ':' + m;
}

function formatDate(date) {
  var y = date.getFullYear();
  var m = (date.getMonth() + 1).toString().padStart(2, '0');
  var d = date.getDate().toString().padStart(2, '0');
  return y + '-' + m + '-' + d;
}

// Test function — run this in the script editor to verify it works
function testDoGet() {
  var result = doGet({ parameter: { date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') } });
  Logger.log(result.getContent());
}
