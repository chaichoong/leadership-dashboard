# Apple Inbound Worker

Cloudflare Worker that receives webhook POSTs from Apple Shortcuts and creates Airtable task / inbound comms records. Replaces Make scenarios M1 (voice task) and M8 (voice forward), plus adds text forwarding.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /voice-task | Apple Watch voice dictation > Airtable task |
| POST | /text-forward | Forwarded text (SMS, WhatsApp, etc.) > inbound comms |
| POST | /voice-forward | Voice message audio file > R2 + inbound comms |
| GET | /files/{key} | Serve uploaded audio from R2 |
| GET | /health | Health check |

## Deployment

```bash
cd workers/apple-inbound

# First time: create R2 bucket
wrangler r2 bucket create apple-inbound-attachments

# Set secrets
wrangler secret put AIRTABLE_PAT
wrangler secret put BEARER_TOKEN
wrangler secret put SLACK_BOT_TOKEN

# Deploy
wrangler deploy
```

The BEARER_TOKEN is a shared secret you generate (any random string 32+ chars). You will enter this same token in each Apple Shortcut.

After deploying, note the worker URL (e.g. https://apple-inbound.kevin-runpreneur.workers.dev). You need this for the Apple Shortcuts.

## Apple Shortcuts Setup

### Shortcut 1: "Add Task" (Apple Watch + iPhone)

This replaces the Make voice-task automation (M1).

1. Open Shortcuts app on iPhone
2. Create new shortcut called "Add Task"
3. Add actions:
   - "Dictate Text" (or "Ask for Input" with voice)
   - "Get Contents of URL":
     - URL: https://YOUR-WORKER.workers.dev/voice-task
     - Method: POST
     - Headers: Authorization = Bearer YOUR_BEARER_TOKEN
     - Request Body: JSON
       - task_name: (Dictated Text variable)
   - "Show Notification": Task created!
4. Enable "Show on Apple Watch"

### Shortcut 2: "Forward to Inbound" (iPhone share sheet)

This is the new text-forwarding capability.

1. Create new shortcut called "Forward to Inbound"
2. Set "Show in Share Sheet" for Text input types
3. Add actions:
   - "Get Contents of URL":
     - URL: https://YOUR-WORKER.workers.dev/text-forward
     - Method: POST
     - Headers: Authorization = Bearer YOUR_BEARER_TOKEN
     - Request Body: JSON
       - text: (Shortcut Input variable)
       - sender: (Ask Each Time, or hardcode)
   - "Show Notification": Forwarded to inbound comms!

Usage: select text in any app > Share > "Forward to Inbound"

### Shortcut 3: "Forward Voice Message" (iPhone share sheet)

This replaces the Make voice-forward automation (M8).

1. Create new shortcut called "Forward Voice Message"
2. Set "Show in Share Sheet" for Audio/Files input types
3. Add actions:
   - "Ask for Input" (text): Who is this from?
   - "Get Contents of URL":
     - URL: https://YOUR-WORKER.workers.dev/voice-forward
     - Method: POST
     - Headers: Authorization = Bearer YOUR_BEARER_TOKEN
     - Request Body: Form
       - audio: (Shortcut Input - the audio file)
       - sender: (Asked Input variable)
   - "Show Notification": Voice message forwarded!

Usage: long-press voice message in WhatsApp/Messages > Share > "Forward Voice Message"
