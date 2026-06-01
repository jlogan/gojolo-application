import { useState, useEffect } from 'react'
import { Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import {
  LayoutGrid,
  MessageSquare,
  Users,
  Building2,
  Inbox,
  LogOut,
  Menu,
  X,
  User,
  Shield,
  FolderKanban,
  Plus,
  Clock,
  Target,
  FileText,
} from 'lucide-react'
import Dashboard from '@/pages/Dashboard'
import Profile from '@/pages/Profile'
import Admin from '@/pages/Admin'
import OrgSettings from '@/pages/OrgSettings'
import OrganizationsList from '@/pages/OrganizationsList'
import ContactsList from '@/pages/contacts/ContactsList'
import ContactDetail from '@/pages/contacts/ContactDetail'
import ContactForm from '@/pages/contacts/ContactForm'
import CompanyDetail from '@/pages/companies/CompanyDetail'
import CompanyForm from '@/pages/companies/CompanyForm'
import { supabase } from '@/lib/supabase'
import ChatView from '@/pages/ChatView'
import NotificationBell from '@/components/NotificationBell'
import InboxPage from '@/pages/Inbox'
import ProjectsList from '@/pages/projects/ProjectsList'
import ProjectDetail from '@/pages/projects/ProjectDetail'
import ProjectForm from '@/pages/projects/ProjectForm'
import TaskDetail from '@/pages/projects/TaskDetail'
import Timesheets from '@/pages/Timesheets'
import LeadsList from '@/pages/leads/LeadsList'
import LeadForm from '@/pages/leads/LeadForm'
import LeadDetail from '@/pages/leads/LeadDetail'
import InvoicesList from '@/pages/invoices/InvoicesList'
import InvoiceForm from '@/pages/invoices/InvoiceForm'
import InvoiceDetail from '@/pages/invoices/InvoiceDetail'
// Expenses module hidden for now — tables remain in DB for future use

type AppMode = 'software' | 'chat'

const NAV = [
  { to: '/', label: 'Home', icon: LayoutGrid, testId: 'nav-home' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, testId: 'nav-inbox' },
  { to: '/projects', label: 'Projects', icon: FolderKanban, testId: 'nav-projects' },
  { to: '/leads', label: 'Leads', icon: Target, testId: 'nav-leads' },
  { to: '/timesheets', label: 'Timesheets', icon: Clock, testId: 'nav-timesheets' },
  { to: '/invoices', label: 'Invoices', icon: FileText, testId: 'nav-invoices' },
  { to: '/contacts', label: 'Contacts', icon: Users, testId: 'nav-contacts' },
]

const VENDOR_NAV = [
  { to: '/projects', label: 'Projects', icon: FolderKanban, testId: 'nav-projects' },
  { to: '/timesheets', label: 'Timesheets', icon: Clock, testId: 'nav-timesheets' },
  { to: '/invoices', label: 'Bills', icon: FileText, testId: 'nav-bills' },
]

export default function AppShell() {
  const { signOut } = useAuth()
  const { currentOrg, isPlatformAdmin, isOrgAdmin, isVendor } = useOrg()
  const location = useLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<AppMode>(() => {
    const m = localStorage.getItem('jolo_app_mode') as AppMode | null
    return m === 'chat' ? 'chat' : 'software'
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [chatProjects, setChatProjects] = useState<{ id: string; name: string }[]>([])
  const [chatSessions, setChatSessions] = useState<{ id: string; title: string | null; project_id: string | null; updated_at: string }[]>([])
  const [showAllProjects, setShowAllProjects] = useState(false)

  useEffect(() => {
    if (!currentOrg?.id || mode !== 'chat') return
    supabase.from('projects').select('id, name').eq('org_id', currentOrg.id).order('updated_at', { ascending: false }).limit(20)
      .then(({ data }) => setChatProjects((data as { id: string; name: string }[]) ?? []))
    supabase.from('chat_sessions').select('id, title, project_id, updated_at').eq('org_id', currentOrg.id).order('updated_at', { ascending: false }).limit(20)
      .then(({ data }) => setChatSessions((data ?? []) as { id: string; title: string | null; project_id: string | null; updated_at: string }[]))
  }, [currentOrg?.id, mode])

  useEffect(() => {
    // Ensure mobile drawer closes after navigation.
    setSidebarOpen(false)
  }, [location.pathname])

  const setModeAndStore = (m: AppMode) => {
    setMode(m)
    localStorage.setItem('jolo_app_mode', m)
    if (m === 'chat') navigate('/chat')
    else if (location.pathname === '/chat') navigate('/')
  }

  return (
    <div className="flex h-screen bg-surface overflow-hidden" data-testid="app-shell">
      {/* Sidebar - desktop always visible in software mode; drawer on mobile */}
      <aside
        className={`
          shrink-0 flex flex-col bg-surface-elevated border-r border-border
          w-64
          md:relative
          fixed inset-y-0 left-0 z-40 transform transition-transform duration-200 ease-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        data-testid="sidebar"
      >
        <div className="flex items-center justify-between h-14 px-4 border-b border-border shrink-0">
          <Link to="/" className="font-semibold text-white" data-testid="logo">
            jolo
          </Link>
          <button
            type="button"
            className="md:hidden p-2 rounded-lg hover:bg-surface-muted"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode switcher */}
        <div className="px-3 py-2 border-b border-border">
          <div className="flex rounded-lg bg-surface-muted p-1" role="tablist" data-testid="mode-switcher">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'software'}
              onClick={() => setModeAndStore('software')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === 'software' ? 'bg-surface-elevated text-white shadow' : 'text-gray-400 hover:text-gray-200'
              }`}
              data-testid="mode-software"
            >
              <LayoutGrid className="w-4 h-4 shrink-0" />
              Software
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'chat'}
              onClick={() => setModeAndStore('chat')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === 'chat' ? 'bg-surface-elevated text-white shadow' : 'text-gray-400 hover:text-gray-200'
              }`}
              data-testid="mode-chat"
            >
              <MessageSquare className="w-4 h-4 shrink-0" />
              Chat
            </button>
          </div>
        </div>

        {mode === 'software' && (
          <nav className="flex-1 overflow-y-auto py-2">
            <ul className="space-y-0.5 px-2">
              {(isVendor ? VENDOR_NAV : NAV).map(({ to, label, icon: Icon, testId }) => (
                <li key={to}>
                  <Link
                    to={to}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      location.pathname === to || (to !== '/' && location.pathname.startsWith(to))
                        ? 'bg-surface-muted text-white'
                        : 'text-gray-400 hover:bg-surface-muted hover:text-gray-200'
                    }`}
                    data-testid={testId}
                    onClick={() => {
                      if (to === '/inbox') console.log('[Inbox:nav] sidebar nav Inbox link click', { from: location.pathname })
                      setSidebarOpen(false)
                    }}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {label}
                  </Link>
                </li>
              ))}
              {/* Settings removed per feedback - consolidated under Admin */}
            </ul>
          </nav>
        )}

        {mode === 'chat' && (
          <nav className="flex-1 overflow-y-auto py-2 px-2" aria-label="Chat sidebar">
            {/* New chat button */}
            <button type="button" onClick={() => navigate('/chat')}
              className="w-full flex items-center gap-2 px-3 py-2.5 mb-2 rounded-lg border border-dashed border-border text-sm text-gray-400 hover:text-accent hover:border-accent/50 transition-colors">
              <Plus className="w-4 h-4" /> New chat
            </button>

            {/* Projects */}
            <div className="mb-3">
              <p className="px-3 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider">Projects</p>
              {chatProjects.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-400">No projects yet.</p>
              ) : (
                <>
                  {(showAllProjects ? chatProjects : chatProjects.slice(0, 5)).map(p => (
                    <Link key={p.id} to={`/projects/${p.id}`} onClick={() => setSidebarOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-surface-muted hover:text-gray-200 transition-colors">
                      <FolderKanban className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{p.name}</span>
                    </Link>
                  ))}
                  {chatProjects.length > 5 && (
                    <button type="button" onClick={() => setShowAllProjects(!showAllProjects)}
                      className="px-3 py-1 text-xs text-gray-500 hover:text-accent">
                      {showAllProjects ? 'Show less' : `Show ${chatProjects.length - 5} more…`}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Previous chats */}
            <div>
              <p className="px-3 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider">Previous chats</p>
              {chatSessions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-400">No previous chats.</p>
              ) : (
                chatSessions.map(s => (
                  <button key={s.id} type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-surface-muted hover:text-gray-200 transition-colors text-left">
                    <MessageSquare className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{s.title ?? 'Untitled chat'}</span>
                  </button>
                ))
              )}
            </div>
          </nav>
        )}

        {/* Org / Workspace link, then Admin, Profile, Sign out */}
        <div className="border-t border-border p-2 space-y-0.5">
          {!isVendor && (
            <Link
              to="/organizations"
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-300 hover:bg-surface-muted hover:text-white transition-colors"
              data-testid="nav-organizations"
              title="Organizations"
              onClick={() => setSidebarOpen(false)}
            >
              <Building2 className="w-4 h-4 shrink-0" />
              <span className="truncate">{currentOrg?.name ?? 'Organizations'}</span>
            </Link>
          )}
          {!isVendor && (isPlatformAdmin || isOrgAdmin) && (
            <Link
              to="/admin"
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname === '/admin'
                  ? 'bg-surface-muted text-white'
                  : 'text-gray-400 hover:bg-surface-muted hover:text-gray-200'
              }`}
              data-testid="nav-admin"
              onClick={() => setSidebarOpen(false)}
            >
              <Shield className="w-4 h-4 shrink-0" />
              Admin
            </Link>
          )}
          <Link
            to="/profile"
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              location.pathname === '/profile'
                ? 'bg-surface-muted text-white'
                : 'text-gray-400 hover:bg-surface-muted hover:text-gray-200'
            }`}
            data-testid="nav-profile"
            onClick={() => setSidebarOpen(false)}
          >
            <User className="w-4 h-4 shrink-0" />
            Profile
          </Link>
          <button
            type="button"
            onClick={() => signOut()}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-muted text-sm text-gray-400 hover:text-gray-200"
            data-testid="sign-out"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          aria-hidden
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content or Chat full view */}
      {mode === 'chat' ? (
        <main className="flex-1 flex flex-col min-w-0" data-testid="main-chat">
          <ChatView />
        </main>
      ) : (
        <div className="flex-1 min-w-0 flex flex-col relative">
          <header className="md:hidden sticky top-0 z-20 bg-surface/95 backdrop-blur flex items-center h-14 px-4 border-b border-border shrink-0">
            <button
              type="button"
              className="p-2 rounded-lg hover:bg-surface-muted"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
              data-testid="menu-toggle"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="ml-2 text-sm font-medium text-white truncate flex-1">
              {currentOrg?.name}
            </span>
            <NotificationBell />
          </header>
          <main className="flex-1 overflow-y-auto min-w-0 pb-16 md:pb-0" data-testid="main-content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/contacts" element={<ContactsList />} />
              <Route path="/contacts/new" element={<ContactForm />} />
              <Route path="/contacts/:id" element={<ContactDetail />} />
              <Route path="/contacts/:id/edit" element={<ContactForm />} />
              <Route path="/projects" element={<ProjectsList />} />
              <Route path="/projects/new" element={<ProjectForm />} />
              <Route path="/projects/:id" element={<ProjectDetail />} />
              <Route path="/projects/:id/edit" element={<ProjectForm />} />
              <Route path="/projects/:projectId/tasks/:taskId" element={<TaskDetail />} />
              <Route path="/leads" element={<LeadsList />} />
              <Route path="/leads/new" element={<LeadForm />} />
              <Route path="/leads/:leadId/edit" element={<LeadForm />} />
              <Route path="/leads/:id" element={<LeadDetail />} />
              <Route path="/leads/templates" element={<Navigate to="/admin/resume-templates" replace />} />
              <Route path="/timesheets" element={<Timesheets />} />
              <Route path="/invoices" element={<InvoicesList />} />
              <Route path="/invoices/new" element={<InvoiceForm />} />
              <Route path="/invoices/:id" element={<InvoiceDetail />} />
              <Route path="/invoices/:id/edit" element={<InvoiceForm />} />
              <Route path="/companies" element={<Navigate to="/contacts?tab=companies" replace />} />
              <Route path="/companies/new" element={<CompanyForm />} />
              <Route path="/companies/:id" element={<CompanyDetail />} />
              <Route path="/companies/:id/edit" element={<CompanyForm />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/inbox/:threadId" element={<InboxPage />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/settings" element={<OrgSettings />} />
              <Route path="/organizations" element={<OrganizationsList />} />
              <Route path="/admin/*" element={<Admin />} />
            </Routes>
          </main>

          {/* Mobile bottom nav */}
          <nav className="md:hidden fixed bottom-0 left-0 right-0 z-20 border-t border-border bg-surface-elevated/95 backdrop-blur" aria-label="Mobile navigation">
            <ul className="grid h-16" style={{ gridTemplateColumns: `repeat(${(isVendor ? VENDOR_NAV : NAV).length}, minmax(0, 1fr))` }}>
              {(isVendor ? VENDOR_NAV : NAV).map(({ to, label, icon: Icon, testId }) => {
                const active = location.pathname === to || (to !== '/' && location.pathname.startsWith(to))
                return (
                  <li key={`mobile-${to}`}>
                    <Link
                      to={to}
                      data-testid={`${testId}-mobile`}
                      className={`h-full w-full flex flex-col items-center justify-center gap-1 text-[11px] transition-colors ${
                        active ? 'text-accent' : 'text-gray-400 hover:text-gray-200'
                      }`}
                      onClick={() => { if (to === '/inbox') console.log('[Inbox:nav] mobile nav Inbox link click', { from: location.pathname }) }}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate max-w-[70px]">{label}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
        </div>
      )}
    </div>
  )
}

