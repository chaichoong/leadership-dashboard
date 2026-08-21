// ceo-brief-defaults.mjs : the ONE definition of a tenant's CEO Brief setup.
//
// Three consumers, one file, so they can never disagree:
//   1. workers/ceo-brief-tenants/worker.js  (the 9am robot: reads the config, runs the board)
//   2. ceo-brief-supabase.html              (the client page: renders the setup form FROM SETUP_QUESTIONS)
//   3. docs/ceo-brief-client-onboarding.md  (the onboarding path: lists every question below)
//
// Stored per tenant in Supabase `app_settings` (org_id, key = CONFIG_KEY, value = JSON text).
// Nothing Kevin-specific lives here. The OD default board is generic.

export const CONFIG_KEY = 'ceo_brief';
export const CONFIG_VERSION = 1;

// The eleven seats of the default OD board. A client may rename a head or drop a seat.
// `lane` is what the seat owns, `vetoes` what it may send back, `not` what it may NOT advise on.
export const BOARD_SEATS = [
  { seat: 'Strategy',             head: 'Gary Keller',       lane: 'What is the one thing? Is this the 20%? Quarterly focus, sequencing, killing scattered plans.', vetoes: 'Can send any plan back as scattered.', not: 'Tactics, money, anything needing a professional opinion.' },
  { seat: 'Marketing',            head: 'Alex Hormozi',      lane: 'Offer strength, lead generation, positioning, the promise made to the market.', vetoes: 'Can veto an offer or guarantee that weakens the promise.', not: 'Cash exposure, legal wording, delivery capacity.' },
  { seat: 'Sales',                head: 'Jordan Belfort',    lane: 'The sales call, conversion, objection handling, taking payment, pricing and deal terms.', vetoes: 'Can veto a deal structure that cannot close.', not: 'Marketing positioning, finance policy.' },
  { seat: 'Operations',           head: 'Gino Wickman',      lane: 'Operating rhythm, accountability, meeting cadence, issue resolution, can we deliver what sales sells.', vetoes: 'Can veto a commitment the business cannot deliver.', not: 'Offer design, personal money.' },
  { seat: 'Systemisation',        head: 'Dave Jenyns',       lane: 'Turning every recurring problem into a documented system plus an agent.', vetoes: 'Can send back any recurring job that is still done by hand.', not: 'Strategy, money, legal.' },
  { seat: 'Finance',              head: 'Greg Crabtree',     lane: 'Real profit after market-rate owner pay, cash discipline, labour efficiency, what any target costs.', vetoes: 'Can veto spend that breaks the cash floor.', not: 'Offer construction, marketing tools, legal.' },
  { seat: 'Legal and Compliance', head: 'Keith Cunningham',  lane: 'Contract risk, terms, the compliance calendar, data protection, organising facts for real advisers.', vetoes: 'Can veto anything published or sent that creates legal exposure.', not: 'Giving legal advice; it prepares questions for a real solicitor.' },
  { seat: 'People',               head: 'Patrick Lencioni',  lane: 'Role clarity, accountability, team health, the agent workforce.', vetoes: 'Can veto a role with no clear owner.', not: 'Money, legal.' },
  { seat: 'Wealth',               head: 'Robert Kiyosaki',   lane: 'Assets versus liabilities, passive income, the founder\'s personal balance sheet.', vetoes: 'Can flag a decision that trades an asset for a liability.', not: 'Day-to-day operations, tax advice.' },
  { seat: 'Productivity',         head: 'Chris Bailey',      lane: 'Attention, habits, deep-focus blocks, how work is presented to the founder.', vetoes: 'Can veto a plan that needs more hours than the founder has.', not: 'What the founder works on; that is Strategy.' },
  { seat: 'Mindset',              head: 'John DeMartini',    lane: 'Values alignment, overwhelm, emotion out of decisions, the protected assets (health, family, rest).', vetoes: 'Can pause the plan when the founder is overloaded.', not: 'Tactics, money.' },
];

// The worker agents a brief may hand work to. Real agent names, so a hand-off is never vague.
export const WORKERS = [
  { id: 'worker-builder',    does: 'code, pages, features, wiring agents into the platform' },
  { id: 'worker-writer',     does: 'copy: outreach, emails, posts, client documents' },
  { id: 'worker-researcher', does: 'finding and verifying facts, prospect and company checks' },
  { id: 'worker-analyst',    does: 'numbers, data queries, conversion rates, scorecards' },
  { id: 'worker-auditor',    does: 'sweeps, security and compliance checks, page tests, regression checks' },
];

// Work a founder keeps by definition. Everything else is handed off.
export const FOUNDER_ONLY = ['decisions', 'approvals', 'passwords and credentials', 'payments', 'signatures', 'physical-world actions'];

// The complete setup config, with every default. Deep-merged under whatever the tenant saved.
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    enabled: false,
    timezone: 'Europe/London',
    send_hour: 9,                 // local hour the brief is due; the robot retries until send_hour + 2
    weekdays_only: true,
    language: 'en-GB',
    delivery: { channel: 'none', slack_webhook_url: '', email: '' },   // channel: none | slack_webhook | email
    founder: {
      name: '', business: '', what_it_sells: '', to_whom: '',
      mission: '', twelve_month_target: '',
      wheelhouse: [],              // what only the founder should do
      never_see: [],               // admin, chasing, paperwork...
      non_negotiables: [],         // income floor, protected time...
      income_floor: '',            // "£X a month, no exceptions"
      tone: 'straight',            // straight | supportive
      sensitive_flag: false,       // extra caution in anything written; details never stored here
    },
    quarter: { context: '', ends: '' },   // the ONLY authority on targets in the prompt; refreshed each quarter
    team: [],                     // [{ name, role, may_be_handed: ['suppliers', 'tenants', ...] }]
    workers: WORKERS.map(w => ({ ...w, enabled: true })),
    ceo: { voice: 'Dan Martell', extra_rules: [] },
    board: BOARD_SEATS.map(s => ({ ...s, enabled: true })),
    tasks_source: { kind: 'none', airtable_base: '', airtable_table: '', airtable_pat_ref: '', approval_status: 'Approval', correspondence_type: 'Correspondence' },
    money_source: { kind: 'none', manual_light: 'green', manual_safe_to_act: null },   // none | manual
    calendar_ics_url: '',
    precedents: [],               // [{ date: 'YYYY-MM-DD', rule: '...' }] the founder's standing answers
  };
}

// Deep merge: saved values win, defaults fill the gaps, arrays are replaced whole.
export function mergeConfig(saved) {
  const base = defaultConfig();
  const merge = (a, b) => {
    if (Array.isArray(a) || Array.isArray(b)) return b === undefined ? a : b;
    if (a && typeof a === 'object' && b && typeof b === 'object') {
      const out = { ...a };
      for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
      return out;
    }
    return b === undefined ? a : b;
  };
  return merge(base, saved || {});
}

// The readiness test the page and the robot share. A brief is allowed to run only
// when every blocking answer exists. Returns the list of missing labels.
export function missingForGoLive(cfg) {
  const c = mergeConfig(cfg);
  const missing = [];
  if (!c.founder.name) missing.push('Founder name');
  if (!c.founder.business) missing.push('Business name');
  if (!c.founder.what_it_sells) missing.push('What the business sells');
  if (!c.quarter.context) missing.push('This quarter\'s targets');
  if (!c.founder.wheelhouse.length) missing.push('What only the founder should do');
  if (c.delivery.channel === 'slack_webhook' && !c.delivery.slack_webhook_url) missing.push('Slack webhook address');
  if (c.delivery.channel === 'email' && !c.delivery.email) missing.push('Delivery email address');
  if (!c.board.some(s => s.enabled)) missing.push('At least one board seat');
  return missing;
}

// EVERY question the client answers, in the order they answer it. The setup page
// renders this list; the onboarding document prints it. `path` is where the answer
// lands in the config. `who`: CLIENT answers it on the setup screen, CALL is asked by
// us on the kick-off call and typed in, US is set by us during provisioning.
export const SETUP_QUESTIONS = [
  // Step 1 : Who you are
  { step: 1, section: 'Who you are', id: 'founder_name',     who: 'CLIENT', type: 'text',     path: 'founder.name',               label: 'Your name', required: true },
  { step: 1, section: 'Who you are', id: 'business',         who: 'CLIENT', type: 'text',     path: 'founder.business',           label: 'Business name', required: true },
  { step: 1, section: 'Who you are', id: 'what_it_sells',    who: 'CLIENT', type: 'textarea', path: 'founder.what_it_sells',      label: 'What does the business sell, and at roughly what price?', required: true, help: 'One or two sentences. Example: "Bookkeeping for trades businesses, £250 a month."' },
  { step: 1, section: 'Who you are', id: 'to_whom',          who: 'CLIENT', type: 'text',     path: 'founder.to_whom',            label: 'Who buys it?', help: 'Example: "Plumbers and electricians with 2 to 10 staff in the North West."' },
  { step: 1, section: 'Who you are', id: 'mission',          who: 'CLIENT', type: 'text',     path: 'founder.mission',            label: 'The business in one line, the way you would say it to a friend' },
  { step: 1, section: 'Who you are', id: 'twelve_month',     who: 'CLIENT', type: 'text',     path: 'founder.twelve_month_target', label: 'Where should the business be in 12 months?', help: 'A number if you have one: revenue, clients, profit, hours you work.' },

  // Step 2 : This quarter
  { step: 2, section: 'This quarter', id: 'quarter_context', who: 'CLIENT', type: 'textarea', path: 'quarter.context',            label: 'What are you aiming for this quarter, and what is the theme?', required: true, help: 'Two or three sentences. This is the only thing your CEO uses to judge what matters. Update it every quarter.' },
  { step: 2, section: 'This quarter', id: 'quarter_ends',    who: 'CLIENT', type: 'date',     path: 'quarter.ends',               label: 'When does this quarter end?' },

  // Step 3 : Rules and red lines
  { step: 3, section: 'Rules and red lines', id: 'income_floor',    who: 'CLIENT', type: 'text',  path: 'founder.income_floor',    label: 'The minimum your household needs each month, no exceptions', help: 'Your CEO will warn you before anything threatens it.' },
  { step: 3, section: 'Rules and red lines', id: 'non_negotiables', who: 'CLIENT', type: 'list',  path: 'founder.non_negotiables', label: 'Up to five things that must never be sacrificed for the business', help: 'Health, family time, a day off, training, a side commitment.' },
  { step: 3, section: 'Rules and red lines', id: 'wheelhouse',      who: 'CLIENT', type: 'list',  path: 'founder.wheelhouse',      label: 'What should only YOU do in this business?', required: true, help: 'Decisions, approvals, signatures, payments and anything physical are always yours. Add the rest: client calls, pricing, strategy, deep work.' },
  { step: 3, section: 'Rules and red lines', id: 'never_see',       who: 'CLIENT', type: 'list',  path: 'founder.never_see',       label: 'What do you never want to be asked to do again?', help: 'Admin, chasing, paperwork, data entry. Your CEO hands these off instead of giving them to you.' },
  { step: 3, section: 'Rules and red lines', id: 'tone',            who: 'CLIENT', type: 'select', path: 'founder.tone',           label: 'When the numbers look bad, how do you want it?', options: [['straight', 'Straight and blunt'], ['supportive', 'Supportive, with options']] },
  { step: 3, section: 'Rules and red lines', id: 'sensitive_flag',  who: 'CALL',   type: 'checkbox', path: 'founder.sensitive_flag', label: 'Is there anything sensitive we should be extra careful with in writing? (disputes, legal, partners)', help: 'We store yes or no only. The details never go into any prompt.' },

  // Step 4 : Your team and your agents
  { step: 4, section: 'Your team and your agents', id: 'team',    who: 'CLIENT', type: 'team',    path: 'team',    label: 'Your team: name, role, and what each person may be handed', help: 'Your CEO hands work to AI first, then to a named person, then to you. Leave empty and everything not AI-shaped reaches you.' },
  { step: 4, section: 'Your team and your agents', id: 'workers', who: 'US',     type: 'workers', path: 'workers', label: 'The five AI worker agents (on by default)', help: 'Builder, writer, researcher, analyst, auditor. We switch one off only if a client asks.' },

  // Step 5 : Your board
  { step: 5, section: 'Your board', id: 'board',     who: 'CLIENT', type: 'board', path: 'board',      label: 'Your board of directors', help: 'Eleven seats, each with a named author as its voice. Untick a seat you do not want. Change a name if you would rather hear a different voice in that seat.' },
  { step: 5, section: 'Your board', id: 'ceo_voice', who: 'CLIENT', type: 'text',  path: 'ceo.voice',  label: 'Whose voice should your CEO speak in?', help: 'Default: Dan Martell (Buy Back Your Time). Any author or mentor you trust.' },

  // Step 6 : Where your work lives (set up WITH us on the kick-off call)
  { step: 6, section: 'Where your work lives', id: 'tasks_source',   who: 'CALL', type: 'tasks_source',   path: 'tasks_source',   label: 'Where do your open tasks live?', help: 'The Tasks page in this app, or an Airtable base we connect. Your CEO reads name, owner, due date, status, priority and type.' },
  { step: 6, section: 'Where your work lives', id: 'money_source',   who: 'CALL', type: 'money_source',   path: 'money_source',   label: 'Should the brief carry a money traffic light?', help: 'Connected later through the Finance add-on. Until then: none, or a manual figure you keep updated.' },
  { step: 6, section: 'Where your work lives', id: 'calendar_ics',   who: 'CLIENT', type: 'secret',       path: 'calendar_ics_url', label: 'Your calendar\'s private address (optional)', help: 'Google Calendar: Settings, your calendar, "Secret address in iCal format". Paste it here, never into an email.' },

  // Step 7 : Delivery
  { step: 7, section: 'Delivery', id: 'timezone',     who: 'CLIENT', type: 'select', path: 'timezone',      label: 'Your timezone', options: [['Europe/London', 'London'], ['Europe/Dublin', 'Dublin'], ['Europe/Paris', 'Paris / Berlin / Madrid'], ['America/New_York', 'New York'], ['Australia/Sydney', 'Sydney']] },
  { step: 7, section: 'Delivery', id: 'send_hour',    who: 'CLIENT', type: 'select', path: 'send_hour',     label: 'What time should the brief arrive?', options: [[7, '7am'], [8, '8am'], [9, '9am'], [10, '10am']] },
  { step: 7, section: 'Delivery', id: 'channel',      who: 'CLIENT', type: 'select', path: 'delivery.channel', label: 'Where should it arrive?', options: [['none', 'Only on this page'], ['slack_webhook', 'Slack'], ['email', 'Email']] },
  { step: 7, section: 'Delivery', id: 'slack_webhook', who: 'CALL',  type: 'secret', path: 'delivery.slack_webhook_url', label: 'Slack incoming webhook address', help: 'Set up with us on the call: Slack, Apps, Incoming Webhooks, pick the channel or your DM, copy the address.' },
  { step: 7, section: 'Delivery', id: 'email',        who: 'CLIENT', type: 'text',   path: 'delivery.email', label: 'Email address for the brief' },

  // Step 8 : Go live
  { step: 8, section: 'Go live', id: 'enabled', who: 'US', type: 'checkbox', path: 'enabled', label: 'Switch the daily brief on', help: 'We turn this on after the dry run reads right. The page shows what is still missing until then.' },
];

export const SETUP_STEPS = [...new Set(SETUP_QUESTIONS.map(q => q.step))].map(n => ({
  step: n, title: SETUP_QUESTIONS.find(q => q.step === n).section,
}));

// Read or write a dotted path on the config.
export function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
export function setPath(obj, path, value) {
  const keys = path.split('.'); let o = obj;
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  o[keys[keys.length - 1]] = value; return obj;
}
