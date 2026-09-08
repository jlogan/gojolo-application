/**
 * Focused checks for open-bill edit eligibility, validation/calculation,
 * and persistence payload invariants — against the same module the app imports.
 *
 * Run: node scripts/verify-bill-edit.mjs
 * Or:  npm run test:bill-edit
 */
import {
  assertBillEditPayloadInvariants,
  buildBillHeaderUpdatePayload,
  buildBillLineUpdatePayloads,
  canEditOpenBill,
  validateBillEditForm,
} from '../src/lib/billEditCore.mjs'

let passed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

const org = 'org-1'

// --- Eligibility ---
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: false,
    direction: 'inbound',
    orgId: org,
    currentOrgId: org,
    status: 'approved',
  }) === true,
  'admin can edit approved inbound bill in org',
)
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: false,
    direction: 'inbound',
    orgId: org,
    currentOrgId: org,
    status: 'partially_paid',
  }) === true,
  'admin can edit partially_paid inbound bill',
)
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: false,
    direction: 'inbound',
    orgId: org,
    currentOrgId: org,
    status: 'draft',
  }) === false,
  'admin cannot edit draft via open-bill edit',
)
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: false,
    direction: 'inbound',
    orgId: org,
    currentOrgId: org,
    status: 'paid',
  }) === false,
  'admin cannot edit paid bill',
)
assert(
  canEditOpenBill({
    isOrgAdmin: false,
    isVendor: false,
    direction: 'inbound',
    orgId: org,
    currentOrgId: org,
    status: 'approved',
  }) === false,
  'non-admin cannot edit',
)
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: true,
    direction: 'inbound',
    orgId: org,
    currentOrgId: org,
    status: 'approved',
  }) === false,
  'vendor cannot edit even if admin flag weirdly set',
)
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: false,
    direction: 'outbound',
    orgId: org,
    currentOrgId: org,
    status: 'approved',
  }) === false,
  'outbound invoices are not editable via bill edit',
)
assert(
  canEditOpenBill({
    isOrgAdmin: true,
    isVendor: false,
    direction: 'inbound',
    orgId: 'other',
    currentOrgId: org,
    status: 'approved',
  }) === false,
  'org mismatch blocks edit',
)

// --- Validation / calculation ---
const multiOk = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  amountPaid: 0,
  lines: [
    { id: 'l1', description: 'Hours', long_description: 'Task A', quantity: '10', unit_price: '50' },
    { id: 'l2', description: 'Fixed', quantity: 1, unit_price: 100 },
  ],
})
assert(multiOk.ok === true, 'valid multi-line form passes')
assert(multiOk.previewTotal === 600, `preview total expected 600 got ${multiOk.previewTotal}`)
assert(multiOk.lines[0].subtotal === 500, 'line 1 subtotal')
assert(multiOk.lines[0].long_description === 'Task A', 'preserves long description in validation')

const withAdj = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  amountPaid: 0,
  adjustment: -25,
  lines: [{ id: 'l1', description: 'Hours', quantity: 10, unit_price: 50 }],
})
assert(withAdj.ok === true && withAdj.previewTotal === 475, 'preview includes adjustment')

const blockEqualPaid = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  amountPaid: 500,
  lines: [{ id: 'l1', description: 'Hours', quantity: 10, unit_price: 50 }],
})
assert(blockEqualPaid.ok === false, 'total equal to amount paid is rejected')

const blockBelowPaid = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  amountPaid: 400,
  lines: [{ id: 'l1', description: 'Hours', quantity: 5, unit_price: 50 }],
})
assert(blockBelowPaid.ok === false, 'total below amount paid is rejected')

const allowAbovePaid = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  amountPaid: 400,
  lines: [{ id: 'l1', description: 'Hours', quantity: 10, unit_price: 50 }],
})
assert(allowAbovePaid.ok === true && allowAbovePaid.previewTotal === 500, 'total above paid amount allowed')

const badQty = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  amountPaid: 0,
  lines: [{ id: 'l1', description: 'Hours', quantity: 0, unit_price: 50 }],
})
assert(badQty.ok === false, 'zero quantity rejected')

const badPeriod = validateBillEditForm({
  issueDate: '2026-09-01',
  periodStart: '2026-08-31',
  periodEnd: '2026-08-01',
  amountPaid: 0,
  lines: [{ id: 'l1', description: 'Hours', quantity: 1, unit_price: 50 }],
})
assert(badPeriod.ok === false, 'inverted period rejected')

// --- Persistence payload invariants ---
const header = buildBillHeaderUpdatePayload({
  issueDate: '2026-09-01',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  notes: '  note  ',
})
assert(header.notes === 'note', 'notes trimmed')
assert(
  !('status' in header) && !('amount_paid' in header) && !('billing_source' in header) && !('number' in header),
  'header omits identity/payment fields',
)

const linePayloads = buildBillLineUpdatePayloads([
  { id: 'l1', description: ' Hours ', long_description: ' detail ', quantity: 2, unit_price: 75, tax_amount: 0 },
  { id: 'l2', description: 'Fee', long_description: null, quantity: 1, unit_price: 100, tax_amount: 0 },
])
assert(linePayloads[0].subtotal === 150 && linePayloads[0].total === 150, 'line money computed')
assert(linePayloads[0].long_description === 'detail', 'long description trimmed')
assert(!('time_log_ids' in linePayloads[0]) && !('invoice_id' in linePayloads[0]), 'line omits time_log_ids and invoice_id')

const invariantsOk = assertBillEditPayloadInvariants({
  header,
  lines: linePayloads,
  originalLineIds: ['l1', 'l2'],
})
assert(invariantsOk.ok === true, 'valid payloads pass invariants')

const forbidStatus = assertBillEditPayloadInvariants({
  header: { ...header, status: 'paid' },
  lines: linePayloads,
  originalLineIds: ['l1', 'l2'],
})
assert(forbidStatus.ok === false, 'status in header fails invariants')

const forbidNewLine = assertBillEditPayloadInvariants({
  header,
  lines: [
    ...linePayloads,
    { id: 'l3', description: 'x', quantity: 1, unit_price: 1, subtotal: 1, total: 1, long_description: null },
  ],
  originalLineIds: ['l1', 'l2'],
})
assert(forbidNewLine.ok === false, 'added line id fails invariants')

const forbidTimeLogs = assertBillEditPayloadInvariants({
  header,
  lines: [{ ...linePayloads[0], time_log_ids: ['x'] }, linePayloads[1]],
  originalLineIds: ['l1', 'l2'],
})
assert(forbidTimeLogs.ok === false, 'time_log_ids override fails invariants')

const stableIds = linePayloads.map((l) => l.id)
assert(stableIds.join(',') === 'l1,l2', 'stable line ids preserved in update payloads')

assert(assertBillEditPayloadInvariants({ header, lines: [linePayloads[0], linePayloads[0]], originalLineIds: ['l1', 'l2'] }).ok === false, 'duplicate ids rejected')
const percent = validateBillEditForm({ issueDate: '2026-09-01', periodStart: '2026-08-01', periodEnd: '2026-08-31', amountPaid: 460, discountType: 'percent', discountValue: 10, discountTotal: 20, lines: [{ id: 'l1', description: 'Hours', quantity: 10, unit_price: 50 }] })
assert(percent.ok === false, 'fresh percent discount prevents total below paid balance')
assert(canEditOpenBill({ isOrgAdmin: true, isVendor: false, direction: 'inbound', orgId: org, currentOrgId: org, status: 'cancelled' }) === false, 'cancelled bill blocked')
console.log(`verify-bill-edit: ${passed} assertions passed`)
