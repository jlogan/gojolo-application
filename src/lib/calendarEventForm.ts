import {
  addCalendarDays,
  formatCalendarDateInputValue,
  formatCalendarTimeInputValue,
  parseIsoDateParts,
  zonedTimeToUtc,
} from '@/lib/calendarTimezone'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function formDateTimeToMs(date: string, time: string): number {
  const parts = parseIsoDateParts(date)
  const [hourRaw, minuteRaw] = time.split(':').map(Number)
  const hour = hourRaw === 24 ? 0 : hourRaw
  return zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minuteRaw).getTime()
}

export function msToFormDateTime(ms: number): { date: string; time: string } {
  const date = new Date(ms)
  return {
    date: formatCalendarDateInputValue(date),
    time: formatCalendarTimeInputValue(date.toISOString()),
  }
}

export function allDaySpanDays(startDate: string, endDate: string): number {
  const startMs = formDateTimeToMs(startDate, '00:00')
  const endMs = formDateTimeToMs(endDate, '00:00')
  return Math.max(0, Math.round((endMs - startMs) / ONE_DAY_MS))
}

export function addDaysToDateInput(isoDate: string, days: number): string {
  const parts = parseIsoDateParts(isoDate)
  const anchor = zonedTimeToUtc(parts.year, parts.month, parts.day)
  return formatCalendarDateInputValue(addCalendarDays(anchor, days))
}

/** Google Calendar style: preserve timed duration when start moves; fix invalid end <= start. */
export function adjustTimedEndOnStartChange(
  prevStartDate: string,
  prevStartTime: string,
  prevEndDate: string,
  prevEndTime: string,
  newStartDate: string,
  newStartTime: string,
): { endDate: string; endTime: string } {
  const prevStartMs = formDateTimeToMs(prevStartDate, prevStartTime)
  const prevEndMs = formDateTimeToMs(prevEndDate, prevEndTime)
  const durationMs = prevEndMs - prevStartMs

  const newStartMs = formDateTimeToMs(newStartDate, newStartTime)
  let newEndMs = newStartMs + (durationMs > 0 ? durationMs : ONE_HOUR_MS)
  if (newEndMs <= newStartMs) {
    newEndMs = newStartMs + ONE_HOUR_MS
  }

  const nextEnd = msToFormDateTime(newEndMs)
  return { endDate: nextEnd.date, endTime: nextEnd.time }
}

/** Preserve inclusive all-day span when start date moves; ensure end is not before start. */
export function adjustAllDayEndOnStartChange(
  prevStartDate: string,
  prevEndDate: string,
  newStartDate: string,
): { endDate: string } {
  const spanDays = allDaySpanDays(prevStartDate, prevEndDate)
  let endDate = addDaysToDateInput(newStartDate, spanDays)
  if (endDate < newStartDate) {
    endDate = newStartDate
  }
  return { endDate }
}
