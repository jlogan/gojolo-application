/**
 * Verifies Bill roster CSV helpers (mirrors src/lib/rosterCsv.selfcheck.ts).
 * Run: npm run verify:roster-csv
 */

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizeName(value) {
  return value.trim().replace(/\s+/g, ' ').toUpperCase()
}

function parseGenderField(raw) {
  const cleaned = raw.trim().replace(/^#/, '')
  const match = cleaned.match(/[MF]/i)
  if (!match) return null
  return match[0].toUpperCase()
}

function parseDob(raw) {
  const value = raw.trim()
  if (!value) return null
  if (/^\d{8}$/.test(value)) {
    const y = value.slice(0, 4)
    const m = value.slice(4, 6)
    const d = value.slice(6, 8)
    return `${y}-${m}-${d}`
  }
  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashMatch) {
    const mm = String(Number(slashMatch[1])).padStart(2, '0')
    const dd = String(Number(slashMatch[2])).padStart(2, '0')
    return `${slashMatch[3]}-${mm}-${dd}`
  }
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) return value
  return null
}

function dobToMatchKeySegment(isoDate) {
  if (!isoDate) return ''
  return isoDate.replace(/-/g, '')
}

function buildMatchKey(gender, firstName, lastName, isoDateOfBirth) {
  return [gender, normalizeName(firstName), normalizeName(lastName), dobToMatchKeySegment(isoDateOfBirth)].join('|')
}

function parseSchoolYear(raw) {
  const value = raw.trim()
  if (!value) return null
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n === -10) return null
  return n
}

function normalizeTShirtCode(raw) {
  const codes = new Set(['YXS', 'YS', 'YM', 'YL', 'YXL', 'AXS', 'AS', 'AM', 'AL', 'AXL', 'A2X', 'A3X', 'A4X', 'NS'])
  const code = raw.trim().toUpperCase()
  if (!code) return null
  return codes.has(code) ? code : null
}

assert(parseGenderField('#M') === 'M', 'parseGenderField #M')
assert(parseGenderField('12F') === 'F', 'parseGenderField 12F')
assert(parseDob('20050315') === '2005-03-15', 'parseDob YYYYMMDD')
assert(parseDob('3/15/2005') === '2005-03-15', 'parseDob M/D/YYYY')
assert(buildMatchKey('M', 'Jane', 'Doe', '2005-03-15') === 'M|JANE|DOE|20050315', 'buildMatchKey')
assert(parseSchoolYear('-10') === null, 'parseSchoolYear undefined')
assert(parseSchoolYear('10') === 10, 'parseSchoolYear sophomore')
assert(normalizeTShirtCode('am') === 'AM', 'normalizeTShirtCode')
assert(normalizeTShirtCode('XXL') === null, 'normalizeTShirtCode invalid')

const billSample = [
  '#M|F,LAST NAME,FIRST NAME,MI,NOT USED,DOB,SCHOOL YEAR,STREET,CITY,STATE,ZIP,HOME PHONE,WORK PHONE,E-MAIL ADDRESS,T-SHIRT SIZE',
  'M,Davenport,Brycen,,,2008-11-28,9,,,NA,,,,,AM',
  'M,Sturdavant,Jordan,,,2008-02-20,-10,,,NA,,,,,AS',
].join('\n')

// Minimal smoke test mirrors the real Bill CSV sample: ISO DOB, -10 undefined grade, NA state sentinel.
const rows = billSample.trim().split(/\r?\n/).slice(1)
assert(rows.length === 2, 'Bill sample row count')
assert(parseDob(rows[0].split(',')[5]) === '2008-11-28', 'Bill sample ISO DOB')
assert(buildMatchKey('M', 'Brycen', 'Davenport', '2008-11-28') === 'M|BRYCEN|DAVENPORT|20081128', 'Bill sample match key')
assert(parseSchoolYear(rows[1].split(',')[6]) === null, 'Bill sample undefined grade')

console.log('PASS: roster CSV verification')
