/** Jay's calendar display timezone — all calendar bucketing and labels use this zone. */
export const CALENDAR_TIMEZONE = 'America/New_York'

export const CALENDAR_TIMEZONE_LABEL = 'Times shown in Eastern time'

export type CalendarDateParts = {
  year: number
  month: number
  day: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export function getPartsInCalendarTz(date: Date): CalendarDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CALENDAR_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

export function calendarDayKey(parts: CalendarDateParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function calendarDayKeyFromDate(date: Date): string {
  return calendarDayKey(getPartsInCalendarTz(date))
}

function getTimezoneOffsetMs(timeZone: string, date: Date): number {
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const toUtcMs = (parts: Intl.DateTimeFormatPart[]) => {
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0'
    return Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      Number(get('hour')),
      Number(get('minute')),
      Number(get('second')),
    )
  }
  return toUtcMs(tzParts) - toUtcMs(utcParts)
}

/** UTC instant for a wall-clock time on a calendar date in the given IANA timezone. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
  timeZone = CALENDAR_TIMEZONE,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const offset = getTimezoneOffsetMs(timeZone, new Date(utcGuess))
  return new Date(utcGuess - offset)
}

export function parseIsoDateParts(isoDate: string): CalendarDateParts {
  const [year, month, day] = isoDate.split('-').map(Number)
  return { year, month, day }
}

export function startOfCalendarDay(date: Date): Date {
  const parts = getPartsInCalendarTz(date)
  return zonedTimeToUtc(parts.year, parts.month, parts.day)
}

export function addCalendarDays(date: Date, days: number): Date {
  const parts = getPartsInCalendarTz(date)
  const anchor = zonedTimeToUtc(parts.year, parts.month, parts.day, 12)
  anchor.setUTCDate(anchor.getUTCDate() + days)
  return startOfCalendarDay(anchor)
}

function dayOfWeekInCalendarTz(date: Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: CALENDAR_TIMEZONE,
    weekday: 'short',
  }).format(date)
  return WEEKDAY_INDEX[weekday] ?? 0
}

export function startOfCalendarWeek(date: Date): Date {
  const parts = getPartsInCalendarTz(date)
  const anchor = zonedTimeToUtc(parts.year, parts.month, parts.day, 12)
  return addCalendarDays(anchor, -dayOfWeekInCalendarTz(anchor))
}

export function startOfCalendarMonth(date: Date): Date {
  const parts = getPartsInCalendarTz(date)
  return zonedTimeToUtc(parts.year, parts.month, 1)
}

export function endOfCalendarMonth(date: Date): Date {
  const parts = getPartsInCalendarTz(date)
  const lastDay = new Date(parts.year, parts.month, 0).getDate()
  return zonedTimeToUtc(parts.year, parts.month, lastDay, 23, 59, 59, 999)
}

export function calendarDaysInMonth(date: Date): Date[] {
  const parts = getPartsInCalendarTz(date)
  const lastDay = new Date(parts.year, parts.month, 0).getDate()
  return Array.from({ length: lastDay }, (_, i) => zonedTimeToUtc(parts.year, parts.month, i + 1))
}

export function sameCalendarDay(a: Date, b: Date): boolean {
  return calendarDayKeyFromDate(a) === calendarDayKeyFromDate(b)
}

export function nowInCalendarTz(): Date {
  return startOfCalendarDay(new Date())
}

const DATE_LABEL_OPTS: Intl.DateTimeFormatOptions = {
  timeZone: CALENDAR_TIMEZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
}

const DAY_HEADING_OPTS: Intl.DateTimeFormatOptions = {
  timeZone: CALENDAR_TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
}

const MONTH_LABEL_OPTS: Intl.DateTimeFormatOptions = {
  timeZone: CALENDAR_TIMEZONE,
  month: 'long',
  year: 'numeric',
}

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  timeZone: CALENDAR_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
}

export function formatCalendarDayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', DATE_LABEL_OPTS)
}

export function formatCalendarDayHeading(date: Date): string {
  return date.toLocaleDateString('en-US', DAY_HEADING_OPTS)
}

export function formatCalendarMonthLabel(date: Date): string {
  return date.toLocaleDateString('en-US', MONTH_LABEL_OPTS)
}

export function formatCalendarEventTime(
  startsAt: string,
  endsAt: string,
  allDay: boolean,
): string {
  if (allDay) return 'All day'
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  return `${start.toLocaleTimeString('en-US', TIME_OPTS)} – ${end.toLocaleTimeString('en-US', TIME_OPTS)}`
}

export function formatCalendarEventStartTime(startsAt: string, allDay: boolean): string {
  if (allDay) return 'All day'
  return new Date(startsAt).toLocaleTimeString('en-US', TIME_OPTS)
}

export function eventCalendarDayKey(startsAt: string, allDay = false): string {
  if (allDay) return startsAt.slice(0, 10)
  return calendarDayKeyFromDate(new Date(startsAt))
}

/** Value for `<input type="date">` in the calendar timezone. */
export function formatCalendarDateInputValue(date: Date): string {
  const parts = getPartsInCalendarTz(date)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** Value for `<input type="time">` in the calendar timezone (24-hour HH:mm). */
export function formatCalendarTimeInputValue(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CALENDAR_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  let hour = get('hour')
  const minute = get('minute')
  // Some Intl implementations emit "24" at midnight instead of "00".
  if (hour === '24') hour = '00'
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

export function resolveCalendarEventEndInstant(startsAt: string, endsAt: string): Date {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  if (Number.isNaN(start.getTime())) return new Date()
  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    return new Date(start.getTime() + 60 * 60 * 1000)
  }
  return end
}
