// ══════════════════════════════════════════
// CONFIG — Constants, Table IDs, Field IDs, Budget Targets
// ══════════════════════════════════════════
    // ── Config ──
    const BASE_ID = 'appnqjDpqDniH3IRl';
    const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

    // ── Page & SOP Version Registry ──
    const PAGE_REGISTRY = [
        { id: 'overview',    name: 'Leadership Dashboard',           icon: '📊', pageVer: '2.5', sopFile: 'sop.html',                   sopVer: '2.3', standalone: 'index.html#overview' },
        { id: 'cfv',        name: 'CFVs',                          icon: '🚨', pageVer: '1.4', sopFile: 'sop-cfvs.html',               sopVer: '1.4', standalone: 'index.html#cfv' },
        { id: 'invoices',   name: 'Invoices',                      icon: '🧾', pageVer: '2.0', sopFile: 'sop-invoices.html',           sopVer: '2.0', standalone: 'index.html#invoices' },
        { id: 'pnl',        name: 'Profit & Loss',                 icon: '💰', pageVer: '2.0', sopFile: 'sop-pnl.html',                sopVer: '1.0', standalone: 'index.html#pnl' },
        { id: 'comms',      name: 'Inbound Comms',                 icon: '📨', pageVer: '2.2', sopFile: 'inbound-comms-sop.html',      sopVer: '2.2', standalone: 'follow-up.html' },
        { id: 'compliance', name: 'Property Compliance',            icon: '✅', pageVer: '1.0', sopFile: 'sop-compliance.html',         sopVer: '1.0', standalone: 'compliance.html' },
        { id: 'airtable',   name: 'Contractor Job List',           icon: '🔧', pageVer: '1.0', sopFile: 'sop-contractor-jobs.html',    sopVer: '1.0', standalone: 'index.html#airtable' },
        { id: 'launch-plan', name: 'Operations Director Launch Plan', icon: '🚀', pageVer: '1.0', sopFile: '',                         sopVer: '1.0', standalone: 'index.html#launch-plan' },
        // OS-INTEGRATION: PAGE_REGISTRY entries — DO NOT REMOVE (see MEMORY.md)
        { id: 'os-hub',    name: 'Operating Systems Hub',          icon: '⚙️', pageVer: '1.0', sopFile: 'os/index.html',               sopVer: '1.0', standalone: 'os/index.html' },
        { id: 'os-bplan',  name: 'Business Launch Plan Builder',   icon: '📋', pageVer: '1.0', sopFile: 'os/business-plan-builder/sop.html', sopVer: '1.0', standalone: 'os/business-plan-builder/index.html' },
        // /OS-INTEGRATION: PAGE_REGISTRY
        { id: 'fintable',  name: 'Fintable Sync Monitor',          icon: '🔌', pageVer: '1.0', sopFile: '',                            sopVer: '1.0', standalone: 'index.html#fintable' },
        { id: 'sitemap',    name: 'Site Map & Links',              icon: '🔗', pageVer: '1.1', sopFile: 'sop-sitemap.html',            sopVer: '1.1', standalone: 'index.html#sitemap' },
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
        tasks:         'tblqB8b22hKBL4PF1',
        categories:    'tbleWb8ioptnEwPR8',
        subCategories: 'tblOTdRcPf8AgRz25',
        businesses:    'tblpqkvWJJo8Uu25q',
        invoices:      'tblkOTKIG2Tyiy9aM',
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
    };

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
        costPayStatus:    'fldXZNI96v8HgjuSh',
        costAccountAlias: 'fldX2QMLkSYzDEpIF',
        costInactive:     'fldQJPGLFMbwVelsW',
        costDueDateNext:  'fldQZBF4JzBsmWU87',
        costSubCategory:  'fldRO90pSCj6ahVMC',   // Chart of Accounts - Sub Categories (linked)
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
        txDescription:    'fldsbuAJCTsXHug4C',
        txInvoiceData:    'fldT5qfiyt5DTLrp8',
        txTeamMember:     'fldMwliSwEhLuumvd',
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
        txBusiness:       'fldX1aFlJyzpXGhbF',  // Business (For Reports) (linked)
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

