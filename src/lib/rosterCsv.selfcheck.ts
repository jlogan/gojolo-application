/**
 * Typecheckable self-check for roster CSV helpers.
 * Run: npm run verify:roster-csv
 */
import {
  buildMatchKey,
  formatDob,
  formatSchoolYear,
  normalizeTShirtCode,
  parseBillCsv,
  parseDob,
  parseGenderField,
  parseSchoolYear,
  serializeBillCsv,
} from './rosterCsv'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

export function runRosterCsvSelfCheck(): void {
  assert(parseGenderField('#M') === 'M', 'parseGenderField #M')
  assert(parseGenderField('12F') === 'F', 'parseGenderField 12F')
  assert(parseGenderField('f') === 'F', 'parseGenderField f')

  assert(parseDob('20050315') === '2005-03-15', 'parseDob YYYYMMDD')
  assert(parseDob('3/15/2005') === '2005-03-15', 'parseDob M/D/YYYY')
  assert(parseDob('2005-03-15') === '2005-03-15', 'parseDob ISO')

  assert(
    buildMatchKey('M', 'Jane', 'Doe', '2005-03-15') === 'M|JANE|DOE|20050315',
    'buildMatchKey',
  )

  assert(parseSchoolYear('-10') === null, 'parseSchoolYear undefined')
  assert(parseSchoolYear('10') === 10, 'parseSchoolYear sophomore')
  assert(formatSchoolYear(null) === '-10', 'formatSchoolYear null')

  assert(normalizeTShirtCode('am') === 'AM', 'normalizeTShirtCode')
  assert(normalizeTShirtCode('XXL') === null, 'normalizeTShirtCode invalid')

  assert(formatDob('2005-03-15') === '2005-03-15', 'formatDob')

  const sample = [
    'M,Smith,John,A,,2005-03-15,10,123 Main,Anytown,TX,75001,555-0100,,john@example.com,AM',
    'F,Jones,Mary,B,,2006-04-16,-10,456 Oak,Other,CA,90210,,555-0200,mary@example.com,YS',
    'F,Jones,Mary,B,,2006-04-16,-10,456 Oak,Other,CA,90210,,555-0200,mary@example.com,YS',
  ].join('\n')

  const parsed = parseBillCsv(`${serializeBillCsv([]).split('\n')[0]}\n${sample}`)
  assert(parsed.rows.length === 2, 'parseBillCsv row count')
  assert(parsed.errors.length === 1, 'parseBillCsv duplicate error')
  assert(parsed.rows[0]?.matchKey === 'M|JOHN|SMITH|20050315', 'parseBillCsv match key')
  assert(parsed.rows[1]?.schoolYear === null, 'parseBillCsv undefined grade')
}
