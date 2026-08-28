// ══════════════════════════════════════════════════════════════════════
// AUTOMATIONS DATA — the fixed-rule jobs that are NOT AI agents
// ══════════════════════════════════════════════════════════════════════
// Created 27 Aug 2026 by the estate audit.
//
// WHY THIS FILE EXISTS. Austin Chen's Agent Assignment Matrix splits work in
// two: judgement work goes to an agent, deterministic if/then goes to what he
// calls "simple automation". An agent doing an if/then is over-engineering, so
// these deliberately do NOT get rows in the AI Agents register — putting them
// through the AGENTIC stages would be dressing a conditional up as a colleague.
// They are listed here, on the same page, because Kevin's rule is that nothing
// is hidden: the more we build, the easier it is to forget what an older job
// does, and you cannot safely retire what you cannot describe.
//
// THE TEST FOR THIS LIST: no AI model is called anywhere in the job. Every
// entry below was checked by reading its source. If a job starts calling a
// model, it stops being an automation and needs a register row instead.
//
// KEEPING IT HONEST: `tests/automations-coverage.test.js` fails whenever
// scripts/job-schedule.json holds a job that is missing from MAC_JOBS below,
// so a new scheduled job cannot quietly go unlisted. The Cloudflare and
// Airtable groups have no machine-readable source available to the browser,
// so those are maintained by hand — add to them in the same commit that adds
// the worker or automation.

var AUTOMATIONS = {

    // ── Scheduled jobs on Kevin's Mac (launchd) ───────────────────────
    // `key` must match the key in scripts/job-schedule.json.
    macJobs: [
        { key: 'mcp-inventory', name: 'Tools & Connections List', when: '6:10am daily', status: 'on',
          what: 'Rebuilds the list of every outside system the AI is plugged into, on the AI Agents page. Reads the real settings rather than a list someone remembered to update, and refuses to write a shorter list if it cannot read one of its sources properly.' },
        { key: 'drift-scan', name: 'Drift Scan', when: '6:20am daily', status: 'on',
          what: 'Reads the code looking for references to things that no longer exist: a field that was renamed, a file that was deleted, a page that was retired. It reports them so a broken link is found before it breaks something.' },
        { key: 'data-invariants', name: 'Data Invariants Check', when: '6:40am daily', status: 'on',
          what: 'Checks the real Airtable data still obeys the rules it is supposed to. Each check has a control, so if the check itself breaks it fails loudly instead of quietly passing. This is the check that would have caught the 8,667 blanked transactions.' },
        { key: 'drive-auth', name: 'Drive Login Check', when: '6:50am daily', status: 'on',
          what: 'Checks the Google Drive login has not expired. The brain lives in Drive, so an expired login silently stops several other jobs. This catches it in the morning rather than a week later.' },
        { key: 'project-status-sync', name: 'Project Status Sync', when: '6:45am daily', status: 'on',
          what: 'Copies project status between the repo and Airtable so both show the same thing.' },
        { key: 'masterplan-sync', name: 'Master Plan Sync', when: '7:00am daily', status: 'on',
          what: 'Pushes MASTER-PLAN.md into Airtable so the team works from the same plan you do.' },
        { key: 'knowledge-os-sort', name: 'Knowledge Sorter', when: '9:00am daily', status: 'on',
          what: 'Files new brain documents into the right folder using the naming rules. It moves files, it does not read or judge them.' },
        { key: 'publish-brain', name: 'Brain Publisher', when: '11:20pm daily', status: 'on',
          what: 'Publishes the brain to the private feed the web app reads, so the Today tab shows current information.' },
        { key: 'apple-notes-bridge', name: 'Apple Notes Bridge', when: '10:40pm daily', status: 'on',
          what: 'Pulls anything you wrote in Apple Notes into the brain so notes made on your phone are not stranded there.' },
        { key: 'audiobook-morning-report', name: 'Audiobook Morning Report', when: '8:00am daily', status: 'on',
          what: 'Reports what the Audiobook Processor got through overnight: books transcribed, books turned into brain documents, anything that failed. It only reports. The Audiobook Processor agent does the thinking.' },
        { key: 'job-digest', name: 'Job Digest', when: '11:00am daily', status: 'on',
          what: 'One summary of every scheduled job and whether it ran, was skipped, or failed. This is how a job that quietly stopped gets noticed.' },
        { key: 'daily-ops-guard', name: 'Daily Sweep Guard', when: '9:30am daily', status: 'on',
          what: 'Proves the 7am Daily Sweep actually ran. A routine cannot be trusted to report its own absence, so something outside it has to check.' },
        { key: 'retry-deferred', name: 'Retry Deferred Jobs', when: 'every hour', status: 'on',
          what: 'Re-runs a scheduled job that was turned away earlier because the Mac was not ready, once the thing that blocked it has cleared. Your Mac only tries each job once, at its set time, so a job that could not run because Google Drive was asleep used to just lose the day. That is how the brain went four days without being fed in August 2026. It only re-runs jobs that have been signed up for it, and it says out loud when a job lost the day anyway.' },
        { key: 'mac-guard', name: 'Mac Guard', when: 'every hour', status: 'on',
          what: 'Kills leftover preview servers that outlived the session that started them. They hold ports forever otherwise. It only touches servers over 4 hours old with nothing connected.' },
        { key: 'uc-notifier-watchdog', name: 'UC Notifier Watchdog', when: '9:00am daily', status: 'off',
          what: 'Proved the Universal Credit list was actually sent, after it failed silently twice. TURNED OFF on 27 Aug 2026 with the UC Verification agent it was watching, because there is now nothing to watch.' },
        { key: 'handback-poll', agent: true, name: 'Hand-back Poll', when: 'every 30 minutes', status: 'on',
          what: 'Runs the hand-back check for the Agent Dispatch agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'daily-ops', agent: true, name: 'Daily Sweep', when: '7:00am daily', status: 'on',
          what: 'Runs the Daily Sweep agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'inbound-triage', agent: true, name: 'Inbound Comms Triage', when: '9am, 1pm, 5pm', status: 'on',
          what: 'Runs the Inbound Comms Triage agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'task-manager', agent: true, name: 'Task Manager', when: '9am, 1pm, 5pm', status: 'on',
          what: 'Runs the Task Manager agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'ceo-agent', agent: true, name: 'CEO Brief', when: '6:45am daily', status: 'on',
          what: 'Runs the CEO Brief agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'prospecting', agent: true, name: 'Prospecting', when: '9:15am daily', status: 'on',
          what: 'Runs the Prospecting agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'prod-sweep-weekly', agent: true, name: 'Production Sweep', when: 'Sundays 11:00am', status: 'on',
          what: 'Runs the Production Sweep agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'uc-check', agent: true, name: 'UC Verification', when: '8:00am daily', status: 'off',
          what: 'Runs the UC Verification agent, which has its own register row above. TURNED OFF on 27 Aug 2026, so it no longer runs at all.' },
        { key: 'audiobook-backfill', agent: true, name: 'Audiobook Processor', when: 'midnight daily', status: 'on',
          what: 'Runs the Audiobook Processor agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'feed-brain', agent: true, name: 'Brain Feeder', when: '10:45pm daily', status: 'on',
          what: 'Runs the Brain Feeder agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
        { key: 'compound-brain', agent: true, name: 'Brain Compounder', when: '11:00pm daily', status: 'on',
          what: 'Runs the Brain Compounder agent, which has its own register row above. Listed here so every scheduled job is accounted for.' },
    ],

    // Scheduled outside job-schedule.json, so the coverage test does not see it.
    otherMacJobs: [
        { key: 'ebay-arb', name: 'eBay Price Sweep', when: '7:30am daily', status: 'on',
          what: 'Sweeps eBay golf listings for items selling for less than they are worth, and logs what it finds. It is pure arithmetic on prices. Nothing here reads a listing or decides anything, which is why it is an automation and not an agent, despite being called an engine.' },
    ],

    // ── Cloudflare Workers ────────────────────────────────────────────
    workers: [
        { name: 'claude-proxy', when: 'on request', status: 'on',
          what: 'Passes AI requests from the web app through to Anthropic, so the API key stays on the server and never reaches the browser.' },
        { name: 'anthropic-proxy', when: 'on request', status: 'on',
          what: 'An older version of claude-proxy, still deployed. Worth checking whether anything still calls it before deleting.' },
        { name: 'slack-notify', when: 'on request', status: 'on',
          what: 'Sends Slack messages on behalf of the web app. It is a postbox: it writes nothing itself.' },
        { name: 'drive-upload', when: 'on request', status: 'on',
          what: 'Uploads files to Google Drive, and is also the transport that sends approved emails as you. It only sends what a script hands it, and only from an address you have connected.' },
        { name: 'apple-inbound', when: 'on request', status: 'on',
          what: 'Takes iMessages into the system so they can become tasks. NOTE: one reference to the Anthropic API was found in the deployed code and its source is not in this repo, so whether it uses AI is UNCONFIRMED. Worth a look before trusting this classification.' },
        { name: 'sms-email-bridge', when: 'every minute', status: 'on',
          what: 'Turns incoming text messages into emails so they land in the inbox with everything else.' },
        { name: 'prospect-reply-watch', when: 'every 2 minutes', status: 'on',
          what: 'Watches for replies from prospects and flags them. It spots that a reply arrived. It does not read it, because there is no AI in it at all.' },
        { name: 'agent-runner', when: 'on request', status: 'on',
          what: 'Runs an agent job when something asks it to. It is the plumbing that starts a run, not the thing that does the work.' },
        { name: 'skill-runner', when: 'on request', status: 'on',
          what: 'Runs a skill when something asks it to. Same as agent-runner, for skills.' },
        { name: 'ghl-sms-proxy', when: 'on request', status: 'on',
          what: 'Passes text messages to and from GoHighLevel.' },
        { name: 'content-machine-proxy', when: 'on request', status: 'on',
          what: 'Connects the separate Content Machine project to this one.' },
        { name: 'od-billing-bridge', when: 'on request', status: 'on',
          what: 'Handles billing messages for Operations Director client payments.' },
        { name: 'onboarding-form', when: 'on request', status: 'on',
          what: 'Serves the form a new client fills in when they sign up, and files their answers.' },
        { name: 'loom-transcript', when: 'on request', status: 'on',
          what: 'Fetches the transcript of a Loom video when something needs it.' },
        { name: 'fpl-relay', when: 'on request', status: 'on',
          what: 'Belongs to Fantasy Football Meta, a separate product bet. Nothing in Operations Director depends on it.' },
        { name: 'money-confidence-daily', agent: true, when: '8-11am daily', status: 'on',
          what: 'Sends the CEO Brief agent\'s 9am Slack message. The agent has its own register row above; this worker is the delivery half. Listed here so every deployed worker on a schedule is accounted for.' },
        { name: 'contractor-bot', agent: true, when: 'every minute', status: 'on',
          what: 'Two jobs share one worker. The every-minute timer runs ONLY the approval loop: it posts anything waiting for your approval into Slack, reads your emoji back, and closes threads for anything you decided in the dashboard. The contractor chat is the AI half and runs off the Slack webhook, not this timer. Do not remove this cron to stop the contractor bot — it stops your approvals instead. See the Contractor Bot register row.' },
    ],

    // ── Airtable automations ──────────────────────────────────────────
    // 50 exist. 34 are deployed (live), 16 are undeployed (built but switched
    // off). Exactly ONE calls an AI model — "Auto Generate SOP AI Fields" —
    // and that one has a register row instead. Descriptions below come from
    // each automation's TRIGGER and action nodes, which were read directly.
    // Where a script body was not read, the entry says what the script is
    // called rather than guessing what it does.
    airtable: [
        { name: 'Cashflow Monthly Report, BMS and TMS Generator', when: 'daily', status: 'on', group: 'Money',
          what: 'Builds the monthly money records: the cashflow report, and the business and tenancy monthly summaries. Five scripts in a row.' },
        { name: 'Cashflow Forecast Automation', when: 'daily', status: 'on', group: 'Money',
          what: 'Recalculates money in and money out for the cash flow forecast.' },
        { name: 'Rolling 12 P&L', when: '1st of the month', status: 'on', group: 'Money',
          what: 'Creates the profit and loss record for the new month so the rolling 12-month view stays complete.' },
        { name: 'Split Transactions', when: 'when a transaction is split', status: 'on', group: 'Money',
          what: 'When you split one bank transaction across several categories, this creates the separate parts.' },
        { name: 'Tenancy Payments', when: 'on a matching rent payment', status: 'on', group: 'Money',
          what: 'Marks rent as received against the right tenancy when a matching payment lands.' },
        { name: 'Link Business Record to Transaction', when: 'on transaction change', status: 'on', group: 'Money',
          what: 'Attaches the right business to a transaction so reports split correctly.' },
        { name: 'Transaction to BMS Table Linking', when: 'on transaction change', status: 'on', group: 'Money',
          what: 'Links a transaction to the business monthly summary it belongs to.' },
        { name: 'Transaction to TMS Table Linking', when: 'on transaction change', status: 'on', group: 'Money',
          what: 'Links a transaction to the tenancy monthly summary it belongs to.' },
        { name: 'Transaction to SAS Table Linking', when: 'on transaction change', status: 'on', group: 'Money',
          what: 'Links a transaction to the statement summary it belongs to.' },
        { name: 'Link BMS Table to Personal Cashflow Statement', when: '1st of the month', status: 'on', group: 'Money',
          what: 'Joins the business monthly summaries to your personal cashflow statement, and starts the month for the maintenance KPI.' },
        { name: 'Finance Workflow Add record to Rental Unit Maintenance KPI', when: 'on a maintenance cost', status: 'on', group: 'Property',
          what: 'Records a maintenance cost against the right rental unit so the maintenance KPI is accurate.' },
        { name: 'New Tenancy to Rental Unit Metrics', when: 'on new tenancy', status: 'on', group: 'Property',
          what: 'Adds a new tenancy into the rental unit metrics so occupancy and rent figures update.' },
        { name: 'Tenant and Tenancy linked, mark Unit Occupied or Void', when: 'on tenancy change', status: 'on', group: 'Property',
          what: 'Flips a rental unit to Occupied when a tenant is linked, and back to Void when they are not.' },
        { name: 'When task is assigned, send Slack alert', when: 'on assignee change', status: 'on', group: 'Tasks',
          what: 'Tells someone in Slack that a task has been given to them.' },
        { name: 'When Task is Completed, notify collaborators', when: 'on completion', status: 'on', group: 'Tasks',
          what: 'Tells everyone attached to a task that it is done.' },
        { name: 'When Task is Completed by assignee, alert everyone else', when: 'on completion', status: 'on', group: 'Tasks',
          what: 'Same as above but skips the person who completed it, so nobody is told their own news.' },
        { name: 'Track Previous Assignee', when: 'on assignee change', status: 'on', group: 'Tasks',
          what: 'Remembers who had a task before it was reassigned.' },
        { name: 'Task created under Project Tasks Dashboard, set Priority to Project', when: 'on task create', status: 'on', group: 'Tasks',
          what: 'Marks a task as project work so it does not compete with today’s list.' },
        { name: 'New project task gets business and department', when: 'on task create', status: 'on', group: 'Tasks',
          what: 'Fills in the business and department on a new project task from the project it belongs to.' },
        { name: 'Task linked to a Project, add collaborators', when: 'on project link', status: 'on', group: 'Tasks',
          what: 'Adds the project’s people to a task when it joins that project.' },
        { name: 'Someday task assigned, clear the Someday flag', when: 'on assignee change', status: 'on', group: 'Tasks',
          what: 'If you assign a someday task to someone, it stops being someday.' },
        { name: 'Someday ticked, clear the date fields', when: 'on Someday tick', status: 'on', group: 'Tasks',
          what: 'Clears the dates off a task you have pushed to someday, so it stops showing as due.' },
        { name: 'New task, set the original due date after 15 mins', when: 'every 15 minutes', status: 'on', group: 'Tasks',
          what: 'Stamps the first due date a task was given, 15 minutes after it is created, so later changes can be measured against it.' },
        { name: 'Update Due Date, Strategy Project Planning', when: 'on date change', status: 'on', group: 'Tasks',
          what: 'Keeps strategy project dates in step when one moves.' },
        { name: 'Time from Time Estimate sync', when: 'on estimate change', status: 'on', group: 'Tasks',
          what: 'Copies the time estimate into the time field so workload adds up.' },
        { name: 'Inbound Comms: remove approval when task is assigned', when: 'on assignee change', status: 'on', group: 'Tasks',
          what: 'Takes an inbound item out of the approval queue once a person has picked it up.' },
        { name: 'SOP Task Creation', when: 'on SOP needing a video', status: 'on', group: 'Processes',
          what: 'Creates the task to record a Loom when an SOP needs one.' },
        { name: 'SOP For Approval', when: 'on SOP status change', status: 'on', group: 'Processes',
          what: 'Posts to Slack when an SOP is ready for you to approve.' },
        { name: 'Needs Updating SOP Process', when: 'on SOP flagged', status: 'on', group: 'Processes',
          what: 'Marks an SOP as needing an update and raises the task to do it.' },
        { name: 'Untick SOP Required When Loom Is Added', when: 'on video added', status: 'on', group: 'Processes',
          what: 'Clears the "needs a video" flag once the video exists.' },
        { name: 'Create New SOP then link it', when: 'on task change', status: 'on', group: 'Processes',
          what: 'Creates a new SOP record from a task and links the two together.' },
        { name: 'Objective Plan Form Add Task', when: 'on form submit', status: 'on', group: 'Strategy',
          what: 'Turns an objective plan form submission into a task.' },
        { name: 'OD Payment, Onboarding Customer Journey', when: 'on payment webhook', status: 'on', group: 'Clients',
          what: 'Starts a new client’s onboarding when their payment comes through.' },
    ],

    // Built but switched off in Airtable. Listed so a switched-off automation
    // is a visible decision rather than a thing nobody remembers exists.
    airtableOff: [
        'Task Completion Date', 'Task Created - Link to Team Member',
        'Task Configuration Upon Creation', 'Recurring Tasks',
        'When task has Linked Project, set Priority to Project',
        'When Due Date is updated, adjust the Status',
        'SOP to Create Recurring Task (Initial)',
        'When assignee is changed, add them as collaborator',
        'Auto Rescheduling of Tasks with Calendar Time Block',
        'Advance Due Date after Payment', 'Sync Payment Cost Status',
        'CFV Logger automation', 'Team Capacity Sync Tasks to Team Members',
        'Auto Suggest Categories V2', 'Daily Needle Mover Slack Report',
        'Cumulative Balance for Account Statement',
    ],
};
