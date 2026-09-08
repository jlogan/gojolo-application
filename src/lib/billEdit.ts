/**
 * Typed re-exports for open-bill edit helpers.
 * Runtime logic lives in billEditCore.mjs so Node tests share the same implementation.
 * Extensionless import so tsc resolves billEditCore.d.ts (`.mjs` imports need `.d.mts`).
 */
export {
  assertBillEditPayloadInvariants,
  assertBillStillEditable,
  buildBillHeaderUpdatePayload,
  buildBillLineUpdatePayloads,
  canEditOpenBill,
  computeBillEditPreviewTotal,
  computeBillLineAmounts,
  roundMoney,
  validateBillEditForm,
} from './billEditCore'

export type BillEditRoleContext = {
  isOrgAdmin: boolean
  isVendor: boolean
}

export type BillEditEligibilityInput = {
  direction: string | null | undefined
  orgId: string | null | undefined
  currentOrgId: string | null | undefined
  status: string | null | undefined
} & BillEditRoleContext

export type BillEditLineInput = {
  id: string
  description: string
  long_description: string | null
  quantity: number
  unit_price: number
  tax_amount?: number | null
}

export type BillEditLineComputed = BillEditLineInput & {
  subtotal: number
  total: number
}

export type BillEditValidationInput = {
  issueDate: string
  periodStart: string
  periodEnd: string
  lines: Array<{
    id: string
    description: string
    long_description?: string | null
    quantity: number | string
    unit_price: number | string
  }>
  amountPaid: number
  adjustment?: number | null
  discountTotal?: number | null
  lineTaxAmounts?: Record<string, number | null | undefined>
}

export type BillEditValidationResult =
  | { ok: true; lines: BillEditLineComputed[]; previewTotal: number }
  | { ok: false; error: string }

export type BillHeaderUpdatePayload = {
  issue_date: string
  billing_period_start: string
  billing_period_end: string
  notes: string | null
}

export type BillLineUpdatePayload = {
  id: string
  description: string
  long_description: string | null
  quantity: number
  unit_price: number
  subtotal: number
  total: number
}
