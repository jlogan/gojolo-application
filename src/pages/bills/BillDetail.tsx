import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'

type Bill = {
  id: string
  number: number | null
  prefix: string | null
  status: string
  issue_date: string | null
  paid_date: string | null
  subtotal: number | null
  tax_total: number | null
  adjustment: number | null
  total: number | null
  amount_due: number | null
  notes: string | null
  vendor_user_id: string | null
  billing_period_start: string | null
  billing_period_end: string | null
  billing_source: string | null
  projects: { name: string } | { name: string }[] | null
}

type Item = { id: string; description: string; long_description: string | null; quantity: number; unit_price: number; unit: string | null; total: number; sort_order: number }
type Profile = { id: string; display_name: string | null; email: string | null }

function formatCurrency(amount: number | null | undefined) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(amount ?? 0))
}
function formatDate(date: string | null | undefined) {
  if (!date) return '-'
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function billNumber(bill: Bill) {
  const prefix = (bill.prefix ?? 'BILL-').replace(/-+$/, '')
  return bill.number ? `${prefix}-${String(bill.number).padStart(4, '0')}` : 'Bill'
}
function projectName(projects: Bill['projects']) {
  if (!projects) return '-'
  return Array.isArray(projects) ? projects[0]?.name ?? '-' : projects.name
}

export default function BillDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { currentOrg, isVendor, isOrgAdmin } = useOrg()
  const { user } = useAuth()
  const [bill, setBill] = useState<Bill | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [vendor, setVendor] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingStatus, setSavingStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!id || !currentOrg?.id || !user?.id) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      let query = supabase
        .from('invoices')
        .select('id, number, prefix, status, issue_date, paid_date, subtotal, tax_total, adjustment, total, amount_due, notes, vendor_user_id, billing_period_start, billing_period_end, billing_source, projects(name)')
        .eq('id', id)
        .eq('org_id', currentOrg.id)
        .eq('direction', 'inbound')
      if (isVendor) query = query.eq('vendor_user_id', user.id)
      const { data, error } = await query.maybeSingle()
      if (cancelled) return
      if (error || !data) {
        setBill(null)
        setItems([])
        setLoading(false)
        return
      }
      const loadedBill = data as unknown as Bill
      setBill(loadedBill)
      const [{ data: itemRows }, { data: vendorRows }] = await Promise.all([
        supabase.from('invoice_items').select('id, description, long_description, quantity, unit_price, unit, total, sort_order').eq('invoice_id', loadedBill.id).order('sort_order'),
        loadedBill.vendor_user_id ? supabase.from('profiles').select('id, display_name, email').eq('id', loadedBill.vendor_user_id).maybeSingle() : Promise.resolve({ data: null }),
      ])
      if (!cancelled) {
        setItems((itemRows ?? []) as Item[])
        setVendor((vendorRows ?? null) as Profile | null)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id, currentOrg?.id, user?.id, isVendor])

  const updateStatus = async (status: string) => {
    if (!bill || !isOrgAdmin) return
    setSavingStatus(status)
    const patch: Record<string, string | null> = { status }
    if (status === 'paid') patch.paid_date = new Date().toISOString().split('T')[0]
    const { error } = await supabase.from('invoices').update(patch).eq('id', bill.id).eq('direction', 'inbound')
    if (!error) setBill({ ...bill, status, paid_date: patch.paid_date ?? bill.paid_date })
    setSavingStatus(null)
  }

  if (loading) return <div className="p-6 text-gray-400">Loading bill...</div>
  if (!bill) {
    return <div className="p-6"><p className="text-gray-300">Bill not found.</p><button onClick={() => navigate('/bills')} className="mt-3 text-accent">Back to bills</button></div>
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <Link to="/bills" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white mb-4"><ArrowLeft className="w-4 h-4" /> Back to bills</Link>
      <div className="rounded-lg border border-border bg-surface-elevated p-5 mb-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-white">{billNumber(bill)}</h1>
            <p className="text-sm text-gray-400 mt-1">{vendor?.display_name || vendor?.email || 'Vendor'} / {projectName(bill.projects)}</p>
            <p className="text-sm text-gray-500 mt-1">Period: {formatDate(bill.billing_period_start)} - {formatDate(bill.billing_period_end)}</p>
          </div>
          <div className="text-left md:text-right">
            <div className="text-3xl font-semibold text-white">{formatCurrency(bill.total)}</div>
            <div className="text-sm text-gray-400 capitalize mt-1">{bill.status}</div>
          </div>
        </div>
        {isOrgAdmin && (
          <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-border">
            {bill.status === 'draft' && <button disabled={savingStatus === 'approved'} onClick={() => updateStatus('approved')} className="px-3 py-2 rounded-lg bg-accent text-white text-sm disabled:opacity-50">Approve</button>}
            {bill.status !== 'paid' && bill.status !== 'cancelled' && <button disabled={savingStatus === 'paid'} onClick={() => updateStatus('paid')} className="px-3 py-2 rounded-lg border border-green-500/40 text-green-300 text-sm disabled:opacity-50">Mark paid</button>}
            {bill.status !== 'cancelled' && <button disabled={savingStatus === 'cancelled'} onClick={() => updateStatus('cancelled')} className="px-3 py-2 rounded-lg border border-red-500/40 text-red-300 text-sm disabled:opacity-50">Cancel</button>}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-surface-elevated overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted/70 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left">Description</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Rate</th>
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="px-4 py-3 text-gray-200">
                  <div>{item.description}</div>
                  {item.long_description && <pre className="mt-1 whitespace-pre-wrap text-xs text-gray-500 font-sans">{item.long_description}</pre>}
                </td>
                <td className="px-4 py-3 text-right text-gray-300">{item.quantity} {item.unit ?? ''}</td>
                <td className="px-4 py-3 text-right text-gray-300">{formatCurrency(item.unit_price)}</td>
                <td className="px-4 py-3 text-right text-white">{formatCurrency(item.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-border p-4 space-y-1 text-sm max-w-sm ml-auto">
          <div className="flex justify-between text-gray-400"><span>Subtotal</span><span>{formatCurrency(bill.subtotal)}</span></div>
          <div className="flex justify-between text-gray-400"><span>Adjustments</span><span>{formatCurrency(bill.adjustment)}</span></div>
          <div className="flex justify-between text-white font-semibold text-base pt-2"><span>Total</span><span>{formatCurrency(bill.total)}</span></div>
        </div>
      </div>
    </div>
  )
}
