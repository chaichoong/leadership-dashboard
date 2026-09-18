// Property Manager Worker — the ONE place this deployable names Airtable IDs.
//
// Every ID here mirrors js/config.js (browser single source) or, for the
// three Tasks fields the shell never needed, os/tasks/index.html. Workers
// cannot read those files, so the copy lives here and
// tests/property-manager-compute.test.js fails the moment an ID drifts from
// the browser copy. Names are needed only inside filterByFormula, which
// cannot take a field ID; reads use returnFieldsByFieldId=true throughout.

export const BASE = 'appnqjDpqDniH3IRl';

export const TABLES = {
  tenancies:     'tblN51a88qTDB6iMH',
  rentalUnits:   'tblM3mZCR5kiEdWMj',
  tenants:       'tblX4elTuu01gwBYh',
  costs:         'tblx5kvhzNEI5TFlS',
  transactions:  'tbln0gzhCAorFc3zB',
  subCategories: 'tblOTdRcPf8AgRz25',
  categories:    'tbleWb8ioptnEwPR8',
  properties:    'tbl6f0OkAmTC2jbuG',
  tasks:         'tblqB8b22hKBL4PF1',
  businesses:    'tblpqkvWJJo8Uu25q',
};

export const F = {
  // Tenancies
  tenPayStatus:    'fldxU3dPUnbK0SCDq', // Payment Status (Unified)
  tenRent:         'fldDMyfZLFMeONPq8', // Expected Monthly Rent
  tenDueDay:       'fldhy2U0CQmM2oS4P', // Due Day of Month
  tenPayFreq:      'fld5O24mC8vOezjXK', // Payment Frequency
  tenSurname:      'fldOXazTqBWieEOK2', // Tenant Surname (rollup)
  tenUnitRef:      'fldql2nyQlPfkPP4p', // Unit Reference (lookup)
  tenProperty:     'fldxfIa0W1nqCbLo2', // Property (lookup)
  tenStatus:       'fldgWAyha1Uij1SZP', // Status (rollup from Tenants)
  tenEndDate:      'fldwHhhKAq4f1nY9e', // Tenancy End Date
  tenLinkedTenant: 'fld1i5bDoHL3B6rUf', // Customers (link → Tenants)
  tenUnit:         'fld7cjLLEHKAx49OK', // Rental Unit (link)
  tenStartDate:    'fld2rPXwwV8dXb1zF', // Tenancy Start Date
  tenNextDueDate:  'fldSPslO6Wh5IUSK3', // Next Rent Due Date (formula)
  tenPaidThisMonth:'fldSNk1LWWcu517CA', // Paid This Month? (formula 0/1)
  tenDaysOverdue:  'fldrb4NVHdLefslPo', // Number of Days Overdue (formula)
  // Rental Units
  unitStatus:      'fldBvqysXBm9rIm0E', // Unit Status
  unitPropName:    'fld7NBHkhjqfbcxk7', // Property Name (Short) (lookup)
  unitName:        'fldr8sliyu8h2jw9t', // Rental Unit (formula)
  unitType:        'fldsItq0vU3sHv7n9', // Unit Type (Room | Flat-Let | Flat | Whole Property)
  // Tenants
  tenantPayType:   'fldZbrk8Xw5Dcwxhi', // Rent Payment Type
  tenantName:      'fldxBKW7QnujSDWqA', // Tenant Name
  tenantPhone:     'fldraHUkWfqo4olLF', // Contact Number
  tenantEmail:     'fldybEduFY3DWWTfT', // Email Address
  tenantStatus:    'fldAXzP9SGIHiAhrv', // Tenant Status
  // Costs
  costName:        'fldS6FYfpkhu6tJG0',
  costExpected:    'fld9JibXkMpTeMcxw', // Expected Cost (monthly equivalent)
  costPayStatus:   'fldXZNI96v8HgjuSh', // Payment Status (LEGACY, the one the app filters on)
  costInactive:    'fldQJPGLFMbwVelsW', // Inactive
  costBusiness:    'fldrPjvdFPCKWqeyd', // Business (link)
  costSubCategory: 'fldRO90pSCj6ahVMC', // Chart of Accounts - Sub Categories (link)
  costCategory:    'fldv3szZSuR2fWBFt', // Chart of Accounts - Categories (link)
  // Transactions
  txDate:          'fldoyQ6Rr9cHp3bgQ', // **Date
  txReportAmount:  'fldot7iisZeL3WrdR', // Report Amount (formula, split-aware)
  txSubCategory:   'fldMRjSVzZVYeHb0A', // Chart of Accounts - Sub Category (link)
  txProperty:      'fldvp44VfF8uTTthp', // Property (link)
  txTenancy:       'fldPmAMmxwqs4SdPa', // Tenancy (link)
  txUnit:          'fldJGIhSbgXNIEW4a', // Unit (link)
  txBusiness:      'fldX1aFlJyzpXGhbF', // Business (For Reports) (link)
  txName:          'fldsbuAJCTsXHug4C', // *Name (bank descriptor)
  txVendor:        'fld0Xr8sboQ0ekJQJ', // *Vendor
  // Chart of Accounts
  subCatName:      'fldO4BTJhFv5EsN6i', // Sub-Categories primary
  catName:         'fldii4oUzSfmplihO', // Category Name (Categories primary)
  // Properties
  propShortName:   'fldqMbR329TNY974G', // Property Name (Short) (formula)
  propName:        'fldy2t735TV5e1DIL', // Property
  // Tasks
  taskName:        'fldgFjGBw6bTKJFCD',
  taskStatus:      'fldx4qCw17UfrKpaN',
  taskAssignee:    'fldELMncVJYPDRJNc', // singleCollaborator
  taskTeamMember:  'flduCtmQGpOA4eWaj', // link → Team Members
  taskDescription: 'fldRGhBQViKZKtkQ6',
  taskNotes:       'fldR7apBzSp3oxFxz',
  taskDueDate:     'fld7XP8w8kbxfETV4',
  taskPriority:    'fldS21RwmwOqt71LI',
  taskPriorityLvl: 'fldSsspLUGqzDqJYz',
  taskMaintenance: 'fldSEUvVA98as1HW6', // Maintenance Ticket (checkbox)
  taskProperties:  'fldZKFvEpJ6NZeFKz', // Properties (link)
  taskContractor:  'fldgmzcr3jHALsdYD', // Contractor (singleSelect)
  taskCompletion:  'fldFOi1SwEKuJRmdN', // Completion Date (stamped by app code)
  taskBusiness:    'fldLu1Y4GzyWcDoxr', // Business (link) — forced to Real Estate on a growth plan task
};

// Field NAMES, used only inside filterByFormula (which cannot take IDs).
export const NAMES = {
  txBusiness: 'Business (For Reports)',
  txDate:     '**Date',
  taskStatus: 'Status',
};

export const REC = {
  subRentalInc:  'recI8yCstyDP1Nd4b', // Rental Income
  subMaint:      'recWomXYQ3XTgMdrr', // COGS Property Reactive Maintenance
  subOpexLabour: 'rec7EdEwWXk2cQ0PG',
  subCOGSLabour: 'rec8ArDC6YbfOJydg',
  bizPersonal:   'reclAPC2vMx2Umuzb',
  bizRealEstate: 'recoGcXRXCniyJsTz',
  roy:           'reclbdjfVev3bqNHS', // Team Members row for Roy Lavin
};

export const ROY_EMAIL = 'roy.lavin1978@gmail.com';
export const REAL_ESTATE_NAME = 'Real Estate';

// Budgets — mirror js/config.js (MAINT_TARGET_GBP, WAGES_TARGET_GBP).
export const MAINT_TARGET_GBP = 1000;
export const WAGES_TARGET_GBP = 1500;

// P&L allow-list — mirrors PNL_SECTIONS in js/pnl.js. Anything outside it is
// dropped, exactly as the P&L tab drops it, so the two totals tie.
export const PNL_SECTIONS = [
  { name: 'Revenue', subs: ['Fixed Income', 'Variable Income', 'Rental Income'] },
  { name: 'Cost of Goods Sold', subs: [
    'COGS Labour', 'COGS Sales Fees', 'COGS Product Costs', 'COGS Delivery Costs',
    'COGS Commission', 'COGS Property Council Tax', 'COGS Property Utilities',
    'COGS Property Reactive Maintenance', 'COGS Property Compliance',
  ] },
  { name: 'Operating Expenses', subs: [
    'Opex Labour', 'Marketing', 'Premises / Overheads', 'Insurance',
    'Software & Subscriptions', 'Professional Fees', 'Travel & Training',
    'Operational Supplies', 'Subsistence', 'Director Discretionary Expenses',
    'Charity', 'Mortgage Interest', 'Loan Interest', 'Bank Transaction Fees', 'Tax',
  ] },
];

// ── Growth Plan (Kevin, 18 Sep 2026) ────────────────────────────────────────
// Roy's Growth Plan tab runs the SAME page as Kevin's, so the Worker reads the same
// seven tables with the same field IDs. These mirror GP in js/config.js; the drift
// guard in tests/property-manager-compute.test.js fails the moment one differs.
export const GP_TABLES = {
  growthPlan:         'tblHqr2kyiL15a8LN',
  growthPlanSettings: 'tbl6hJaGOijdcvRdw',
};

export const GP = {
  plan: {
    title: 'fldbjOfQOnUnpFmkZ', key: 'fldhurLB2tXHqXOdg', lever: 'fldcpnAHgAxQeHAgT',
    property: 'fldYjvuoYHNlumtHd', tenant: 'flduU9L39LqachtLZ', unit: 'flddfpEZqcrxBIlf2',
    monthly: 'fld4Vc3jGATM4d9C4', oneOff: 'fld8wc4N6yYMMy9Bd', effort: 'fldfew0jSmQiB52z8',
    status: 'fldDKDIgcekYZSFp7', evidence: 'fld7DrrXzaTS4Jy6D', notes: 'fldUmCxbSfb4clrjp',
    tasks: 'fldJKJ9XiXSfLT5Vq', adoptedOn: 'fldF6bWNVgMAaaXBc', doneOn: 'fldaNRU9sf1IopbHQ',
  },
  settings: { key: 'fldiyJqkTQ9i2p2Wc', value: 'fldye89gwAzXWDphp', label: 'fldqN8fc8vk8qBeom', note: 'fldRtEN92vZUZKjBU' },
  prop: {
    name: 'fldqMbR329TNY974G', fullName: 'fldy2t735TV5e1DIL', type: 'fldOySSrZBYkOLLTX', beds: 'fldeXUMcC6O4AcvRG',
    agent: 'fldEUrWVhSp3NY8Hh', ctNote: 'fldt7zY1TPihahH6H', area: 'fldYLRz2GgVojKaq9', postcode: 'fld6ebSQgD7eRsobd',
    units: 'fldLoWcv40Ag5sHRF', active: 'fldBUeSJQZZSnFrFW', lettableRooms: 'fldzV9YbHhNUUxwmA', payg: 'fldkBSgcELtpGZhjV',
    ctPayer: 'fldwWcSfkdtSbVhdj', strategy: 'fldivZ9UbAACwv7Yh', plannedExtra: 'fldFd4scZaJsXQ0n7', owner: 'flduloaYTsuvMxvF7',
    ctBand: 'fldNzUqbTNzTeNJqN', ctAnnual: 'fldZsLDNeEvghtFDJ', baselineRent: 'fldfTtL7On1C2OmRU', baselineDate: 'fldp0bTV5uUIQkHh6',
    baselineCt: 'fldFyN175n3TngNtt', movingToSelfManage: 'flddfP8ClsH4JeN2o',
  },
  unit: {
    name: 'fldr8sliyu8h2jw9t', beds: 'fldGMguNbV7GvzsHs', tenants: 'fldQO09UAFRf07V7q', type: 'fldsItq0vU3sHv7n9',
    number: 'fld3nPlpdXSExxDuq', property: 'fldUJNRGgzgyAwwjt', status: 'fldBvqysXBm9rIm0E', incomeType: 'fldPrhfntWO9aHl58',
    lettingStrategy: 'fldcv02tac2Df3JlO', strategy: 'fldMg7hbVvHXXTQet', ctBand: 'fldciMGjBs3h6QAH3',
    baselineRent: 'fldeKsD7Hlsd2chUZ', baselineCt: 'fldh6EFTz8epLPKmU', baselineDate: 'fldRULhlR505Peqlh',
  },
  tenant: {
    name: 'fldxBKW7QnujSDWqA', status: 'fldAXzP9SGIHiAhrv', dob: 'fldv7FKsqXYswyCFE', payType: 'fldZbrk8Xw5Dcwxhi',
    notes: 'fldfwxEf7I3XQDVtR', capExemption: 'fldOOi3d1P4vDedm6', phone: 'fldraHUkWfqo4olLF', email: 'fldybEduFY3DWWTfT',
    ni: 'fld1rHf1qZ60qK95l', dueDay: 'fldWjCUbAOQmTKfFP', over35: 'flddQ2HnQEf4HBeRn', meetingDate: 'fldTz5BU7jxA2mc1B',
    ucPayDay: 'fldjTG9xdCLpbwOwC', household: 'fldjrOSBkhWeFJvVU', otherAdults: 'fldeKCUmwpmWv7pad', idSeen: 'fldbLxdhEqeuUZI4U',
    ucStatementSeen: 'fldfrhDLmb443AmfF', weeklyIncome: 'fldbiAag5eoEW23e0', weeklySpending: 'fldlZr8tUocCYzGPT',
    bankStatements: 'fldZeN4OxwDstqZhy', authoritySigned: 'fldHPe9YQ6GmlrKBt', ctAccount: 'fldlquVIzyesTrI1d',
    meetingNotes: 'fld9IbA3CNxa2KBBE', correctAgreement: 'fldCqe5vCXSPDbGev', proofOfAddress: 'fldfTl5QcGxfIzQ8W',
    rentUplift: 'fld4cGcQbuV2xh2rQ', documents: 'flduPLQdNRKBmsSmr',
  },
  tenancy: { tenants: 'fld1i5bDoHL3B6rUf', unit: 'fld7cjLLEHKAx49OK', rent: 'fldDMyfZLFMeONPq8', actual: 'fldzrqp2fHRaBBnnc', status: 'fldlh5JAeYW2Ei2e6', endDate: 'fldwHhhKAq4f1nY9e' },
  cost: { name: 'fldS6FYfpkhu6tJG0', expected: 'fld9JibXkMpTeMcxw', payStatus: 'fldXZNI96v8HgjuSh', property: 'fld7nikJBPz3BoZJG', frequency: 'fldvozTHvs5VH3lNi' },
};

// What Roy may change from the Growth Plan tab (Kevin's ruling, 18 Sep 2026): work the
// checklist. The four tenant ticks, a move's own Growth Plan row, and a task raised from a
// move. Never a property, a rental unit, a strategy, a band or a frozen starting figure.
export const GP_TICKS = {
  correctAgreement: GP.tenant.correctAgreement,
  proofOfAddress:   GP.tenant.proofOfAddress,
  authoritySigned:  GP.tenant.authoritySigned,
  rentUplift:       GP.tenant.rentUplift,
};
export const GP_UPLIFT_VALUES = ['To do', 'Done', 'Not needed'];
// Attachments are the one tenant field Roy's tab does not carry: uploading a file needs
// its own route through the Worker, so scans stay with Kevin for now (18 Sep 2026).
export const GP_PM_TENANT_OMIT = [GP.tenant.documents];

// The tenant data capture form (Kevin, 18 Sep 2026): Roy fills in what he collects at the
// meeting, field by field. Anything not on this list never reaches Airtable from his page.
export const GP_TENANT_FORM_FIELDS = [
  GP.tenant.dob, GP.tenant.ni, GP.tenant.phone, GP.tenant.email, GP.tenant.idSeen, GP.tenant.over35,
  GP.tenant.ucPayDay, GP.tenant.dueDay, GP.tenant.household, GP.tenant.capExemption, GP.tenant.ucStatementSeen,
  GP.tenant.otherAdults, GP.tenant.ctAccount, GP.tenant.weeklyIncome, GP.tenant.weeklySpending,
  GP.tenant.bankStatements, GP.tenant.authoritySigned, GP.tenant.meetingDate, GP.tenant.meetingNotes,
  GP.tenant.notes,   // the dated line the page stamps when a date of birth is entered
];
export const GP_ROW_STATUS = ['Candidate', 'Adopted', 'In progress', 'Done', 'Dropped'];
export const GP_ROW_FIELDS = Object.values(GP.plan);
export const GP_TASK_FIELDS = [F.taskName, F.taskStatus, F.taskDescription, F.taskDueDate, F.taskPriority, F.taskAssignee, F.taskTeamMember];
// The same filters growth-plan.html uses, so Roy's tab reads the same rows Kevin's does.
export const GP_LIVE_TENANCIES = "{Tenancy Status}='Live'";
export const GP_COST_FILTER = "AND(OR({Payment Status}='In Payment',{Payment Status}='Overdue'),OR(FIND('ouncil',{Cost Name}),FIND(' CT',{Cost Name})),NOT(FIND('Bin',{Cost Name})),NOT(FIND('Debt',{Cost Name})),NOT(FIND('Enforcement',{Cost Name})))";

// Statuses Roy may set from his page. Mirrors STATUS_OPTIONS in os/tasks
// minus Approval (an agent gate, not his) and Overdue (derived from the date).
export const ROY_STATUS_ALLOW = ['Today', 'Upcoming', 'Completed'];
