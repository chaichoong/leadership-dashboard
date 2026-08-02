# How a client connects their own tools

Status: **recommendation, awaiting Kevin's ruling.** Written 2 Aug 2026. Prompted by
`Learning & Reference/Transcripts/2026-08-02 Shared Claude Memory for Teams.md`, which proposes
buying a broker (Composio) for exactly this problem. Companion to
`docs/supabase-schema-spec.md` §2.6 and the D9 decision in its Addendum.

---

## The question

Every Operations Director client's agents will need to reach that client's own tools: their
Gmail, their Slack, their accounts software. Today the live app reaches all of it through
Kevin's credentials. Nothing in the Supabase spec covers per-tenant tool connections, so if
nobody decides, someone builds one by accident during the migration.

## Recommendation in one line

**Do not buy a broker and do not build a token store. Keep the Apps Script pattern you already
run, deploy a copy per client at onboarding, and revisit at roughly ten clients.**

---

## What a client actually needs connected

From the repo, not from assumption:

| Tool | Which module needs it | In the base £350? | Current mechanism |
|---|---|---|---|
| Gmail (supplier invoices) | Finance / AP Variable (`invoices`) | No, paid module | `gmail-invoice-script.gs`, Apps Script in the mailbox |
| Gmail (meeting summaries) | Meetings | No | `gmail-meetings-script.gs`, Apps Script in the mailbox |
| Gmail (triage, labels) | Inbound Comms | No, paid module | Labels + Apps Script |
| Slack (notifications) | Spine | Yes | `notify-slack-worker.js`, per-client Slack app |
| GoHighLevel (SMS bridge) | Inbound Comms premium extra | No | `sms-email-bridge` worker |
| Bank feeds | Finance | No | Fintable, connected by the client in Fintable |

**The finding that matters: the base product needs no client Gmail access at all.** Every Gmail
dependency sits in a paid add-on module. Only Slack is in the spine, and a Slack app install is
a five-minute job per client with no verification process attached.
Sources: `PRODUCTISATION.md` lines 269-279 and 321-332, `STRUCTURE.md`, and
`project_meetings_module` in memory.

---

## The four options

### A. Keep the Apps Script pattern, one deploy per client (RECOMMENDED)

A copy of the `.gs` file is deployed inside the client's own Google account at onboarding. It
runs on their trigger, under their own authorisation, and posts to their tenant.

- **Cost:** £0 per month. Roughly 30-45 minutes of setup per client, inside the £1,500 setup fee.
- **Verification:** none needed. Google's own documentation is explicit that an app published
  internally within a Workspace organisation does not trigger the unverified-app flow for
  accounts in that domain, even when unverified. A client on a personal Gmail account copies the
  script into their own account and authorises their own copy, which also works.
- **Who holds the credential:** the client. Operations Director never stores a Google token.
- **Already proven:** it is what runs the invoices and meetings modules in production today.
- **Weakness:** manual, and it does not scale. It also assumes the client is on Google.

### B. Broker with the vendor's own OAuth app (Composio, free tier)

- **Cost:** £0 up to 20,000 tool calls a month, then $29/month for 200,000.
  Note their pricing changes on 15 August 2026, so confirm after that date.
- **Verification:** none needed by Kevin. That is the genuine attraction, because it removes a
  4-12 week Google process from the critical path.
- **Who holds the credential:** the broker.
- **Three problems.** First, on default settings the client sees the broker's brand, not
  Operations Director's, when handing over their email. For a done-for-you service that is a
  trust wobble at exactly the wrong moment. Second, and more serious: **Composio disclosed a
  breach on 21 May 2026** in which roughly 5,001 GitHub OAuth tokens and 5,241 API keys were
  exfiltrated, about 0.3% of active connections. The initial vector was a compromised employee
  Gmail OAuth token. They have responded with rotation and are introducing customer-key
  self-custody. Third, SOC 2 appears only on the Enterprise tier and no GDPR or UK/EU data
  residency position is published.
- The breach does not disqualify them outright, and a post-incident vendor is often more
  hardened than a pre-incident one. But it does mean Kevin would be asking a client to route
  their business email through a third party that lost customer tokens ten weeks ago, and he
  would have to be willing to say that out loud on the kick-off call.

### C. Broker with Kevin's own OAuth app (Nango, or Composio custom auth config)

Gets the branding right. The consent screen says Operations Director.

- **Cost:** Nango from $50/month for 20 connections. SOC 2 Type 2 certified, self-hostable.
  Composio supports the same thing through custom auth configs at no extra charge.
- **But owning the OAuth app means owning Google's verification.** Gmail scopes are restricted,
  so this pulls in a CASA Tier 2 security assessment: $540-$1,000 a year on the self-serve path,
  4-12 weeks from first submission, and re-verification every twelve months.
- Right answer eventually. Wrong answer before the first client is live.

### D. Build the token store in Supabase

- **Cost:** no fee, and weeks of build.
- Kevin would own OAuth flows per provider, encryption at rest, refresh, revocation cascade,
  and the Google verification from option C anyway.
- This is the most security-critical code on the platform, and it would be owned by a
  non-technical operator building solo. A funded vendor got this wrong in May. Do not take it on
  to save $50 a month.

---

## Why A wins right now

1. **It is not on the critical path.** The base product does not need it. Selling the Finance or
   Comms module to client one is a choice, not an obligation, and the Apps Script covers it even
   if he does.
2. **It costs nothing and is already built.** Options B, C and D all spend money or weeks
   solving a problem that a file already in the repo solves.
3. **Operations Director never holds a client credential.** That is the strongest security
   position available, and it is free. Under §2.6 the platform now has to guarantee that
   revoking access revokes the data; holding no token at all is the cleanest way to keep that
   promise.
4. **It keeps the decision reversible.** Nothing here forecloses adopting a broker later.

## What should trigger a change

Move to a broker when any one of these is true, not before:

- **Client count reaches roughly ten**, at which point manual script deploys become the
  bottleneck rather than the cheap option.
- **A client is not on Google.** Outlook is already logged as extra E16 in `PRODUCTISATION.md`,
  and a broker is a better answer than a second bespoke ingestion path.
- **A client's Workspace admin blocks unverified apps.** Rare at micro-business size, and it
  forces option C.

When that trigger fires, go to option C, not B: own the OAuth app, do the CASA assessment, keep
the branding. Budget roughly £800 a year and a three-month lead time, and start it before it is
needed.

## Open items only Kevin can settle

1. **Does client one buy a Gmail-dependent module?** If the answer is no, this decision can sit
   untouched until client three or four.
2. **Is he willing to disclose the Composio breach to a client** if he ever adopts option B?
   If not, option B is out permanently and the eventual move is straight to C.

## What this does NOT solve

Per-tenant **Anthropic API key routing** (D9) is a separate problem and none of the above
touches it. A broker connects a client's Gmail; it does not make a client's agents run on the
client's own Anthropic credits. That blocker stands, with its own Airtable task due 31 Aug 2026.
See `project_client_ai_account_and_key_routing` in memory.

---

## Sources

- Composio pricing and tiers: https://composio.dev/pricing
- Composio custom auth configs (bring your own OAuth app): https://docs.composio.dev/docs/custom-auth-configs
- Composio May 2026 security incident, their own disclosure: https://composio.dev/blog/composio-may-2026-security-incident
- Nango pricing: https://www.nango.dev/pricing
- Google restricted-scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Apps Script authorisation and the internal-app exemption: https://developers.google.com/apps-script/guides/services/authorization
- Google Workspace admin controls on unverified apps: https://support.google.com/a/answer/9352843
