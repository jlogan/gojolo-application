import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'
import Login from '@/pages/Login'
import WorkspacePicker from '@/pages/WorkspacePicker'
import AppShell from '@/components/AppShell'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface" data-testid="auth-loading">
        <div className="animate-pulse text-surface-muted">Loading…</div>
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

const INBOX_THREAD_PATH = /^\/inbox\/([a-f0-9-]+)$/i

function RequireOrg({ children }: { children: React.ReactNode }) {
  const { currentOrg, loading, memberships, setCurrentOrg } = useOrg()
  const location = useLocation()
  const [resolvingFromUrl, setResolvingFromUrl] = useState(false)
  const [resolveDone, setResolveDone] = useState(false)

  const pathname = location.pathname
  const threadMatch = pathname.match(INBOX_THREAD_PATH)
  const threadId = threadMatch?.[1] ?? null

  useEffect(() => {
    if (!threadId) setResolveDone(false)
  }, [threadId])

  // When no org is selected but URL is /inbox/:threadId, try to resolve org from thread and auto-select
  useEffect(() => {
    if (loading || currentOrg || !threadId || resolveDone) return
    setResolvingFromUrl(true)
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase.from('inbox_threads').select('org_id').eq('id', threadId).maybeSingle()
      if (cancelled) return
      setResolveDone(true)
      setResolvingFromUrl(false)
      const orgId = data?.org_id as string | undefined
      const membership = orgId ? memberships.find((m) => m.org.id === orgId) : null
      if (membership) {
        setCurrentOrg(membership.org)
        return
      }
      // Thread not found or user not in that org: still set first org so we don't force workspace picker
      if (memberships.length > 0) {
        setCurrentOrg(memberships[0].org)
      }
    })()
    return () => { cancelled = true }
  }, [loading, currentOrg, threadId, memberships, setCurrentOrg, resolveDone])

  if (loading || resolvingFromUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface" data-testid="org-loading">
        <div className="animate-pulse text-surface-muted">Loading workspace…</div>
      </div>
    )
  }
  if (!currentOrg) {
    return <Navigate to="/workspace" state={{ from: location }} replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/workspace"
        element={
          <RequireAuth>
            <WorkspacePicker />
          </RequireAuth>
        }
      />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <RequireOrg>
              <AppShell />
            </RequireOrg>
          </RequireAuth>
        }
      />
    </Routes>
  )
}
