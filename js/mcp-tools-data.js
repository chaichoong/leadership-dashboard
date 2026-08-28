// ══════════════════════════════════════════════════════════════════════
// MCP TOOLS DATA — every connector Claude Code can reach
// ══════════════════════════════════════════════════════════════════════
// GENERATED FILE. Do not edit by hand: scripts/generate-mcp-inventory.py
// rewrites it nightly and your edit will be lost. To change a description,
// edit DESCRIPTIONS in that script.
//
// Each row is marked `verified` (read from a real config file or a live health
// check) or `declared` (hand-listed because nothing on disk records it). The
// page shows that split, because `claude mcp list` only ever sees two of these
// servers and a list you cannot attribute cannot be acted on.
//
// Guarded by tests/mcp-inventory.test.js.

var MCP_TOOLS = {
  "generatedAt": "2026-08-28T09:33:29Z",
  "generator": "scripts/generate-mcp-inventory.py",
  "healthNote": "",
  "agentAllowlistSize": 9,
  "counts": {
    "total": 43,
    "verified": 30,
    "declared": 13,
    "kevin": 21,
    "agents": 0,
    "needsAuth": 21
  },
  "groups": [
    {
      "key": "local",
      "title": "Set up in files on this Mac",
      "blurb": "The only tools a script can check the health of. Everything below this group is invisible to the command line.",
      "tools": [
        {
          "name": "github",
          "what": "Reads and writes code on GitHub: pull requests, issues, file contents. This is how the platform ships.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": "this repo, ~"
        },
        {
          "name": "gmail-write",
          "what": "A second, separate Gmail connection that can send. Set up outside this repo; day-to-day sending goes through scripts/send-email.py instead.",
          "auth": "unknown",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "~"
        },
        {
          "name": "metricool",
          "what": "Social media scheduling and stats. Never authorised, so nothing uses it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "this repo"
        }
      ]
    },
    {
      "key": "claudeai",
      "title": "claude.ai connectors",
      "blurb": "Authorised on your Claude account and delivered through the app. These are the ones you actually use day to day. A script cannot confirm they are live, only that they were connected and whether authorisation has lapsed.",
      "tools": [
        {
          "name": "Airtable",
          "what": "Reads and writes the Operations Director base: tasks, tenancies, costs, agents.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Claude Code Remote",
          "what": "Lets you drive a Claude Code session from another device.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Gmail",
          "what": "Reads, labels and drafts email in your inbox.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Google Calendar",
          "what": "Reads and creates calendar events.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Google Drive",
          "what": "Reads and writes files in Drive, including the AI brain vault.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Make",
          "what": "Make.com automations. Never authorised, so nothing uses it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Slack",
          "what": "Reads channels and sends messages.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Stripe",
          "what": "Payments and subscriptions. Never authorised. Will matter at the Supabase cutover when clients start paying.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": ""
        },
        {
          "name": "Zoom for Claude",
          "what": "Reads Zoom recordings, transcripts and meeting notes.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "verified",
          "scope": ""
        }
      ]
    },
    {
      "key": "builtin",
      "title": "Built into the Claude apps",
      "blurb": "Arrive with the desktop app and the command line. Nothing to authorise and nothing to break, but also nothing on disk that lists them, so this group is checked by hand.",
      "tools": [
        {
          "name": "Claude Browser",
          "what": "An in-app browser for opening pages, filling forms and checking the deployed site.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "Claude Code iOS Simulator",
          "what": "Builds and drives iOS apps in the simulator. Nothing here uses it.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "PDF Tools",
          "what": "Reads, fills, signs and splits PDFs.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "Read and Send iMessages",
          "what": "Reads and sends iMessages. The inbound sweep uses this.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "ccd directory",
          "what": "Changes which folder a session is working in.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "ccd session",
          "what": "Session housekeeping inside the Claude desktop app: chapters, background task chips.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "ccd session mgmt",
          "what": "Lists and searches your past Claude Code sessions.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "claude-in-chrome",
          "what": "Drives your real Chrome, with your logged-in sessions. This is the lane the prospecting agent uses.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "computer-use",
          "what": "Clicks and types on your Mac desktop for apps that have no other connection.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "mcp-registry",
          "what": "Searches the public directory of available connectors.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "scheduled-tasks",
          "what": "Creates and lists scheduled Claude tasks.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "terminal",
          "what": "Reads what is on screen in a terminal window.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        },
        {
          "name": "visualize",
          "what": "Draws diagrams and charts inline in a session.",
          "auth": "connected",
          "kevin": true,
          "agents": false,
          "source": "declared",
          "scope": ""
        }
      ]
    },
    {
      "key": "plugins",
      "title": "Plugin bundles",
      "blurb": "8 bundles are installed (anthropic-skills, cowork-plugin-management, customer-support, data, finance, legal, operations, productivity). Every connector inside them is unauthorised, so none of them does anything today. Either authorise the ones you want or remove the bundles.",
      "tools": [
        {
          "name": "atlassian",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "gmail",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "google-calendar",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "guru",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "intercom",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "ms365",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "notion",
          "what": "Part of the customer-support plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "customer-support"
        },
        {
          "name": "amplitude",
          "what": "Part of the data plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "data"
        },
        {
          "name": "amplitude-eu",
          "what": "Part of the data plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "data"
        },
        {
          "name": "hex",
          "what": "Part of the data plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "data"
        },
        {
          "name": "atlassian",
          "what": "Part of the legal plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "legal"
        },
        {
          "name": "docusign",
          "what": "Part of the legal plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "legal"
        },
        {
          "name": "egnyte",
          "what": "Part of the legal plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "legal"
        },
        {
          "name": "slack",
          "what": "Part of the legal plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "legal"
        },
        {
          "name": "clickup",
          "what": "Part of the productivity plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "productivity"
        },
        {
          "name": "linear",
          "what": "Part of the productivity plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "productivity"
        },
        {
          "name": "monday",
          "what": "Part of the productivity plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "productivity"
        },
        {
          "name": "notion",
          "what": "Part of the productivity plugin bundle. Installed but never authorised, so nothing can use it.",
          "auth": "needs-auth",
          "kevin": false,
          "agents": false,
          "source": "verified",
          "scope": "productivity"
        }
      ]
    }
  ]
};
