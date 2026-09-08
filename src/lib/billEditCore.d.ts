export const BILL_OPEN_STATUSES: readonly string[]

export function isBillOpenStatus(status: string): boolean
export function roundMoney(value: number): number

export function canEditOpenBill(input: {
  isOrgAdmin: boolean
  isVendor: boolean
  direction: string | null | undefined
  orgId: string | null | undefined
  currentOrgId: string | null | undefined
  status: string | null | undefined
}): boolean

export function computeBillLineAmounts(
  quantity: number,
  unitPrice: number,
  taxAmount?: number | null,
): { subtotal: number; total: number }

export function computeBillEditPreviewTotal(
  lines: Array<{ quantity: number; unit_price: number; tax_amount?: number | null }>,
  options?: { adjustment?: number | null; discountTotal?: number | null; discountType?: string | null; discountValue?: number | null },
): number

export function validateBillEditForm(input: {
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
  discountTotal?: number | null; discountType?: string | null; discountValue?: number | null
  lineTaxAmounts?: Record<string, number | null | undefined>
}):
  | {
      ok: true
      lines: Array<{
        id: string
        description: string
        long_description: string | null
        quantity: number
        unit_price: number
        tax_amount: number
        subtotal: number
        total: number
      }>
      previewTotal: number
    }
  | { ok: false; error: string }

export function assertBillStillEditable(fresh: {
  isOrgAdmin: boolean
  isVendor: boolean
  direction: string | null | undefined
  org_id: string | null | undefined
  status: string | null | undefined
  amount_paid?: number | null | undefined
  currentOrgId: string
}): { ok: true } | { ok: false; error: string }

export function buildBillHeaderUpdatePayload(input: {
  issueDate: string
  periodStart: string
  periodEnd: string
  notes: string
}): {
  issue_date: string
  billing_period_start: string
  billing_period_end: string
  notes: string | null
}

export function buildBillLineUpdatePayloads(
  lines: Array<{
    id: string
    description: string
    long_description: string | null
    quantity: number
    unit_price: number
    tax_amount?: number | null
  }>,
): Array<{
  id: string
  description: string
  long_description: string | null
  quantity: number
  unit_price: number
  subtotal: number
  total: number
}>

export function assertBillEditPayloadInvariants(args: {
  header: Record<string, unknown>
  lines: Array<Record<string, unknown>>
  originalLineIds: string[]
}): { ok: true } | { ok: false; error: string }
