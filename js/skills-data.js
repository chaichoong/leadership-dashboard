// ══════════════════════════════════════════
// SKILLS DATA — Static registry of all Claude Code / Cowork skills
// ══════════════════════════════════════════
// Updated: 2026-05-06
// To add a new skill, append an entry to SKILLS_LIBRARY below.
// The skill-creator skill auto-appends here after creating a new skill.

const SKILLS_LIBRARY = [

    // ── Property Management ──────────────────────────────────────────
    {
        id: 'airtable-tenant-onboarding',
        name: 'Tenant Onboarding',
        command: 'anthropic-skills:airtable-tenant-onboarding',
        description: 'End-to-end workflow that registers a new tenant, creates their tenancy record, links deposit and rent schedules, and sends welcome documents.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['tenant', 'onboarding', 'airtable', 'automation']
    },
    {
        id: 'airtable-tenant-creator',
        name: 'Tenant Creator',
        command: 'anthropic-skills:airtable-tenant-creator',
        description: 'Automates the process of adding a new tenant record to Airtable with all required fields, linked records, and validation.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['tenant', 'airtable', 'record creation']
    },
    {
        id: 'airtable-tenancy-creator',
        name: 'Tenancy Creator',
        command: 'anthropic-skills:airtable-tenancy-creator',
        description: 'Automates the creation of a new tenancy record including rent amount, start date, linked tenant, unit assignment, and deposit tracking.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['tenancy', 'airtable', 'record creation', 'rent']
    },
    {
        id: 'airtable-tenancy-ender',
        name: 'Tenancy Ender',
        command: 'anthropic-skills:airtable-tenancy-ender',
        description: 'Automates the process of ending a tenancy — marks records inactive, calculates final balances, triggers deposit return workflow, and updates void tracking.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['tenancy', 'end', 'void', 'deposit return']
    },
    {
        id: 'tenant-complaint-handler',
        name: 'Tenant Complaint Handler',
        command: 'anthropic-skills:tenant-complaint-handler',
        description: 'Handles tenant complaints by logging the issue, categorising severity, creating follow-up tasks, and drafting acknowledgement communications.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['tenant', 'complaint', 'maintenance', 'communication']
    },
    {
        id: 'tenant-doc-generator',
        name: 'Tenant Document Generator',
        command: 'anthropic-skills:tenant-doc-generator',
        description: 'Generates standardised tenant documents — tenancy agreements, welcome packs, notice letters, rent increase letters, and reference requests.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['tenant', 'documents', 'letters', 'agreements']
    },
    {
        id: 'contractor-job-creator',
        name: 'Contractor Job Creator',
        command: 'anthropic-skills:contractor-job-creator',
        description: 'Add contractor maintenance jobs to the system — captures job details, assigns contractor, sets priority, and creates the Airtable task record.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['contractor', 'maintenance', 'jobs', 'tasks']
    },
    {
        id: 'schedule-of-works',
        name: 'Schedule of Works',
        command: 'anthropic-skills:schedule-of-works',
        description: 'Professional property survey tool — generates a detailed schedule of works with costings, priorities, and contractor assignments for refurbishment or maintenance programmes.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['survey', 'refurbishment', 'maintenance', 'costings']
    },
    {
        id: 'uc47-form-automation',
        name: 'UC47 Form Automation',
        command: 'anthropic-skills:uc47-form-automation',
        description: 'Automates the completion of UC47 forms for Universal Credit tenants — pulls tenant and tenancy data, fills the form fields, and prepares for submission.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['universal credit', 'UC47', 'forms', 'benefits']
    },
    {
        id: 'commercial-loan-agreement-generator',
        name: 'Commercial Loan Agreement',
        command: 'anthropic-skills:commercial-loan-agreement-generator',
        description: 'Generates a commercial loan agreement document with customisable terms, interest rates, repayment schedules, and security provisions.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['loan', 'agreement', 'commercial', 'finance', 'legal']
    },
    {
        id: 'adobe-sign-field-setup',
        name: 'Adobe Sign Field Setup',
        command: 'anthropic-skills:adobe-sign-field-setup',
        description: 'Configures Adobe Sign document fields for e-signatures — maps form fields, sets signing order, and prepares the document template for automated sending.',
        category: 'Property Management',
        source: 'cowork',
        tags: ['adobe sign', 'e-signature', 'documents', 'automation']
    },

    // ── Finance ──────────────────────────────────────────────────────
    {
        id: 'transaction-reconciler',
        name: 'Transaction Reconciler',
        command: 'anthropic-skills:transaction-reconciler',
        description: 'Daily reconciliation of financial transactions — categorises unreconciled bank transactions, matches against expected payments, and flags discrepancies.',
        category: 'Finance',
        source: 'scheduled',
        tags: ['reconciliation', 'transactions', 'bank', 'matching']
    },
    {
        id: 'cash-flow-forecast',
        name: 'Cash Flow Forecast',
        command: 'anthropic-skills:cash-flow-forecast',
        description: 'Generate a 30-day rolling cash flow forecast using live Airtable data — rent due, costs payable, and known invoices to project daily balances.',
        category: 'Finance',
        source: 'cowork',
        tags: ['cash flow', 'forecast', 'projection', 'balance']
    },
    {
        id: 'airtable-cost-creator',
        name: 'Cost Creator',
        command: 'anthropic-skills:airtable-cost-creator',
        description: 'Add new fixed costs to the accounts payable system — captures amount, frequency, category, supplier, and creates the recurring cost record in Airtable.',
        category: 'Finance',
        source: 'cowork',
        tags: ['costs', 'accounts payable', 'fixed costs', 'supplier']
    },
    {
        id: 'finance-reconciliation',
        name: 'Account Reconciliation',
        command: 'finance:reconciliation',
        description: 'Reconcile accounts by comparing ledger entries against bank statements, flagging discrepancies and producing a reconciliation report.',
        category: 'Finance',
        source: 'cowork',
        tags: ['reconciliation', 'ledger', 'bank statements']
    },
    {
        id: 'finance-journal-entry',
        name: 'Journal Entry Prep',
        command: 'finance:journal-entry',
        description: 'Prepare journal entries with proper debits/credits, supporting documentation references, and approval routing.',
        category: 'Finance',
        source: 'cowork',
        tags: ['journal entry', 'debits', 'credits', 'accounting']
    },
    {
        id: 'finance-financial-statements',
        name: 'Financial Statements',
        command: 'finance:financial-statements',
        description: 'Generate financial statements (P&L, balance sheet, cash flow statement) from ledger data with period comparisons.',
        category: 'Finance',
        source: 'cowork',
        tags: ['P&L', 'balance sheet', 'cash flow', 'statements']
    },
    {
        id: 'finance-variance-analysis',
        name: 'Variance Analysis',
        command: 'finance:variance-analysis',
        description: 'Decompose financial variances between budget and actual — identifies root causes, quantifies impact, and produces a management commentary.',
        category: 'Finance',
        source: 'cowork',
        tags: ['variance', 'budget', 'actual', 'analysis']
    },
    {
        id: 'finance-close-management',
        name: 'Close Management',
        command: 'finance:close-management',
        description: 'Manage the month-end close process — tracks checklist completion, dependencies, blockers, and produces a close status dashboard.',
        category: 'Finance',
        source: 'cowork',
        tags: ['month-end', 'close', 'checklist', 'process']
    },
    {
        id: 'finance-audit-support',
        name: 'Audit Support',
        command: 'finance:audit-support',
        description: 'Support SOX 404 compliance and external audit preparation — gathers evidence, maps controls, and prepares audit working papers.',
        category: 'Finance',
        source: 'cowork',
        tags: ['audit', 'SOX', 'compliance', 'controls']
    },
    {
        id: 'finance-sox-testing',
        name: 'SOX Testing',
        command: 'finance:sox-testing',
        description: 'Generate SOX sample selections and testing templates for control testing — random sampling, attribute testing, and exception reporting.',
        category: 'Finance',
        source: 'cowork',
        tags: ['SOX', 'testing', 'controls', 'sampling']
    },

    // ── Operations ───────────────────────────────────────────────────
    {
        id: 'airtable-task-creator',
        name: 'Task Creator',
        command: 'anthropic-skills:airtable-task-creator',
        description: 'Create tasks in the Airtable task management system — captures title, description, assignee, priority, due date, and linked records.',
        category: 'Operations',
        source: 'cowork',
        tags: ['tasks', 'airtable', 'project management']
    },
    {
        id: 'ops-process-doc',
        name: 'Process Documentation',
        command: 'operations:process-doc',
        description: 'Document a business process end-to-end — captures steps, roles, systems, decision points, and produces a formatted process map.',
        category: 'Operations',
        source: 'cowork',
        tags: ['process', 'documentation', 'workflow', 'SOP']
    },
    {
        id: 'ops-process-optimization',
        name: 'Process Optimization',
        command: 'operations:process-optimization',
        description: 'Analyse and improve business processes — identifies bottlenecks, waste, and automation opportunities with ROI estimates.',
        category: 'Operations',
        source: 'cowork',
        tags: ['process', 'optimization', 'efficiency', 'automation']
    },
    {
        id: 'ops-vendor-review',
        name: 'Vendor Review',
        command: 'operations:vendor-review',
        description: 'Evaluate a vendor — cost analysis, service quality assessment, contract terms review, and renewal recommendation.',
        category: 'Operations',
        source: 'cowork',
        tags: ['vendor', 'supplier', 'review', 'procurement']
    },
    {
        id: 'ops-risk-assessment',
        name: 'Risk Assessment',
        command: 'operations:risk-assessment',
        description: 'Identify, assess, and mitigate operational risks — probability/impact scoring, control mapping, and mitigation action plans.',
        category: 'Operations',
        source: 'cowork',
        tags: ['risk', 'assessment', 'mitigation', 'controls']
    },
    {
        id: 'ops-status-report',
        name: 'Status Report',
        command: 'operations:status-report',
        description: 'Generate a status report with RAG ratings, key metrics, blockers, and next actions — suitable for stakeholder or board updates.',
        category: 'Operations',
        source: 'cowork',
        tags: ['status', 'report', 'RAG', 'stakeholder']
    },
    {
        id: 'ops-compliance-tracking',
        name: 'Compliance Tracking',
        command: 'operations:compliance-tracking',
        description: 'Track compliance requirements — regulatory deadlines, certificate renewals, inspection schedules, and action items.',
        category: 'Operations',
        source: 'cowork',
        tags: ['compliance', 'regulatory', 'tracking', 'deadlines']
    },
    {
        id: 'ops-change-request',
        name: 'Change Request',
        command: 'operations:change-request',
        description: 'Create a change management request — impact assessment, stakeholder analysis, rollback plan, and approval routing.',
        category: 'Operations',
        source: 'cowork',
        tags: ['change management', 'request', 'approval']
    },
    {
        id: 'ops-capacity-plan',
        name: 'Capacity Planning',
        command: 'operations:capacity-plan',
        description: 'Plan resource capacity — workload forecasting, headcount modelling, utilisation tracking, and bottleneck identification.',
        category: 'Operations',
        source: 'cowork',
        tags: ['capacity', 'planning', 'resources', 'headcount']
    },
    {
        id: 'ops-runbook',
        name: 'Runbook',
        command: 'operations:runbook',
        description: 'Create or update an operational runbook — step-by-step procedures for routine operations, incident response, or system maintenance.',
        category: 'Operations',
        source: 'cowork',
        tags: ['runbook', 'procedures', 'incident', 'operations']
    },

    // ── Legal ────────────────────────────────────────────────────────
    {
        id: 'legal-review-contract',
        name: 'Contract Review',
        command: 'legal:review-contract',
        description: 'Review a contract against standard terms — flags deviations, risky clauses, missing provisions, and produces a redline summary.',
        category: 'Legal',
        source: 'cowork',
        tags: ['contract', 'review', 'redline', 'terms']
    },
    {
        id: 'legal-triage-nda',
        name: 'NDA Triage',
        command: 'legal:triage-nda',
        description: 'Rapidly triage an incoming NDA — checks standard vs non-standard terms, flags problematic clauses, and recommends accept/negotiate/reject.',
        category: 'Legal',
        source: 'cowork',
        tags: ['NDA', 'triage', 'confidentiality', 'review']
    },
    {
        id: 'legal-compliance-check',
        name: 'Compliance Check',
        command: 'legal:compliance-check',
        description: 'Run a compliance check on a document or process against regulatory requirements and internal policies.',
        category: 'Legal',
        source: 'cowork',
        tags: ['compliance', 'regulatory', 'check', 'policy']
    },
    {
        id: 'legal-risk-assessment',
        name: 'Legal Risk Assessment',
        command: 'legal:legal-risk-assessment',
        description: 'Assess and classify legal risks — likelihood/impact scoring, jurisdiction considerations, and recommended mitigations.',
        category: 'Legal',
        source: 'cowork',
        tags: ['legal risk', 'assessment', 'jurisdiction']
    },
    {
        id: 'legal-brief',
        name: 'Legal Brief',
        command: 'legal:brief',
        description: 'Generate contextual briefing notes on a legal topic — research summary, key precedents, and practical recommendations.',
        category: 'Legal',
        source: 'cowork',
        tags: ['brief', 'research', 'legal', 'summary']
    },
    {
        id: 'legal-meeting-briefing',
        name: 'Meeting Briefing',
        command: 'legal:meeting-briefing',
        description: 'Prepare structured briefing notes for a legal meeting — agenda items, background context, talking points, and desired outcomes.',
        category: 'Legal',
        source: 'cowork',
        tags: ['meeting', 'briefing', 'preparation', 'legal']
    },
    {
        id: 'legal-vendor-check',
        name: 'Vendor Check',
        command: 'legal:vendor-check',
        description: 'Check the status of existing vendor agreements — contract expiry dates, renewal terms, and compliance with agreed SLAs.',
        category: 'Legal',
        source: 'cowork',
        tags: ['vendor', 'contract', 'SLA', 'renewal']
    },
    {
        id: 'legal-signature-request',
        name: 'Signature Request',
        command: 'legal:signature-request',
        description: 'Prepare and route a document for e-signature — identifies signers, sets signing order, and configures the signature workflow.',
        category: 'Legal',
        source: 'cowork',
        tags: ['signature', 'e-sign', 'routing', 'document']
    },
    {
        id: 'legal-response',
        name: 'Legal Response',
        command: 'legal:legal-response',
        description: 'Generate a response to a correspondence or claim — structured reply with legal reasoning, cited provisions, and recommended next steps.',
        category: 'Legal',
        source: 'cowork',
        tags: ['response', 'correspondence', 'claim', 'legal']
    },

    // ── Data & Analytics ─────────────────────────────────────────────
    {
        id: 'data-analyze',
        name: 'Data Analysis',
        command: 'data:analyze',
        description: 'Answer data questions — from exploratory analysis to hypothesis testing. Connects to your data, runs queries, and presents findings with visualisations.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['analysis', 'data', 'queries', 'insights']
    },
    {
        id: 'data-write-query',
        name: 'SQL Query Writer',
        command: 'data:write-query',
        description: 'Write optimised SQL for your database — handles joins, aggregations, CTEs, and window functions with performance considerations.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['SQL', 'query', 'database', 'optimisation']
    },
    {
        id: 'data-build-dashboard',
        name: 'Dashboard Builder',
        command: 'data:build-dashboard',
        description: 'Build an interactive HTML dashboard from your data — charts, tables, filters, and KPI cards in a single self-contained file.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['dashboard', 'HTML', 'charts', 'KPIs']
    },
    {
        id: 'data-create-viz',
        name: 'Visualisation Creator',
        command: 'data:create-viz',
        description: 'Create publication-quality data visualisations — charts, graphs, and diagrams with proper labelling, colour schemes, and annotations.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['visualisation', 'charts', 'graphs', 'design']
    },
    {
        id: 'data-explore',
        name: 'Data Explorer',
        command: 'data:explore-data',
        description: 'Profile and explore a dataset — schema inspection, distribution analysis, null checks, outlier detection, and relationship mapping.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['exploration', 'profiling', 'schema', 'quality']
    },
    {
        id: 'data-validate',
        name: 'Data Validation',
        command: 'data:validate-data',
        description: 'QA an analysis before sharing — checks methodology, validates calculations, tests edge cases, and reviews presentation.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['validation', 'QA', 'methodology', 'review']
    },
    {
        id: 'data-statistical',
        name: 'Statistical Analysis',
        command: 'data:statistical-analysis',
        description: 'Apply statistical methods to data — regression, hypothesis testing, confidence intervals, clustering, and time series analysis.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['statistics', 'regression', 'hypothesis', 'time series']
    },
    {
        id: 'data-sql-queries',
        name: 'SQL Queries',
        command: 'data:sql-queries',
        description: 'Write correct, performant SQL queries with proper indexing hints, execution plan awareness, and dialect-specific optimisations.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['SQL', 'performance', 'indexing', 'execution plan']
    },
    {
        id: 'data-visualization',
        name: 'Data Visualisation',
        command: 'data:data-visualization',
        description: 'Create effective data visualisations — selects the right chart type, applies design best practices, and ensures accessibility.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['visualisation', 'chart selection', 'accessibility']
    },
    {
        id: 'data-context-extractor',
        name: 'Data Context Extractor',
        command: 'data:data-context-extractor',
        description: 'Generate or improve a comprehensive data context document — schema descriptions, business rules, relationships, and data dictionary.',
        category: 'Data & Analytics',
        source: 'cowork',
        tags: ['data dictionary', 'schema', 'context', 'documentation']
    },

    // ── Customer Support ─────────────────────────────────────────────
    {
        id: 'cs-draft-response',
        name: 'Draft Response',
        command: 'customer-support:draft-response',
        description: 'Draft a professional customer support response — matches tone to the situation, references relevant policies, and suggests next steps.',
        category: 'Customer Support',
        source: 'cowork',
        tags: ['response', 'customer', 'email', 'communication']
    },
    {
        id: 'cs-ticket-triage',
        name: 'Ticket Triage',
        command: 'customer-support:ticket-triage',
        description: 'Triage and prioritise a support ticket — categorises the issue, assesses urgency, routes to the right team, and suggests resolution paths.',
        category: 'Customer Support',
        source: 'cowork',
        tags: ['triage', 'priority', 'routing', 'ticket']
    },
    {
        id: 'cs-customer-research',
        name: 'Customer Research',
        command: 'customer-support:customer-research',
        description: 'Multi-source research on a customer — pulls account history, recent interactions, open tickets, and relationship context.',
        category: 'Customer Support',
        source: 'cowork',
        tags: ['research', 'customer', 'history', 'context']
    },
    {
        id: 'cs-kb-article',
        name: 'KB Article',
        command: 'customer-support:kb-article',
        description: 'Draft a knowledge base article — structured with problem/solution format, screenshots placeholder, and SEO-friendly headings.',
        category: 'Customer Support',
        source: 'cowork',
        tags: ['knowledge base', 'article', 'documentation', 'self-service']
    },
    {
        id: 'cs-escalation',
        name: 'Escalation Package',
        command: 'customer-support:customer-escalation',
        description: 'Package an escalation for handoff — timeline of events, attempted resolutions, customer sentiment, and recommended resolution.',
        category: 'Customer Support',
        source: 'cowork',
        tags: ['escalation', 'handoff', 'resolution', 'customer']
    },

    // ── Productivity & Communications ────────────────────────────────
    {
        id: 'daily-schedule',
        name: 'Daily Schedule',
        command: 'anthropic-skills:daily-schedule',
        description: 'Generates a structured daily schedule pulling from calendar, tasks, and priorities — time-blocks the day with focus periods and buffer time.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['schedule', 'calendar', 'time management', 'planning']
    },
    {
        id: 'meeting-manager',
        name: 'Meeting Manager',
        command: 'anthropic-skills:meeting-manager',
        description: 'Manage meeting rescheduling, preparation, and follow-up — agenda creation, attendee coordination, minutes capture, and action tracking.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['meetings', 'agenda', 'minutes', 'scheduling']
    },
    {
        id: 'weekly-checkin',
        name: 'Weekly Check-in',
        command: 'anthropic-skills:weekly-checkin-task-manager',
        description: 'Automates the extraction and structuring of weekly check-in data — pulls task progress, blockers, and priorities into a formatted update.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['weekly', 'check-in', 'progress', 'update']
    },
    {
        id: 'gmail-respond-manager',
        name: 'Gmail Response Manager',
        command: 'anthropic-skills:gmail-respond-manager',
        description: 'Manages the full "To Respond" Gmail workflow — surfaces emails needing replies, drafts contextual responses, and tracks completion.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['gmail', 'email', 'responses', 'inbox']
    },
    {
        id: 'gmail-to-airtable',
        name: 'Gmail to Airtable Inbound',
        command: 'anthropic-skills:gmail-to-airtable-inbound',
        description: 'Monitors kevin@runpreneur.org.uk inbox and automatically creates Airtable task records from inbound emails matching configured rules.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['gmail', 'airtable', 'automation', 'inbound']
    },
    {
        id: 'post-manager',
        name: 'Post Manager',
        command: 'anthropic-skills:post-manager',
        description: 'Processes scanned post documents — extracts key information, categorises by type (invoice, letter, notice), and creates appropriate follow-up tasks.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['post', 'mail', 'scanning', 'document processing']
    },
    {
        id: 'prod-task-management',
        name: 'Task Management',
        command: 'productivity:task-management',
        description: 'Simple task management using natural language — create, update, prioritise, and track tasks with due dates and categories.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['tasks', 'todo', 'management', 'tracking']
    },
    {
        id: 'prod-memory',
        name: 'Memory Management',
        command: 'productivity:memory-management',
        description: 'Two-tier memory system that stores and retrieves context across conversations — short-term working memory and long-term reference memory.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['memory', 'context', 'persistence', 'recall']
    },
    {
        id: 'prod-start',
        name: 'Productivity Start',
        command: 'productivity:start',
        description: 'Initialise the productivity system — loads your task list, calendar, and priorities to set up the working context for the session.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['initialise', 'setup', 'session', 'context']
    },
    {
        id: 'prod-update',
        name: 'Productivity Update',
        command: 'productivity:update',
        description: 'Sync tasks and refresh memory — pulls latest changes from all connected sources and updates the working context.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['sync', 'update', 'refresh', 'tasks']
    },
    {
        id: 'consolidate-memory',
        name: 'Consolidate Memory',
        command: 'anthropic-skills:consolidate-memory',
        description: 'Reflective pass over your memory files — deduplicates, prunes stale entries, merges related memories, and updates the MEMORY.md index.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['memory', 'cleanup', 'consolidation', 'maintenance']
    },
    {
        id: 'llm-council',
        name: 'LLM Council',
        command: 'anthropic-skills:llm-council',
        description: 'Run any question, idea, or decision through a panel of simulated expert perspectives — each "councillor" argues a different viewpoint to surface blind spots.',
        category: 'Productivity',
        source: 'cowork',
        tags: ['decision making', 'perspectives', 'brainstorming', 'analysis']
    },

    // ── Documents & Media ────────────────────────────────────────────
    {
        id: 'docx',
        name: 'Word Document',
        command: 'anthropic-skills:docx',
        description: 'Create or process Word (.docx) documents — formatting, template filling, mail merge, and content extraction.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['docx', 'Word', 'document', 'formatting']
    },
    {
        id: 'xlsx',
        name: 'Excel Spreadsheet',
        command: 'anthropic-skills:xlsx',
        description: 'Create or process Excel (.xlsx) files — data entry, formula creation, pivot tables, charts, and data transformation.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['xlsx', 'Excel', 'spreadsheet', 'formulas']
    },
    {
        id: 'pdf',
        name: 'PDF Processing',
        command: 'anthropic-skills:pdf',
        description: 'Process PDF files — text extraction, form filling, merging, splitting, and content analysis.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['PDF', 'extraction', 'forms', 'processing']
    },
    {
        id: 'pptx',
        name: 'PowerPoint',
        command: 'anthropic-skills:pptx',
        description: 'Create or process PowerPoint (.pptx) presentations — slide design, content structuring, template application, and export.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['pptx', 'PowerPoint', 'presentation', 'slides']
    },
    {
        id: 'evernote-pdf-processor',
        name: 'Evernote PDF Processor',
        command: 'anthropic-skills:evernote-pdf-processor',
        description: 'Automates processing of multiple PDFs from Evernote — batch extraction, categorisation, and structured data output.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['Evernote', 'PDF', 'batch', 'extraction']
    },
    {
        id: 'video-generator',
        name: 'Video Generator',
        command: 'anthropic-skills:video-generator',
        description: 'Professional AI video production — script writing, scene planning, voiceover generation, and video assembly.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['video', 'production', 'script', 'media']
    },
    {
        id: 'similarweb-analytics',
        name: 'SimilarWeb Analytics',
        command: 'anthropic-skills:similarweb-analytics',
        description: 'Analyse websites and domains using SimilarWeb data — traffic estimates, audience demographics, competitor benchmarking, and market positioning.',
        category: 'Documents & Media',
        source: 'cowork',
        tags: ['analytics', 'traffic', 'competitor', 'web']
    },

    // ── Automation & Scheduled ───────────────────────────────────────
    {
        id: 'inbound-comms-create-tasks',
        name: 'Inbound Comms Task Creator',
        command: 'scheduled:inbound-comms-create-airtable-tasks',
        description: 'Checks Gmail "8: Task created" label and auto-creates Airtable task records for new emails — runs on schedule.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['gmail', 'tasks', 'automation', 'inbound']
    },
    {
        id: 'inbound-comms-complete-tasks',
        name: 'Inbound Comms Task Completer',
        command: 'scheduled:inbound-comms-complete-tasks',
        description: 'Monitors Airtable for completed inbound comm tasks and moves the Gmail emails to "9: Task completed" label.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['gmail', 'tasks', 'completion', 'automation']
    },
    {
        id: 'drift-monitor',
        name: 'Drift Monitor',
        command: 'scheduled:drift-monitor',
        description: 'Nightly drift monitor — validates Airtable schema, codebase field references, SOP accuracy, dashboard health, and auto-fixes or escalates findings.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['monitoring', 'drift', 'schema', 'validation']
    },
    {
        id: 'sop-update-processor',
        name: 'SOP Update Processor',
        command: 'scheduled:sop-update-processor',
        description: 'Processes pending SOP update requests — reads live source code, regenerates accurate SOP HTML, and commits the updated files.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['SOP', 'documentation', 'generation', 'automation']
    },
    {
        id: 'uc-check-slack-notifier',
        name: 'UC Check Slack Notifier',
        command: 'scheduled:uc-check-slack-notifier',
        description: 'Sends a Slack DM to Mica when new UC Check tasks are created from the Leadership Dashboard — ensures timely follow-up.',
        category: 'Automation',
        source: 'scheduled',
        tags: ['Slack', 'notification', 'UC check', 'automation']
    },
    {
        id: 'schedule-skill',
        name: 'Schedule',
        command: 'anthropic-skills:schedule',
        description: 'Create a scheduled task that runs on a cron schedule — configure timing, target skill, and parameters for recurring automated work.',
        category: 'Automation',
        source: 'cowork',
        tags: ['schedule', 'cron', 'automation', 'recurring']
    },

    // ── Development & System ─────────────────────────────────────────
    {
        id: 'build-feature',
        name: 'Build Feature',
        command: 'build-feature',
        description: 'End-to-end workflow for building or extending a feature on the Operations Director Platform. Front-loads requirements, planning, and verification into a single structured pass to eliminate rework.',
        category: 'Development',
        source: 'project',
        tags: ['build', 'feature', 'development', 'workflow']
    },
    {
        id: 'audit',
        name: 'Audit & Score',
        command: 'audit',
        description: 'Robustness audit of a page or dashboard — finds bugs via code review and live browser testing, fixes them, re-audits self-introduced issues, and produces a scored readiness report.',
        category: 'Development',
        source: 'project',
        tags: ['audit', 'testing', 'quality', 'score']
    },
    {
        id: 'health-bar',
        name: 'Health Bar',
        command: 'health-bar',
        description: 'Add a sync bar with health checks to a page or tab — auto-generates data-sync checks, automation checks, and a refresh function, then wires up the HTML container and sidebar health dot.',
        category: 'Development',
        source: 'project',
        tags: ['health', 'sync', 'monitoring', 'checks']
    },
    {
        id: 'sop-generator',
        name: 'SOP Generator',
        command: 'anthropic-skills:sop-generator',
        description: 'Generates a complete SOP HTML page from live source code — reads the feature JS, extracts functionality, and produces a structured guide with the platform design system.',
        category: 'Development',
        source: 'cowork',
        tags: ['SOP', 'documentation', 'generation', 'HTML']
    },
    {
        id: 'skill-creator',
        name: 'Skill Creator',
        command: 'anthropic-skills:skill-creator',
        description: 'Create new skills, modify and improve existing skills, and measure skill performance. Includes eval benchmarking and description optimisation for trigger accuracy.',
        category: 'Development',
        source: 'cowork',
        tags: ['skill', 'creation', 'development', 'eval']
    },
    {
        id: 'skill-creator-from-manus',
        name: 'Skill Creator (from Manus)',
        command: 'anthropic-skills:skill-creator-from-manus',
        description: 'Guide for creating or updating Claude Code skills based on Manus workflow patterns — converts Manus-style automation into Claude Code skill format.',
        category: 'Development',
        source: 'cowork',
        tags: ['skill', 'Manus', 'conversion', 'migration']
    },
    {
        id: 'setup-cowork',
        name: 'Setup Cowork',
        command: 'anthropic-skills:setup-cowork',
        description: 'Guided Cowork setup — installs role-matched plugins, connects your tools, and walks you through trying a first skill.',
        category: 'Development',
        source: 'cowork',
        tags: ['setup', 'cowork', 'onboarding', 'plugins']
    },
    {
        id: 'create-cowork-plugin',
        name: 'Create Cowork Plugin',
        command: 'cowork-plugin-management:create-cowork-plugin',
        description: 'Guide for creating a new plugin from scratch in a cowork session — scaffolds the plugin structure, defines skills, and produces a .plugin file.',
        category: 'Development',
        source: 'cowork',
        tags: ['plugin', 'creation', 'cowork', 'scaffold']
    },
    {
        id: 'cowork-plugin-customizer',
        name: 'Plugin Customiser',
        command: 'cowork-plugin-management:cowork-plugin-customizer',
        description: 'Customise a Claude Code plugin for your organisation — adjust skill parameters, configure connectors, and tailor workflows to your tools.',
        category: 'Development',
        source: 'cowork',
        tags: ['plugin', 'customisation', 'configuration', 'cowork']
    },
    {
        id: 'claude-api',
        name: 'Claude API',
        command: 'claude-api',
        description: 'Build, debug, and optimise Claude API / Anthropic SDK applications — includes prompt caching setup, model migration, and tool use patterns.',
        category: 'Development',
        source: 'system',
        tags: ['API', 'SDK', 'development', 'Claude']
    },
    {
        id: 'simplify',
        name: 'Simplify Code',
        command: 'simplify',
        description: 'Review changed code for reuse, quality, and efficiency, then fix any issues found — reduces complexity and improves maintainability.',
        category: 'Development',
        source: 'system',
        tags: ['code review', 'simplification', 'quality']
    },
    {
        id: 'review',
        name: 'PR Review',
        command: 'review',
        description: 'Review a pull request — checks code quality, correctness, security, and adherence to project conventions.',
        category: 'Development',
        source: 'system',
        tags: ['pull request', 'review', 'code quality']
    },
    {
        id: 'security-review',
        name: 'Security Review',
        command: 'security-review',
        description: 'Complete a security review of code changes — checks for OWASP top 10 vulnerabilities, injection risks, authentication issues, and data exposure.',
        category: 'Development',
        source: 'system',
        tags: ['security', 'review', 'OWASP', 'vulnerabilities']
    },
    {
        id: 'init',
        name: 'Init CLAUDE.md',
        command: 'init',
        description: 'Initialise a new CLAUDE.md file for a project — scans the codebase and generates project instructions for Claude Code sessions.',
        category: 'Development',
        source: 'system',
        tags: ['init', 'CLAUDE.md', 'project', 'setup']
    },
];

const SKILLS_CATEGORIES = [
    'Property Management',
    'Finance',
    'Operations',
    'Legal',
    'Data & Analytics',
    'Customer Support',
    'Productivity',
    'Documents & Media',
    'Automation',
    'Development',
];

const SKILLS_SOURCE_LABELS = {
    project:   'Project Skill',
    scheduled: 'Scheduled Task',
    cowork:    'Cowork / Plugin',
    system:    'Built-in',
    marketplace: 'Marketplace',
};
