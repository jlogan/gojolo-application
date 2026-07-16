export const BILL_PAYMENT_METHODS = [
  { value: 'wise', label: 'Wise' },
  { value: 'paypal', label: 'Paypal' },
  { value: 'ach', label: 'ACH' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'check', label: 'Check' },
  { value: 'other', label: 'Other' },
] as const

export type BillPaymentMethod = (typeof BILL_PAYMENT_METHODS)[number]['value']

export const DEFAULT_BILL_PAYMENT_METHOD: BillPaymentMethod = 'wise'

export function billPaymentMethodLabel(method: string | null | undefined): string {
  if (!method) return '—'
  const found = BILL_PAYMENT_METHODS.find((m) => m.value === method)
  return found?.label ?? method.replace(/_/g, ' ')
}
