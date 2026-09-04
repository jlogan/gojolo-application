/**
 * Bill Haynes roster CSV import/export helpers.
 * Columns: #M|F, LAST NAME, FIRST NAME, MI, NOT USED, DOB, SCHOOL YEAR,
 *          STREET, CITY, STATE, ZIP, HOME PHONE, WORK PHONE, E-MAIL ADDRESS, T-SHIRT SIZE
 */

export const BILL_CSV_HEADERS = [
  '#M|F',
  'LAST NAME',
  'FIRST NAME',
  'MI',
  'NOT USED',
  'DOB',
  'SCHOOL YEAR',
  'STREET',
  'CITY',
  'STATE',
  'ZIP',
  'HOME PHONE',
  'WORK PHONE',
  'E-MAIL ADDRESS',
  'T-SHIRT SIZE',
] as const

export type RosterGender = 'M' | 'F'

export type BillCsvRow = {
  gender: RosterGender
  lastName: string
  firstName: string
  middleInitial: string | null
  dateOfBirth: string | null
  schoolYear: number | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  homePhone: string | null
  workPhone: string | null
  email: string | null
  tShirtSize: string | null
}

export type ParsedBillCsvRow = BillCsvRow & {
  lineNumber: number
  matchKey: string
}

export type BillCsvParseError = {
  lineNumber: number
  message: string
}

export type BillCsvParseResult = {
  rows: ParsedBillCsvRow[]
  errors: BillCsvParseError[]
}

export const T_SHIRT_SIZE_CODES = {
  YXS: { label: 'Youth X-Small', sequence: 1, category: 'youth' as const },
  YS: { label: 'Youth Small', sequence: 2, category: 'youth' as const },
  YM: { label: 'Youth Medium', sequence: 3, category: 'youth' as const },
  YL: { label: 'Youth Large', sequence: 4, category: 'youth' as const },
  YXL: { label: 'Youth X-Large', sequence: 5, category: 'youth' as const },
  AXS: { label: 'Adult X-Small', sequence: 6, category: 'adult' as const },
  AS: { label: 'Adult Small', sequence: 7, category: 'adult' as const },
  AM: { label: 'Adult Medium', sequence: 8, category: 'adult' as const },
  AL: { label: 'Adult Large', sequence: 9, category: 'adult' as const },
  AXL: { label: 'Adult X-Large', sequence: 10, category: 'adult' as const },
  A2X: { label: 'Adult 2X-Large', sequence: 11, category: 'adult' as const },
  A3X: { label: 'Adult 3X-Large', sequence: 12, category: 'adult' as const },
  A4X: { label: 'Adult 4X-Large', sequence: 13, category: 'adult' as const },
  NS: { label: 'No Shirt', sequence: 0, category: 'none' as const },
} as const

export type TShirtSizeCode = keyof typeof T_SHIRT_SIZE_CODES

export const UNDEFINED_SCHOOL_YEAR = -10

const SCHOOL_YEAR_LABELS: Record<number, string> = {
  [-10]: 'Undefined',
  1: '1st Grade',
  2: '2nd Grade',
  3: '3rd Grade',
  4: '4th Grade',
  5: '5th Grade',
  6: '6th Grade',
  7: '7th Grade',
  8: '8th Grade',
  9: 'Freshman',
  10: 'Sophomore',
  11: 'Junior',
  12: 'Senior',
}

export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

export function parseGenderField(raw: string): RosterGender | null {
  const cleaned = raw.trim().replace(/^#/, '')
  const match = cleaned.match(/[MF]/i)
  if (!match) return null
  return match[0].toUpperCase() as RosterGender
}

export function formatGenderField(gender: RosterGender): string {
  return gender
}

/** Parse DOB from Bill CSV into ISO date (YYYY-MM-DD) or null. */
export function parseDob(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (/^\d{8}$/.test(value)) {
    const y = value.slice(0, 4)
    const m = value.slice(4, 6)
    const d = value.slice(6, 8)
    return toIsoDate(Number(y), Number(m), Number(d))
  }

  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashMatch) {
    return toIsoDate(Number(slashMatch[3]), Number(slashMatch[1]), Number(slashMatch[2]))
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
  }

  return null
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (
    dt.getUTCFullYear() !== year
    || dt.getUTCMonth() !== month - 1
    || dt.getUTCDate() !== day
  ) {
    return null
  }
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

/** Format ISO date for Bill CSV export (YYYY-MM-DD, matching Bill's sample). */
export function formatDob(isoDate: string | null): string {
  if (!isoDate) return ''
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return ''
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** YYYYMMDD segment used in roster match keys. */
export function dobToMatchKeySegment(isoDate: string | null): string {
  if (!isoDate) return ''
  return isoDate.replace(/-/g, '')
}

export function buildMatchKey(
  gender: RosterGender,
  firstName: string,
  lastName: string,
  isoDateOfBirth: string | null,
): string {
  return [
    gender,
    normalizeName(firstName),
    normalizeName(lastName),
    dobToMatchKeySegment(isoDateOfBirth),
  ].join('|')
}

export function parseSchoolYear(raw: string): number | null {
  const value = raw.trim()
  if (!value) return null
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n === UNDEFINED_SCHOOL_YEAR) return null
  return n
}

export function formatSchoolYear(schoolYear: number | null): string {
  if (schoolYear == null) return String(UNDEFINED_SCHOOL_YEAR)
  return String(schoolYear)
}

export function schoolYearLabel(schoolYear: number | null): string {
  if (schoolYear == null) return SCHOOL_YEAR_LABELS[UNDEFINED_SCHOOL_YEAR]
  return SCHOOL_YEAR_LABELS[schoolYear] ?? `Grade ${schoolYear}`
}

export function normalizeTShirtCode(raw: string): TShirtSizeCode | null {
  const code = raw.trim().toUpperCase()
  if (!code) return null
  return code in T_SHIRT_SIZE_CODES ? (code as TShirtSizeCode) : null
}

export function isValidTShirtCode(code: string | null | undefined): code is TShirtSizeCode {
  if (!code) return false
  return code.toUpperCase() in T_SHIRT_SIZE_CODES
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function isHeaderRow(fields: string[]): boolean {
  const normalized = fields.map(f => f.trim().toUpperCase())
  return normalized.includes('LAST NAME') && normalized.includes('FIRST NAME')
}

function normalizeNullableField(
  raw: string,
  options: { nullSentinels?: string[] } = {},
): string | null {
  const value = raw.trim()
  if (!value) return null
  const upper = value.toUpperCase()
  if ((options.nullSentinels ?? []).some(sentinel => sentinel.toUpperCase() === upper)) return null
  return value
}

function rowFromFields(fields: string[], lineNumber: number): { row?: ParsedBillCsvRow; error?: BillCsvParseError } {
  while (fields.length < BILL_CSV_HEADERS.length) fields.push('')

  const gender = parseGenderField(fields[0] ?? '')
  if (!gender) {
    return { error: { lineNumber, message: 'Invalid or missing gender (expected M or F)' } }
  }

  const lastName = (fields[1] ?? '').trim()
  const firstName = (fields[2] ?? '').trim()
  if (!lastName || !firstName) {
    return { error: { lineNumber, message: 'First name and last name are required' } }
  }

  const middleInitial = (fields[3] ?? '').trim() || null
  const dateOfBirth = parseDob(fields[5] ?? '')
  if (!dateOfBirth) {
    return { error: { lineNumber, message: 'Invalid or missing DOB (required for roster matching)' } }
  }
  const schoolYearRaw = fields[6] ?? ''
  const schoolYear = parseSchoolYear(schoolYearRaw)
  if (schoolYearRaw.trim() && schoolYearRaw.trim() !== String(UNDEFINED_SCHOOL_YEAR) && schoolYear == null) {
    return { error: { lineNumber, message: `Invalid school year: ${schoolYearRaw.trim()}` } }
  }

  const tShirtRaw = (fields[14] ?? '').trim()
  const tShirtSize = tShirtRaw ? normalizeTShirtCode(tShirtRaw) : null
  if (tShirtRaw && !tShirtSize) {
    return { error: { lineNumber, message: `Invalid t-shirt size code: ${tShirtRaw}` } }
  }

  const row: ParsedBillCsvRow = {
    gender,
    lastName,
    firstName,
    middleInitial,
    dateOfBirth,
    schoolYear,
    street: (fields[7] ?? '').trim() || null,
    city: (fields[8] ?? '').trim() || null,
    state: normalizeNullableField(fields[9] ?? '', { nullSentinels: ['NA', 'N/A'] }),
    zip: (fields[10] ?? '').trim() || null,
    homePhone: (fields[11] ?? '').trim() || null,
    workPhone: (fields[12] ?? '').trim() || null,
    email: (fields[13] ?? '').trim() || null,
    tShirtSize,
    lineNumber,
    matchKey: buildMatchKey(gender, firstName, lastName, dateOfBirth),
  }

  return { row }
}

export function parseBillCsv(text: string): BillCsvParseResult {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const rows: ParsedBillCsvRow[] = []
  const errors: BillCsvParseError[] = []
  const seenMatchKeys = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1
    if (!line.trim()) continue

    const fields = parseCsvLine(line)
    if (isHeaderRow(fields)) continue

    const result = rowFromFields(fields, lineNumber)
    if (result.error) errors.push(result.error)
    else if (result.row) {
      const firstSeenLine = seenMatchKeys.get(result.row.matchKey)
      if (firstSeenLine) {
        errors.push({
          lineNumber,
          message: `Duplicate roster match key also found on line ${firstSeenLine}`,
        })
      } else {
        seenMatchKeys.set(result.row.matchKey, lineNumber)
        rows.push(result.row)
      }
    }
  }

  return { rows, errors }
}

export function billCsvRowToFields(row: BillCsvRow): string[] {
  return [
    formatGenderField(row.gender),
    row.lastName,
    row.firstName,
    row.middleInitial ?? '',
    '',
    formatDob(row.dateOfBirth),
    formatSchoolYear(row.schoolYear),
    row.street ?? '',
    row.city ?? '',
    row.state ?? '',
    row.zip ?? '',
    row.homePhone ?? '',
    row.workPhone ?? '',
    row.email ?? '',
    row.tShirtSize ?? '',
  ]
}

export function serializeBillCsv(rows: BillCsvRow[]): string {
  const header = BILL_CSV_HEADERS.join(',')
  const body = rows.map(row => billCsvRowToFields(row).map(escapeCsvField).join(','))
  return [header, ...body].join('\n')
}

export type RosterMemberRecord = BillCsvRow & {
  id: string
  matchKey: string
}

export function rosterMemberToBillCsvRow(member: {
  gender: string
  first_name: string
  last_name: string
  middle_initial: string | null
  date_of_birth: string | null
  school_year: number | null
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
  home_phone: string | null
  work_phone: string | null
  email: string | null
  t_shirt_size_code: string | null
  match_key: string
  id: string
}): RosterMemberRecord {
  return {
    id: member.id,
    matchKey: member.match_key,
    gender: member.gender as RosterGender,
    lastName: member.last_name,
    firstName: member.first_name,
    middleInitial: member.middle_initial,
    dateOfBirth: member.date_of_birth,
    schoolYear: member.school_year,
    street: member.street,
    city: member.city,
    state: member.state,
    zip: member.zip,
    homePhone: member.home_phone,
    workPhone: member.work_phone,
    email: member.email,
    tShirtSize: member.t_shirt_size_code,
  }
}

export function billCsvRowToDbPayload(projectId: string, row: ParsedBillCsvRow) {
  return {
    project_id: projectId,
    gender: row.gender,
    first_name: row.firstName,
    last_name: row.lastName,
    middle_initial: row.middleInitial,
    date_of_birth: row.dateOfBirth,
    school_year: row.schoolYear,
    street: row.street,
    city: row.city,
    state: row.state,
    zip: row.zip,
    home_phone: row.homePhone,
    work_phone: row.workPhone,
    email: row.email?.toLowerCase() ?? null,
    t_shirt_size_code: row.tShirtSize,
    match_key: row.matchKey,
    updated_at: new Date().toISOString(),
  }
}

export function downloadBillCsv(filename: string, rows: BillCsvRow[]): void {
  const content = serializeBillCsv(rows)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
