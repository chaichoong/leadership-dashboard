// ══════════════════════════════════════════
// CONFIG — Constants, Table IDs, Field IDs, Budget Targets
// ══════════════════════════════════════════
    // ── Config ──
    const BASE_ID = 'appnqjDpqDniH3IRl';
    const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

    // ── Page & SOP Version Registry ──
    const PAGE_REGISTRY = [
        { id: 'overview',    name: 'Leadership Dashboard',           icon: '📊', pageVer: '2.23', sopFile: 'sop.html',                   sopVer: '2.9', standalone: 'index.html#overview' },
        { id: 'os-strategy', name: 'Objective & Strategy',           icon: '🎯', pageVer: '1.12', sopFile: 'os/strategy/sop.html',       sopVer: '1.0', standalone: 'os/strategy/index.html' },
        { id: 'tasks',       name: 'Task and Project Management',   icon: '✅', pageVer: '1.59', sopFile: 'os/tasks/sop.html',             sopVer: '1.1', standalone: 'os/tasks/index.html' },
        { id: 'cfv',        name: 'CFVs',                          icon: '🚨', pageVer: '1.15', sopFile: 'sop-cfvs.html',               sopVer: '1.6', standalone: 'index.html#cfv' },
        { id: 'costs',      name: 'Accounts Payable Fixed',        icon: '📋', pageVer: '1.5', sopFile: '',                            sopVer: '1.0', standalone: 'index.html#costs' },
        { id: 'invoices',   name: 'Accounts Payable Variable',     icon: '🧾', pageVer: '2.15', sopFile: 'sop-invoices.html',           sopVer: '2.2', standalone: 'index.html#invoices' },
        { id: 'pnl',        name: 'Profit & Loss',                 icon: '💰', pageVer: '2.18', sopFile: 'sop-pnl.html',               sopVer: '2.12', standalone: 'index.html#pnl' },
        { id: 'transactions', name: 'Transactions',                icon: '🔍', pageVer: '1.0', sopFile: '',                            sopVer: '1.0', standalone: 'index.html#transactions' },
        { id: 'comms',      name: 'Inbound Comms',                 icon: '📨', pageVer: '2.30', sopFile: 'inbound-comms-sop.html',      sopVer: '2.3', standalone: 'follow-up.html' },
        { id: 'compliance', name: 'Property Compliance',            icon: '✅', pageVer: '1.10', sopFile: 'sop-compliance.html',         sopVer: '1.1', standalone: 'compliance.html' },
        { id: 'operations',  name: 'Operations',                    icon: '🏢', pageVer: '1.12', sopFile: '',                            sopVer: '1.0', standalone: 'os/operations/index.html' },
        // Plan Builder lives under the Leadership section in the sidebar.
        // (Operating Systems Hub + Launch Plan removed during sidebar restructure.)
        { id: 'os-bplan',  name: 'Business Launch Plan Builder',   icon: '📋', pageVer: '1.10', sopFile: 'os/business-plan-builder/sop.html', sopVer: '1.3', standalone: 'os/business-plan-builder/index.html' },
        { id: 'fintable',  name: 'Accounts',                       icon: '🏦', pageVer: '1.3', sopFile: '',                            sopVer: '1.0', standalone: 'index.html#fintable' },
        { id: 'sitemap',    name: 'Site Map & Guides',             icon: '🔗', pageVer: '1.15', sopFile: 'sop-sitemap.html',            sopVer: '1.1', standalone: 'index.html#sitemap' },
        { id: 'skills',     name: 'Skills Library',                icon: '🧠', pageVer: '1.0', sopFile: '',                             sopVer: '1.0', standalone: 'index.html#skills' },
    ];

    // Gmail Invoice Script URL — deploy gmail-invoice-script.gs as a Google Apps Script web app
    // and paste the URL here. Leave empty to use static fallback data.
    const GMAIL_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwzn-xAv2li7Qo8GrEEkELWzRNp0_4fcz9tiuxQdXiDDgwhCHpoRTTbDyF2K3Ks5wza/exec';

    // Table IDs
    const TABLES = {
        accounts:      'tbl1nr0EcX2T62KME',
        costs:         'tblx5kvhzNEI5TFlS',
        tenancies:     'tblN51a88qTDB6iMH',
        transactions:  'tbln0gzhCAorFc3zB',
        rentalUnits:   'tblM3mZCR5kiEdWMj',
        tenants:       'tblX4elTuu01gwBYh',
        properties:    'tbl6f0OkAmTC2jbuG',
        tasks:         'tblqB8b22hKBL4PF1',
        categories:    'tbleWb8ioptnEwPR8',
        subCategories: 'tblOTdRcPf8AgRz25',
        businesses:    'tblpqkvWJJo8Uu25q',
        invoices:      'tblkOTKIG2Tyiy9aM',
        objStrat:      'tblEBvFw8DonwxzGh', // Objective and Strategy (one row per business per quarter)
        mainMethods:   'tbl065D58MBEJhjlp', // Main Methods (reusable steps linked from Objective)
        projects:      'tblHrpTMd5LNYn8v1', // Projects (quarterly projects from Strategy push here)
        reconAudit:    'tblbfuxYxu4uMMWwT', // AI Recon Audit — accuracy log (auto-pruned to last 35 days)
        arrears:       'tblzG0B9oRRpszcgC', // Arrears Records — 7-stage credit control pipeline
        arrearsLog:    'tblik5VI5Jy6tO2yc', // Arrears Contact Log — audit trail per contact event
    };

    // ── Arrears Records field IDs (Airtable table: Arrears Records / tblzG0B9oRRpszcgC) ──
    // 7-stage credit control pipeline. One record per arrears journey (per missed payment).
    // Branches by tenant type (read from tenantPayType on linked Tenant): Working / Universal Credit / Agent-Managed.
    const ARREARS = {
        ref:              'fldYvuHyhYplblMJr',  // Reference (singleLineText, primary) — e.g. "AR-2026-0001"
        stage:            'fldV7xA2UZJHmbCHj',  // Stage (singleSelect)
        status:           'fld710smZ58a3ObWR',  // Status (singleSelect)
        pauseReason:      'fldNIFtwOCkrUzjvV',  // Pause Reason (singleSelect)
        openedDate:       'fldj7oboumezTCLbQ',  // Opened Date
        originalDueDate:  'fldll8HpWOmYkyKea',  // Original Due Date
        amountOwed:       'fldMc2ymgBmTsIEJN',  // Amount Owed (currency, £)
        lastContactDate:  'fldn3zefQ5emjxKVD',  // Last Contact Date
        lastContactChannel:'fldqdrFQCfLTUKnE8', // Last Contact Channel (singleSelect)
        nextActionDue:    'fld0AVSdS7y1zpQua',  // Next Action Due
        nextActionType:   'fldXxv8J1zfxCOrMZ',  // Next Action Type
        ucCallOutcome:    'fldpqYu5nix98zrZe',  // UC Call Outcome (singleSelect)
        resolutionDate:   'fld3PwylEW5dX29m1',  // Resolution Date
        resolutionType:   'fldptjB4iPkhcD4ed',  // Resolution Type (singleSelect)
        tenancyEndAction: 'fldGfDTOgsz10brA6',  // Tenancy End Action (singleSelect)
        notes:            'fld4B5Lz7P9dpQS8H',  // Notes
        tenancy:          'fldXx3YsQrm9k4sze',  // Tenancy (link → Tenancies)
        linkedTasks:      'fldxYYCWnV9DGsBIo',  // Linked Tasks (link → Tasks)
        contactLog:       'fldbUpHVBgtDrts6Q',  // Contact Log (reverse link from Arrears Contact Log)
    };

    // ── Arrears Contact Log field IDs (Airtable table: Arrears Contact Log / tblik5VI5Jy6tO2yc) ──
    // One record per contact event. Court-ready audit trail.
    const ARREARSLOG = {
        ref:           'fldRS88D7pFGba9tq',  // Reference (singleLineText, primary)
        date:          'flds0QuML8fJDwwex',  // Date (dateTime, Europe/London)
        stage:         'fldfYdMyB8HpSC8u2',  // Stage (singleSelect)
        channel:       'fldb1Rasz3YO0ukHl',  // Channel (singleSelect)
        direction:     'fld64LgBaNRvuJ7HX',  // Direction (Outbound / Inbound)
        initiator:     'fldeNbrnL7o8GYfvN',  // Initiator (System / Mica / Other Staff / Tenant / UC Office)
        outcome:       'fldFO4RI2Vz7uk0s3',  // Outcome (singleSelect)
        promiseDate:   'fldSEdzbOqDksQUmZ',  // Promise Date
        notes:         'fld800seLgSTMPgme',  // Notes
        emailMsgId:    'fldAkO0awEK0IS0kP',  // Email Message ID
        arrearsRecord: 'fldSWyS6JYgnLtPzU',  // Arrears Record (link → Arrears Records)
        linkedTask:    'fldBLuUTLMTq2o82X',  // Linked Task (link → Tasks)
    };

    // UC office contact details (used by auto-generated Mica tasks)
    const UC_CONTACT = {
        phone: '0800 328 5644',
    };

    // AI Recon Audit field IDs
    const RECAUDIT = {
        txId:        'fld1n4hxZ0XD5FaR9',  // singleLineText — Airtable record ID of reconciled tx
        date:        'fldJC9UcHCaXAaxKV',  // date (ISO) — when logged
        wasAccurate: 'fld9n62GxQijQWqSA',  // checkbox — AI suggestion matched final values
    };

    // Dashboard Invoices field IDs (Airtable)
    const INV = {
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
        matchRejected: 'fldSn94PRMyScVZA7',
        isEstimate:    'fld4DNJoLG76I4xvz',
        notes:         'fldV2xsw9en67ts0o',
        matchedTx:     'fldpHf5vYCIgj3Scz',
        business:      'fldzGhwp6rxwEFoxu',  // Linked → Businesses (multipleRecordLinks)
    };

    // Business name field on the Businesses table — used by the Invoices tab dropdown
    const BIZ_NAME_FIELD = 'fldbbRqVxLxUdHwIR';
    // Active checkbox on the Businesses table — every business picker/filter in the app
    // hides records where this is unchecked. Tick in Airtable to bring a business back.
    const BIZ_ACTIVE_FIELD = 'fldhXBnRrngCVsgSk';

    // Field IDs
    const F = {
        // Accounts
        accGBP:           'fldhDG5jDA8Tu2JyI',
        accLastUpdate:    'fld8HOlbBrXbHesoA',
        // Costs
        costName:         'fldS6FYfpkhu6tJG0',
        costExpected:     'fld9JibXkMpTeMcxw',
        costDueDay:       'fld7IsfiGvKpxEwSs',
        costFrequency:    'fldvozTHvs5VH3lNi',
        costPayStatus:    'fldXZNI96v8HgjuSh',   // legacy multi-status singleSelect — kept for migration only
        costAccountAlias: 'fldX2QMLkSYzDEpIF',   // legacy lookup
        costInactive:     'fldQJPGLFMbwVelsW',
        costDueDateNext:  'fldQZBF4JzBsmWU87',
        costSubCategory:  'fldRO90pSCj6ahVMC',   // legacy Chart of Accounts - Sub Categories (linked)
        // Costs — clean fields owned by the dashboard (single source of truth, written by reconciliation)
        costEndDate:           'fldhTpqQsVAnHpTCz',  // existing "Last Payment Date" field — UI label: "End Date"
        costLastReconDate:     'fldeMdOxYemcJwVRD',  // Last Reconciled Payment Date (new)
        costLastReconAmount:   'fldaYYj2cInwtvOdJ',  // Last Reconciled Amount (new, currency £)
        costLastReconAccount:  'fldFdBxF4EMABsg2v',  // Last Reconciled Account (new, links → Accounts)
        costLastReconSubCat:   'fld8jYp42Y7s3NbrM',  // Last Reconciled Sub-Category (new, links → Sub-Categories)
        costStatusNew:         'fldWl7mp9zTC2aaaQ',  // Cost Status (New): In Payment / Overdue / Inactive
        costDaysOverdue:       'fldVV5SB9jHJx84IA',  // Days Overdue (number) — written by dashboard on load
        costVarianceAmount:    'fldplK7AtAPJVlzyM',  // Variance Amount (£) — written by dashboard on load
        costVarianceFlag:      'fldQ4gNa9s36SyHHQ',  // Variance Flag: Match / Soft / Hard / Unknown
        costExpectedNext:      'fldiiWiiPLXkWg1Dc',  // Expected Next Payment (date) — written by dashboard on load
        costLatestTxDate:      'fldDEWHeA35d8hYGf',  // Latest Transaction Date (rollup) — used by backfill heuristic
        costTxCount:           'fldjPt9cgzywA6SZq',  // Transaction Count (count) — used by backfill heuristic
        costVarianceDismissedAt: 'fldY5owE8PfjHO3ol', // Variance Dismissed At Recon — sticky dismissal anchor
        costStatusLockedAt:    'flds0EonpkRbyOjZv',  // Status Locked Until Recon — manual override anchor
        // Account fields
        accountAlias:          'fld21HAxSawQCxICj',  // Account Alias (singleLineText on Accounts table)
        // Transactions sub-category (already have txSubCategory = fldMRjSVzZVYeHb0A)
        // Tenancies
        tenRef:           'fldyNVvFn4x8GY14q',
        tenRent:          'fldDMyfZLFMeONPq8',
        tenDueDay:        'fldhy2U0CQmM2oS4P',
        tenPayStatus:     'fldxU3dPUnbK0SCDq',
        tenSurname:       'fldOXazTqBWieEOK2',
        tenUnit:          'fld7cjLLEHKAx49OK',
        tenPayFreq:       'fld5O24mC8vOezjXK',
        // Transactions
        txDate:           'fldoyQ6Rr9cHp3bgQ',
        txAmount:         'fldN01r1hp7UQjgtm',   // raw **GBP — kept for reference only
        txReportAmount:   'fldot7iisZeL3WrdR',   // Report Amount formula — use this for all displays
        txReconciled:     'fldxKX1IbIFcAOnn5',
        txSubCategory:    'fldMRjSVzZVYeHb0A',
        txAccountAlias:   'fldBrjlbeaKFm3WzQ',
        txVendor:         'fld0Xr8sboQ0ekJQJ',
        txDescription:    'fldsbuAJCTsXHug4C',  // *Name — primary field on Transactions. The
                                                  // Airtable "Split Transactions" automation
                                                  // appends "(Split X of N)" to this field on splits.
        txName:           'fldsbuAJCTsXHug4C',  // alias of txDescription — different intent (split logic)
        txInvoiceData:    'fldT5qfiyt5DTLrp8',
        txTeamMember:     'fldMwliSwEhLuumvd',
        // Split mechanism
        // ------------------------------------------------------------------
        // Splits are owned by the Airtable "Split Transactions" automation
        // (Operations Director base → Automations → Finance → Split
        // Transactions). The automation triggers when `Split Count > 1` and
        // an idempotency check on *Name passes (skips records already named
        // "(Split 1 of N)"). It then renames the parent and creates N-1
        // children with **GBP = original / N and Split Count = 1 each.
        //
        // The JS reconciliation Split feature is PATCH-ONLY — it sets
        // `Split Count` on the source record and lets the automation own
        // duplication. NEVER POST duplicate transactions from JS — that
        // double-creates them and we end up with N × (N-1) extras. (See
        // commit f5b7aad for the data-corruption incident this prevents.)
        txSplitCount:     'fld20FWX7yjM8P2Kz',   // number — N. Default 1 = whole transaction.
        txSplitOverride:  'fldQ37YsyR9r3EbkP',   // currency — per-portion amount for UNEVEN splits
                                                  //   (only honored once the Report Amount formula
                                                  //   in Airtable is updated to read this field;
                                                  //   currently a placeholder for the Custom-Amounts
                                                  //   mode coming in a follow-up).
        txSplitStatus:    'fld7gZxUldVLZXnAB',   // formula → "Single" or "Split"
        txOriginalAmount: 'fldh711ChnFGDvh1u',   // formula → echoes raw, for display
        // Tenancy — tenant active/former status (rollup from Tenants table)
        tenStatus:        'fldgWAyha1Uij1SZP',
        // Rental Units
        unitStatus:       'fldBvqysXBm9rIm0E',
        unitProperty:     'fldUJNRGgzgyAwwjt',
        unitPropName:     'fld7NBHkhjqfbcxk7',  // Property Name (Short) lookup
        unitName:         'fldr8sliyu8h2jw9t',   // Rental Unit (primary field — formula)
        unitNumber:       'fld3nPlpdXSExxDuq',   // Unit Number (number field)
        // Tenants
        tenantStatus:     'fldAXzP9SGIHiAhrv',
        tenantName:       'fldxBKW7QnujSDWqA',
        tenantPayType:    'fldZbrk8Xw5Dcwxhi',  // Rent Payment Type (singleSelect)
        // Tenancy → Tenant link
        tenLinkedTenant:  'fld1i5bDoHL3B6rUf',  // "Customers" — actual link to Tenants table
        // CFV detection fields
        tenPaidThisMonth: 'fldSNk1LWWcu517CA',  // Paid This Month? (formula)
        tenDaysOverdue:   'fldrb4NVHdLefslPo',  // Number of Days Overdue (formula)
        tenDaysUntilDue:  'fldDKdNdOsmdVnmGq',  // Days Until Due (formula)
        tenNextDueDate:   'fldSPslO6Wh5IUSK3',  // Next Rent Due Date (formula)
        tenUnitRef:       'fldql2nyQlPfkPP4p',  // Unit Reference (lookup)
        tenProperty:      'fldxfIa0W1nqCbLo2',  // Property (lookup)
        tenStartDate:     'fld2rPXwwV8dXb1zF',  // Tenancy Start Date
        // Tenant contact fields
        tenantPhone:      'fldraHUkWfqo4olLF',  // Contact Number
        tenantEmail:      'fldybEduFY3DWWTfT',  // Email Address
        tenantNotes:      'fldfwxEf7I3XQDVtR',  // Notes
        // Transaction reconciliation linked fields
        txCategory:       'fldFPmNixqHPQy4D6',  // Chart of Accounts - Category (linked)
        txTenancy:        'fldPmAMmxwqs4SdPa',  // Tenancy (linked)
        txUnit:           'fldJGIhSbgXNIEW4a',  // Unit (linked)
        txProperty:       'fldvp44VfF8uTTthp',  // Property (linked)
        txCost:           'fldGkpkVqSeiGvUGL',  // Costs (linked)
        txAccountLink:    'fld9hm24JQUPOCoWj',  // **Account (linked → Accounts) — actual account record link on tx
        txBusiness:       'fldX1aFlJyzpXGhbF',  // Business (For Reports) (linked)
    };

    // Objective & Strategy OS field IDs — maps the Airtable form fields shown in the
    // Operations Director interface (Objective Plan + Strategy Plan screens).
    // All fields live on table `objStrat`. One row per Business × Quarter × Year.
    const OBJSTRAT = {
        // Keys
        business:       'fldLt6uDJ2xKCMlj2',  // link → businesses
        businessName:   'fldzd28sBEghgt0mN',  // formula (display only)
        quarter:        'fldQl2h3gCxYacE1k',  // singleSelect: Q1|Q2|Q3|Q4
        year:           'fldARVrVpuCWxufQO',  // singleSelect
        created:        'fldRreG5iDvyOFzPV',  // createdTime
        // Objective page
        objective:      'fldYgHiiw6acphydt',  // richText
        targetWhat:     'fldjQXSVO7NRMAh3G',  // What we do
        targetWho:      'fldxkPKMkdqMM1vbp',  // Who we do it for
        targetHow:      'fldtXlnFTUotrbdSg',  // How we do it
        customerProfile:'fld7H5Rq8cwmvpYpR',  // richText
        enticement:     'fldkcHNdfJoK6kjN4',  // richText
        // Undertakings 1–20 (singleLineText each) + rollup formula
        undertakings: [
            'fldMvrYLvhRTWUerX','fld32CDRhkJOjTBq7','fldSDqjnSAZ3stdQb','fldIgeNKX2guYYszV',
            'flduKuWhOs7zlomms','fldwNocH22bQa9LB1','fld5mRnHYWdbvjLIS','fldVMWHoLTHljHxZb',
            'fldwRtrRL3qCcrO9q','fld8whDbavzFNuRY4','fldyGXnRvocsk1jTV','fldqFY4hOBVBieTKA',
            'fld9SKhpG433YIhgb','fldnJJBgt3lLlSfGB','fldotSquJccSH8SOj','fldYq0NdidT0NzzGt',
            'fld7aPMenbDIhIBSt','fldb6A3vOQv2Js5Nw','fldyld465QsYr4fjA','fldF11iQAUiTCLqJu',
        ],
        undertakingsRollup: 'fldNrwHP8Mhn0qo9F', // formula
        // USPs 1–5 + rollup
        usps: [
            'flda9n4I9qLENQ0Nr','fldv27HJQqw08jXXT','fld4R3dLs1n77RIgY','fldrESVKwXnCTd1oA','fldIO6AqnXjyo3Jbp',
        ],
        uspsRollup: 'fldzrM5OF7Ug933ye', // formula
        // Main Method — two representations: linked-record slots (preferred, links to mainMethods table)
        // plus plain-text step fields (used in the form screens) + a rollup formula.
        mainMethodLinks: [
            'fldqQIH0bU4hDSiL5','fldd6IJwHKPIb0CIl','fldAUbgvtC5lNXTdS','fldgYPzIjyt37wo6k',
            'fldfw9UiUpzz4ndge','fldT6Lo73MJJ3xEPa','fld9bViCHPvZviENY','fld0TDbOBZ4JZVG2i',
            'fldcUeyPErJIU8rvH','fldiWxDwMGyVuWMCr',
        ],
        methodSteps: [
            'fldeUT30vYQ8UZ0LF','fldZPoyLCxSl43EvG','fldcBzIO63zGOYbMS','fld90iQaKfBhw925i',
            'fldtRNL7C1GOsnfRO','fldy4hcD9lYV7YTwb','fldEgpGubfyRkB3wf','fld87YId2DxqVzk0M',
            'fldmsugSqmNT1tS7g','fldS41sn0Nvypuyv6',
        ],
        methodStepsRollup: 'fldWSVBivNEzAaTmV', // formula
        // Strategy page — 9/3/1-year targets + measurables
        nineYearTarget:   'flduYqMW1Lq36fmL1',  // richText
        threeYearTarget:  'fldd1kPbyy7chW1DF',  // richText
        threeYearMeas:    ['flddkmWwi3d2Fbc26','fldj2bxU8eb6qwdY9','fldJKthrRxJuZ0GU7'],
        oneYearTarget:    'fldFQ3s2fNKb248U0',  // richText
        oneYearMeas:      ['fld3RZ5CEPdLMniSi','fldOEdOxwKDpuSJCI','fldxmn6Omfd7nJjDu'],
        // Quarterly projects 1–3
        quarterlyProjects: ['fldMRcqBdI6sixquu','fldzTGq0bsvSIch4v','fldWEzLxBkIptAqhq'],
        // Per-QP details that port into Projects OS on sync. Shape matches
        // the Projects table KPI + DoD schema so it's a 1-to-1 map.
        // `linkedProject` (multipleRecordLinks → Projects table) stores a
        // direct reference to the Project record created from this QP, so
        // renames + dedup work by record ID rather than by name matching.
        qpDetails: [
            { kpiName: 'fldqDPdwM8eJDZgD6', kpiUnit: 'fldqtYFUdx2eAYHsh', kpiTarget: 'fldf3FGT4g8G1DBzW', owner: 'fld9HlP2aGAfVfQiE', tracking: 'fld1761Yhl833yC6S', dod: 'fldrepCn9UzSxZYL3', linkedProject: 'fldtBMn2nwhMBEtwh' },
            { kpiName: 'fld9Hh5qXyDluw3vh', kpiUnit: 'fldqxZcM4gLnV1omM', kpiTarget: 'fldxajskhmYwVcdQf', owner: 'fld4ettrzsIiWDTNe', tracking: 'flduqlQ82atGIYo4c', dod: 'fldSA0ZNWdK2NBSjB', linkedProject: 'fldEdCkinxZZuDVw8' },
            { kpiName: 'fldYLzoc9Iir6jUvC', kpiUnit: 'fldGJBh9UWZHpvSLT', kpiTarget: 'fldoInqEnbA89rgpT', owner: 'fldtIZeQi9DhX6KZZ', tracking: 'fldOCQ0WaBvvqiiOc', dod: 'fld3g1grdMSieW8zk', linkedProject: 'fldtQWnYYi9X1dah9' },
        ],
        // Monthly stepping stones — stored as "Q{n}. Month {m}" fields in the Airtable
        // (Airtable field names mix "." and ":" — do not normalise, use the IDs).
        // Access as monthlyStones[projectIndex][monthIndex], 0-based.
        monthlyStones: [
            ['fldA66Xm4zVoClUva','fldP91H4XWknwmlzo','fldglTQ9Ljyba0IqK'], // Project 1: M1, M2, M3
            ['fldBcYzfU8zheE00j','fldr6WW4Xubhe2Vtm','fldqD4uHoPFIfR7Yi'], // Project 2: M1, M2, M3
            ['fldayHcCRQlG3mLxe','fldp1YRY0eGzVJQqU','fldZ87UWBj2NYU9Jl'], // Project 3: M1, M2, M3
        ],
        // Embed URLs surfaced in the top of each page
        strategyPlanEmbed: 'fldIRohvx2Hv6DQ4J',
        orgChartEmbed:     'fldtiPGaxcpsGLP5t',
        companyAdminEmbed: 'fld4wVQyI57SSNPH4',
    };

    // Main Methods table (reusable step library linked from OBJSTRAT.mainMethodLinks)
    const MAIN_METHOD = {
        name:         'fldRphzaAUzBqconG',  // Main Method (primary)
        description:  'fldWDxL9EyS1iaGlf',  // multilineText
        business1:    'fldi4uVOf2NgxiSKy',  // inverse link back to Objective & Strategy
    };

    // Key record IDs
    const SANTANDER_CC_LIMIT = 5500;

    // Budget targets
    const MAINT_TARGET_GBP = 3000;     // £3,000/month maintenance budget
    const WAGES_TARGET_GBP = 1500;     // £1,500/month wages budget
    const CFV_TARGET_GBP = 1500;       // £1,500/month CFV allowance
    const CLEAR_PROFIT_TARGET = 10000; // £10,000/month clear profit after all variable costs

    const REC = {
        santander:         'rec3LiEiifomEHlvy',
        tntZempler:        'recsR9QhRKYwgV8oP',
        lloydsCreditCard:  'recPdnCnL0QvUQOiX',
        americanExpress:   'recjJMy49enwgqWpo',
        santanderCC:       'recwmjHfRZhODkFPV',
        subRentalInc: 'recI8yCstyDP1Nd4b',
        subMaint:     'recWomXYQ3XTgMdrr',
        subOpexLabour:'rec7EdEwWXk2cQ0PG',
        subCOGSLabour:'rec8ArDC6YbfOJydg',
    };

    // Payment status choice IDs
    const PS = {
        tenInPayment:    'sel4I99slfpd7Vc1t',
        tenCFVActioned:  'selmhFXah5Bodgg9x',
        tenCFV:          'sel2mWzsvOd8d8de0',
        costInPayment:   'selGrWUm5NkfcY607',
        costActive:      'selwuotKAoizHJl6z',
        costOverdue:     'selGB3gE7Bg7jKoIS',
        costDueToday:    'selZazCz6gUJJ8Pl8',
        costUpcoming:    'selypOeFtsBePQG1E',
        // Cost Status (New) — clean status field used by the AP Fixed dashboard
        costNewInPayment: 'sel9bem92hq9d0926',
        costNewOverdue:   'selc7o2vZ0szCzzBB',
        costNewInactive:  'sel43EzvHZXeLZbwC',
    };

    let PAT = '';
    let cashflowChartInstance = null;
    let refreshTimer = null;
    let allTransactions = []; // stored globally for invoice cross-referencing
    let allTenancies = [];    // stored globally for CFV tab
    let allTenants = [];      // stored globally for CFV tab (contact details)
    let allCosts = [];        // stored globally for reconciliation
    let allCategories = [];   // Chart of Accounts categories
    let allSubCategories = []; // Chart of Accounts sub-categories
    let allBusinesses = [];   // Business entities
    let allAccounts = [];     // Bank/credit-card account records — used by sync-bar health checks
    let allRentalUnits = [];  // Rental unit records — used by sync-bar health checks

