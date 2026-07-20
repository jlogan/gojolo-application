export type DateRangePreset = 'current-week' | 'last-week' | 'this-month' | 'last-month'

export const DATE_RANGE_PRESETS: { id: DateRangePreset; label: string }[] = [
  { id: 'last-week', label: 'Last Week' },
  { id: 'current-week', label: 'Current Week' },
  { id: 'this-month', label: 'This Month' },
  { id: 'last-month', label: 'Last Month' },
]

/** Format a Date as YYYY-MM-DD in local time (matches HTML date inputs). */
export function toLocalISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Monday-start week boundaries. */
function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfWeek(date: Date): Date {
  const start = startOfWeek(date)
  const end = new Date(start)
  end.setDate(end.getDate() + 6)
  return end
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

export function getDateRangeForPreset(preset: DateRangePreset, today = new Date()): { from: string; to: string } {
  const t = new Date(today)
  t.setHours(0, 0, 0, 0)

  switch (preset) {
    case 'current-week':
      return { from: toLocalISODate(startOfWeek(t)), to: toLocalISODate(endOfWeek(t)) }
    case 'last-week': {
      const lastWeek = new Date(t)
      lastWeek.setDate(lastWeek.getDate() - 7)
      return { from: toLocalISODate(startOfWeek(lastWeek)), to: toLocalISODate(endOfWeek(lastWeek)) }
    }
    case 'this-month':
      return { from: toLocalISODate(startOfMonth(t)), to: toLocalISODate(endOfMonth(t)) }
    case 'last-month': {
      const lastMonth = new Date(t.getFullYear(), t.getMonth() - 1, 1)
      return { from: toLocalISODate(startOfMonth(lastMonth)), to: toLocalISODate(endOfMonth(lastMonth)) }
    }
  }
}

export function detectDateRangePreset(from: string, to: string, today = new Date()): DateRangePreset | null {
  if (!from || !to) return null
  for (const { id } of DATE_RANGE_PRESETS) {
    const range = getDateRangeForPreset(id, today)
    if (range.from === from && range.to === to) return id
  }
  return null
}
