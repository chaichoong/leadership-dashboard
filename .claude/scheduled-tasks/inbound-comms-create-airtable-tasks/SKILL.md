---
name: inbound-comms-create-airtable-tasks
description: Check Gmail "8: Task created" label and auto-create Airtable tasks for new emails
---

You are an automation agent that checks Gmail for emails labelled "8: task created" and creates corresponding tasks in Airtable.

## Step 1: Search Gmail for emails in "8: task created" label
Use gmail_search_messages with query: label:8:-task-created
This is the CORRECT format - keep the colon, replace spaces with hyphens.
If no results, the label may be empty - exit gracefully.

## Step 2: For each email thread found, read the most recent message
Use gmail_read_message with the messageId to get the full email content including subject, sender, date, and body.

## Step 3: Check if an Airtable task already exists for this email
Use list_records_for_table to search:
- baseId: appnqjDpqDniH3IRl
- tableId: tblqB8b22hKBL4PF1
- fieldIds: ["fldXf1p0vtHqOZcKl", "fldgFjGBw6bTKJFCD"]
- Filter on field fldXf1p0vtHqOZcKl (Inbound Note URL Link) containing the Gmail thread/message URL

The Gmail URL format is: https://mail.google.com/mail/u/0/#inbox/{threadId}

If a task already exists for this email thread, skip it.

## Step 4: Create Airtable task for new emails
Use create_records_for_table with:
- baseId: appnqjDpqDniH3IRl
- tableId: tblqB8b22hKBL4PF1
- records: one record per email thread with these fields:
  - fldgFjGBw6bTKJFCD (Task Name): Generate a concise task title from the email subject and content. Format: "INBOUND: [concise action item from email]". Keep under 100 chars.
  - fldx4qCw17UfrKpaN (Status): "Today"
  - fldELMncVJYPDRJNc (Assignee): "usrP7K5pmPSdVVgTN" (Mica Albovias)
  - fldS21RwmwOqt71LI (Priority): "Urgent"
  - fld10VzzbiNNgRmIi (Time Estimate): "15 min"
  - fldRGhBQViKZKtkQ6 (Description): AI-generated description of what needs to be done based on the email content. Include key details, any deadlines mentioned, and required actions. Keep professional and actionable.
  - fldueazD67F7fUGee (Inbound Communication Task): true
  - fldiXSzcMol6Tdwij (Inbound Source Type): "Gmail"
  - fldiSNijdCy5GXuzL (Inbound Message Content): The email body text (truncated to 5000 chars if needed)
  - fldzf4xlbrQuktx0i (Inbound Sender): The sender's email address
  - fldR4peEZRXo7tjoI (Inbound Date Received): The email date in YYYY-MM-DD format
  - fldXf1p0vtHqOZcKl (Inbound Note URL Link): https://mail.google.com/mail/u/0/#inbox/{threadId}
  - fld7XP8w8kbxfETV4 (Due Date): Set to TODAY's date (YYYY-MM-DD format). The due date should always be today so it aligns with the "Today" status.

IMPORTANT: When generating the task title and description, do NOT use em dashes (—) or en dashes (–). Use commas, full stops, or restructure sentences instead.

## Error handling
- If Gmail returns no results, exit silently (this is normal when no emails are in the label)
- If Airtable creation fails, log the error but continue processing remaining emails
- Process a maximum of 10 emails per run to avoid timeouts