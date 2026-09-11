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

// Statuses Roy may set from his page. Mirrors STATUS_OPTIONS in os/tasks
// minus Approval (an agent gate, not his) and Overdue (derived from the date).
export const ROY_STATUS_ALLOW = ['Today', 'Upcoming', 'Completed'];
