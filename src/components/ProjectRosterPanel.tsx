import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Upload, Users, AlertCircle, CheckCircle2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  billCsvRowToDbPayload,
  downloadBillCsv,
  parseBillCsv,
  rosterMemberToBillCsvRow,
  schoolYearLabel,
  type RosterMemberRecord,
} from '@/lib/rosterCsv'

type ProjectRosterPanelProps = {
  projectId: string
}

type ImportSummary = {
  created: number
  updated: number
  skipped: number
  errors: string[]
}

export default function ProjectRosterPanel({ projectId }: ProjectRosterPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [members, setMembers] = useState<RosterMemberRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)

  const fetchRoster = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    const { data, error } = await supabase
      .from('project_roster_members')
      .select('*')
      .eq('project_id', projectId)
      .order('last_name')
      .order('first_name')

    if (error) {
      console.error('Failed to load roster', error)
      setMembers([])
    } else {
      setMembers((data ?? []).map(row => rosterMemberToBillCsvRow(row)))
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    fetchRoster()
  }, [fetchRoster])

  const handleExport = () => {
    downloadBillCsv(`project-roster-${projectId.slice(0, 8)}.csv`, members)
  }

  const handleImportFile = async (file: File) => {
    setImporting(true)
    setImportSummary(null)

    try {
      const text = await file.text()
      const { rows, errors: parseErrors } = parseBillCsv(text)

      if (rows.length === 0 && parseErrors.length === 0) {
        setImportSummary({ created: 0, updated: 0, skipped: 0, errors: ['No roster rows found in file.'] })
        return
      }

      const { data: existingRows, error: fetchError } = await supabase
        .from('project_roster_members')
        .select('match_key')
        .eq('project_id', projectId)

      if (fetchError) {
        setImportSummary({ created: 0, updated: 0, skipped: 0, errors: [fetchError.message] })
        return
      }

      const existingKeys = new Set((existingRows ?? []).map(r => r.match_key as string))
      let created = 0
      let updated = 0
      const upsertErrors: string[] = [...parseErrors.map(e => `Line ${e.lineNumber}: ${e.message}`)]

      for (const row of rows) {
        const payload = billCsvRowToDbPayload(projectId, row)
        const { error } = await supabase
          .from('project_roster_members')
          .upsert(payload, { onConflict: 'project_id,match_key' })

        if (error) {
          upsertErrors.push(`Line ${row.lineNumber}: ${error.message}`)
          continue
        }

        if (existingKeys.has(row.matchKey)) updated++
        else created++
        existingKeys.add(row.matchKey)
      }

      setImportSummary({
        created,
        updated,
        skipped: parseErrors.length,
        errors: upsertErrors,
      })
      await fetchRoster()
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-elevated p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Users className="w-4 h-4" /> Roster ({members.length})
        </h2>
        <div className="flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) void handleImportFile(file)
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted disabled:opacity-50"
            title="Import CSV"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={members.length === 0}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-muted disabled:opacity-50"
            title="Export CSV"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {importSummary && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
          importSummary.errors.length > 0
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
            : 'border-green-500/40 bg-green-500/10 text-green-200'
        }`}>
          <div className="flex items-center gap-1.5 font-medium mb-1">
            {importSummary.errors.length > 0 ? (
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            )}
            Import complete
          </div>
          <p>{importSummary.created} created, {importSummary.updated} updated</p>
          {importSummary.errors.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-amber-100/90 max-h-24 overflow-y-auto">
              {importSummary.errors.slice(0, 8).map(err => (
                <li key={err}>{err}</li>
              ))}
              {importSummary.errors.length > 8 && (
                <li>…and {importSummary.errors.length - 8} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-500">Loading roster…</p>
      ) : members.length === 0 ? (
        <p className="text-xs text-gray-500">No roster members yet. Import a Bill CSV to get started.</p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {members.map(m => (
            <div key={m.id} className="flex items-center justify-between py-1 text-sm gap-2">
              <div className="min-w-0">
                <span className="text-white truncate block">
                  {m.lastName}, {m.firstName}
                  {m.middleInitial ? ` ${m.middleInitial}.` : ''}
                </span>
                <span className="text-[10px] text-gray-500 truncate block">
                  {m.gender}
                  {m.dateOfBirth ? ` · ${m.dateOfBirth}` : ''}
                  {m.schoolYear != null ? ` · ${schoolYearLabel(m.schoolYear)}` : ' · Undefined'}
                  {m.tShirtSize ? ` · ${m.tShirtSize}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
