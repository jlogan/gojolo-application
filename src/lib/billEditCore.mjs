/** Shared open-bill edit helpers (Node + Vite). Keep free of TS/React imports. */

export const BILL_OPEN_STATUSES = ['approved', 'partially_paid']

export function isBillOpenStatus(status) {
  return BILL_OPEN_STATUSES.includes(status)
}

/** Round to cents the same way CreateBill does. */
export function roundMoney(value) {
  return Math.round(value * 100) / 100
}

export function canEditOpenBill(input) {
  if (!input.isOrgAdmin || input.isVendor) return false
  if (!input.currentOrgId || !input.orgId || input.orgId !== input.currentOrgId) return false
  if (input.direction !== 'inbound') return false
  if (!input.status || !isBillOpenStatus(input.status)) return false
  return true
}

export function computeBillLineAmounts(quantity, unitPrice, taxAmount = 0) {
  const subtotal = roundMoney(quantity * unitPrice)
  const tax = roundMoney(Number(taxAmount ?? 0))
  return { subtotal, total: roundMoney(subtotal + tax) }
}

export function computeBillEditPreviewTotal(lines, options = {}) {
  const itemsSubtotal = lines.reduce((sum, line) => {
    const { subtotal } = computeBillLineAmounts(line.quantity, line.unit_price, line.tax_amount)
    return roundMoney(sum + subtotal)
  }, 0)
  const itemsTax = lines.reduce((sum, line) => roundMoney(sum + Number(line.tax_amount ?? 0)), 0)
  const discount = options.discountType === 'percent'
    ? roundMoney(itemsSubtotal * Number(options.discountValue ?? 0) / 100)
    : roundMoney(Number(options.discountValue ?? options.discountTotal ?? 0))
  const adjustment = roundMoney(Number(options.adjustment ?? 0))
  return roundMoney(itemsSubtotal + itemsTax - discount + adjustment)
}

export function validateBillEditForm(input) {
  if (!input.issueDate) {
    return { ok: false, error: 'Enter an issue date.' }
  }
  if (!input.periodStart || !input.periodEnd) {
    return { ok: false, error: 'Enter the billing period start and end dates.' }
  }
  if (input.periodEnd < input.periodStart) {
    return { ok: false, error: 'Billing period end must be on or after the start date.' }
  }
  if (!input.lines.length) {
    return { ok: false, error: 'Bill must have at least one line item.' }
  }

  const computedLines = []
  for (const line of input.lines) {
    if (!line.id) {
      return { ok: false, error: 'Each line item must keep its existing id.' }
    }
    if (!String(line.description ?? '').trim()) {
      return { ok: false, error: 'Enter a description for every line item.' }
    }
    const qty = typeof line.quantity === 'number' ? line.quantity : parseFloat(String(line.quantity))
    const rate = typeof line.unit_price === 'number' ? line.unit_price : parseFloat(String(line.unit_price))
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: 'Enter a valid quantity greater than zero for every line.' }
    }
    if (!Number.isFinite(rate) || rate < 0) {
      return { ok: false, error: 'Enter a valid rate for every line.' }
    }
    const taxAmount = input.lineTaxAmounts?.[line.id] ?? 0
    const amounts = computeBillLineAmounts(qty, rate, taxAmount)
    const longDescription = line.long_description?.trim() ? line.long_description.trim() : null
    computedLines.push({
      id: line.id,
      description: String(line.description).trim(),
      long_description: longDescription,
      quantity: qty,
      unit_price: rate,
      tax_amount: taxAmount,
      ...amounts,
    })
  }

  const previewTotal = computeBillEditPreviewTotal(
    computedLines.map((line) => ({
      quantity: line.quantity,
      unit_price: line.unit_price,
      tax_amount: line.tax_amount,
    })),
    { adjustment: input.adjustment, discountTotal: input.discountTotal, discountType: input.discountType, discountValue: input.discountValue },
  )

  const amountPaid = roundMoney(Number(input.amountPaid ?? 0))
  if (amountPaid > 0 && previewTotal <= amountPaid) {
    return {
      ok: false,
      error: `Edited total (${previewTotal.toFixed(2)}) must be greater than the amount already paid (${amountPaid.toFixed(2)}).`,
    }
  }

  return { ok: true, lines: computedLines, previewTotal }
}

/** Fresh row checks before save — status may have changed since load. */
export function assertBillStillEditable(fresh) {
  if (!canEditOpenBill({
    isOrgAdmin: fresh.isOrgAdmin,
    isVendor: fresh.isVendor,
    direction: fresh.direction,
    orgId: fresh.org_id,
    currentOrgId: fresh.currentOrgId,
    status: fresh.status,
  })) {
    return { ok: false, error: 'This bill can no longer be edited.' }
  }
  return { ok: true }
}

/** Header fields allowed on open-bill edit. Intentionally omits identity, status, payments, billing_source. */
export function buildBillHeaderUpdatePayload(input) {
  return {
    issue_date: input.issueDate,
    billing_period_start: input.periodStart,
    billing_period_end: input.periodEnd,
    notes: input.notes.trim() || null,
  }
}

/**
 * Per-line update payloads. Does not include time_log_ids, unit, tax_rate_id, or sort_order
 * so those stay stable. Does not delete/reinsert.
 */
export function buildBillLineUpdatePayloads(lines) {
  return lines.map((line) => {
    const amounts = computeBillLineAmounts(line.quantity, line.unit_price, line.tax_amount)
    return {
      id: line.id,
      description: line.description.trim(),
      long_description: line.long_description?.trim() ? line.long_description.trim() : null,
      quantity: line.quantity,
      unit_price: line.unit_price,
      subtotal: amounts.subtotal,
      total: amounts.total,
    }
  })
}

/** Invariants for persistence payloads (used by tests + save path). */
export function assertBillEditPayloadInvariants(args) {
  const forbiddenHeader = [
    'id',
    'number',
    'prefix',
    'org_id',
    'direction',
    'status',
    'billing_source',
    'amount_paid',
    'amount_due',
    'total',
    'subtotal',
    'tax_total',
    'vendor_user_id',
    'project_id',
    'created_by',
  ]
  for (const key of forbiddenHeader) {
    if (Object.prototype.hasOwnProperty.call(args.header, key)) {
      return { ok: false, error: `Header payload must not include ${key}.` }
    }
  }

  const ids = args.lines.map((line) => String(line.id ?? ''))
  if (new Set(ids).size !== ids.length || ids.length !== args.originalLineIds.length) {
    return { ok: false, error: 'Line payload count must match existing lines (no add/remove).' }
  }
  const originalSet = new Set(args.originalLineIds)
  for (const id of ids) {
    if (!originalSet.has(id)) {
      return { ok: false, error: 'Line payload contains an unknown line id.' }
    }
  }
  for (const line of args.lines) {
    if (Object.prototype.hasOwnProperty.call(line, 'time_log_ids')) {
      return { ok: false, error: 'Line payload must not override time_log_ids.' }
    }
    if (Object.prototype.hasOwnProperty.call(line, 'invoice_id')) {
      return { ok: false, error: 'Line payload must not override invoice_id.' }
    }
  }
  return { ok: true }
}
