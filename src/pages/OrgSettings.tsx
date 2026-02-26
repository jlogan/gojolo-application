import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Mail, Phone } from 'lucide-react'

type ImapAccount = {
  id: string
  org_id: string
  label: string | null
  email: string
  host: string | null
  port: number
  is_active: boolean
}

type PhoneNumber = {
  id: string
  org_id: string | null
  phone_number: string
  friendly_name: string | null
  is_active: boolean
}

export default function OrgSettings() {
  const { currentOrg, isOrgAdmin } = useOrg()
  const [imapAccounts, setImapAccounts] = useState<ImapAccount[]>([])
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([])
  const [loading, setLoading] = useState(true)
  const [imapLoading, setImapLoading] = useState(false)
  const [phoneLoading, setPhoneLoading] = useState(false)
  const [imapEmail, setImapEmail] = useState('')
  const [imapLabel, setImapLabel] = useState('')
  const [imapMessage, setImapMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!currentOrg?.id) {
      setLoading(false)
      return
    }
    const load = async () => {
      const [imapRes, phoneRes] = await Promise.all([
        supabase.from('imap_accounts').select('id, org_id, label, email, host, port, is_active').eq('org_id', currentOrg.id),
        supabase.from('phone_numbers').select('id, org_id, phone_number, friendly_name, is_active').eq('org_id', currentOrg.id),
      ])
      setImapAccounts((imapRes.data as ImapAccount[]) ?? [])
      setPhoneNumbers((phoneRes.data as PhoneNumber[]) ?? [])
      setLoading(false)
    }
    load()
  }, [currentOrg?.id])

  const handleAddImap = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!currentOrg?.id || !imapEmail.trim()) return
    setImapLoading(true)
    setImapMessage(null)
    const { data, error } = await supabase
      .from('imap_accounts')
      .insert({
        org_id: currentOrg.id,
        email: imapEmail.trim(),
        label: imapLabel.trim() || null,
      })
      .select('id, org_id, label, email, host, port, is_active')
      .single()
    if (error) {
      setImapMessage(error.message)
    } else {
      setImapAccounts((prev) => [...prev, data as ImapAccount])
      setImapEmail('')
      setImapLabel('')
      setImapMessage('IMAP account added. Credentials can be configured by your admin.')
    }
    setImapLoading(false)
  }

  const togglePhoneActive = async (id: string, is_active: boolean) => {
    if (!currentOrg?.id) return
    setPhoneLoading(true)
    await supabase.from('phone_numbers').update({ is_active }).eq('id', id).eq('org_id', currentOrg.id)
    setPhoneNumbers((prev) => prev.map((p) => (p.id === id ? { ...p, is_active } : p)))
    setPhoneLoading(false)
  }

  if (!isOrgAdmin) {
    return (
      <div className="p-4 md:p-6" data-testid="org-settings-forbidden">
        <p className="text-gray-400 mb-4">Only organization admins can manage these settings.</p>
        <Link to="/" className="text-accent hover:underline text-sm font-medium">
          Back to app
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 text-gray-400 text-sm" data-testid="org-settings-loading">
        Loading…
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl" data-testid="org-settings-page">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 mb-6 font-medium"
        data-testid="org-settings-back"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </Link>

      <h1 className="text-xl font-semibold text-white mb-2">Workspace settings</h1>
      <p className="text-gray-400 text-sm mb-6">
        Configure IMAP accounts for Inbox and turn phone numbers on or off for SMS.
      </p>

      {/* IMAP accounts */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
          <Mail className="w-4 h-4" />
          IMAP accounts
        </h2>
        <p className="text-gray-500 text-sm mb-3">
          Add email accounts to monitor in the Inbox. Credentials are configured securely by your admin.
        </p>
        <form onSubmit={handleAddImap} className="rounded-lg border border-border bg-surface-elevated p-4 mb-3 space-y-3">
          <div>
            <label htmlFor="imap-email" className="block text-xs font-medium text-gray-500 mb-1">
              Email
            </label>
            <input
              id="imap-email"
              type="email"
              value={imapEmail}
              onChange={(e) => setImapEmail(e.target.value)}
              placeholder="inbox@example.com"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
              data-testid="imap-email"
            />
          </div>
          <div>
            <label htmlFor="imap-label" className="block text-xs font-medium text-gray-500 mb-1">
              Label (optional)
            </label>
            <input
              id="imap-label"
              type="text"
              value={imapLabel}
              onChange={(e) => setImapLabel(e.target.value)}
              placeholder="Support inbox"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
            />
          </div>
          {imapMessage && (
            <p className={`text-sm ${imapMessage.includes('added') ? 'text-accent' : 'text-red-400'}`}>{imapMessage}</p>
          )}
          <button
            type="submit"
            disabled={imapLoading || !imapEmail.trim()}
            className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            data-testid="imap-add"
          >
            {imapLoading ? 'Adding…' : 'Add IMAP account'}
          </button>
        </form>
        <div className="rounded-lg border border-border bg-surface-elevated divide-y divide-border">
          {imapAccounts.length === 0 ? (
            <p className="p-4 text-gray-400 text-sm">No IMAP accounts added yet.</p>
          ) : (
            imapAccounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-gray-200 font-medium">{acc.label || acc.email}</p>
                  <p className="text-gray-500 text-xs">{acc.email}</p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${acc.is_active ? 'bg-accent/20 text-accent' : 'bg-gray-600 text-gray-400'}`}>
                  {acc.is_active ? 'On' : 'Off'}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Phone numbers */}
      <section>
        <h2 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
          <Phone className="w-4 h-4" />
          Phone numbers (SMS)
        </h2>
        <p className="text-gray-500 text-sm mb-3">
          Numbers assigned to this workspace. Turn on to include in Inbox.
        </p>
        <div className="rounded-lg border border-border bg-surface-elevated divide-y divide-border">
          {phoneNumbers.length === 0 ? (
            <p className="p-4 text-gray-400 text-sm">No phone numbers assigned to this workspace.</p>
          ) : (
            phoneNumbers.map((pn) => (
              <div key={pn.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-gray-200 font-medium">{pn.friendly_name || pn.phone_number}</p>
                  <p className="text-gray-500 text-xs">{pn.phone_number}</p>
                </div>
                <button
                  type="button"
                  disabled={phoneLoading}
                  onClick={() => togglePhoneActive(pn.id, !pn.is_active)}
                  className={`text-xs px-3 py-1.5 rounded font-medium transition-colors ${
                    pn.is_active
                      ? 'bg-accent/20 text-accent hover:bg-accent/30'
                      : 'bg-surface-muted text-gray-400 hover:bg-surface-muted/80'
                  }`}
                  data-testid={`phone-toggle-${pn.id}`}
                >
                  {pn.is_active ? 'On' : 'Off'}
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
