import { useState } from 'react'
import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import {
  LayoutGrid,
  MessageSquare,
  Users,
  Building2,
  Inbox,
  LogOut,
  ChevronDown,
  Menu,
  X,
  User,
  ArrowLeftRight,
  Shield,
} from 'lucide-react'
import Dashboard from '@/pages/Dashboard'
import Profile from '@/pages/Profile'
import Admin from '@/pages/Admin'
import ContactsList from '@/pages/contacts/ContactsList'
import ContactDetail from '@/pages/contacts/ContactDetail'
import ContactForm from '@/pages/contacts/ContactForm'
import CompaniesList from '@/pages/companies/CompaniesList'
import CompanyDetail from '@/pages/companies/CompanyDetail'
import CompanyForm from '@/pages/companies/CompanyForm'
import ChatView from '@/pages/ChatView'

type AppMode = 'software' | 'chat'

const NAV = [
  { to: '/', label: 'Home', icon: LayoutGrid, testId: 'nav-home' },
  { to: '/contacts', label: 'Contacts', icon: Users, testId: 'nav-contacts' },
  { to: '/companies', label: 'Companies', icon: Building2, testId: 'nav-companies' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, testId: 'nav-inbox' },
]

export default function AppShell() {
  const { signOut } = useAuth()
  const { currentOrg, memberships, setCurrentOrg, isPlatformAdmin } = useOrg()
  const location = useLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<AppMode>(() => {
    const m = localStorage.getItem('jolo_app_mode') as AppMode | null
    return m === 'chat' ? 'chat' : 'software'
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false)

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
              {NAV.map(({ to, label, icon: Icon, testId }) => (
                <li key={to}>
                  <Link
                    to={to}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      location.pathname === to || (to !== '/' && location.pathname.startsWith(to))
                        ? 'bg-surface-muted text-white'
                        : 'text-gray-400 hover:bg-surface-muted hover:text-gray-200'
                    }`}
                    data-testid={testId}
                    onClick={() => setSidebarOpen(false)}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {mode === 'chat' && (
          <nav className="flex-1 overflow-y-auto py-2 px-2" aria-label="Chat sidebar">
            <div className="mb-4">
              <p className="px-3 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider">
                Projects
              </p>
              <p className="px-3 py-2 text-sm text-gray-400" data-testid="chat-projects-empty">
                No projects yet. Chat to create one.
              </p>
            </div>
            <div>
              <p className="px-3 py-1.5 text-xs font-medium text-gray-500 uppercase tracking-wider">
                Previous chats
              </p>
              <p className="px-3 py-2 text-sm text-gray-400" data-testid="chat-history-empty">
                No previous chats.
              </p>
            </div>
          </nav>
        )}

        {/* Org name first, then Admin, Profile, Sign out */}
        <div className="border-t border-border p-2 space-y-0.5">
          {memberships.length > 1 ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setOrgDropdownOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface-muted text-left"
                data-testid="org-switcher"
                title="Switch workspace"
              >
                <ArrowLeftRight className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
                <span className="flex-1 truncate text-sm font-medium text-white">
                  {currentOrg?.name ?? 'No org'}
                </span>
                <ChevronDown className="w-4 h-4 shrink-0 text-gray-400" aria-hidden />
              </button>
              {orgDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    aria-hidden
                    onClick={() => setOrgDropdownOpen(false)}
                  />
                  <ul
                    className="absolute bottom-full left-2 right-2 mb-1 py-1 bg-surface-elevated border border-border rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto"
                    data-testid="org-dropdown"
                  >
                    {memberships.map(({ org }) => (
                      <li key={org.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setCurrentOrg(org)
                            setOrgDropdownOpen(false)
                          }}
                          className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 ${
                            currentOrg?.id === org.id ? 'bg-surface-muted text-white' : 'text-gray-300 hover:bg-surface-muted'
                          }`}
                        >
                          <Building2 className="w-3.5 h-3.5 shrink-0 opacity-70" />
                          {org.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400"
              data-testid="org-current"
              title="Current workspace"
            >
              <Building2 className="w-4 h-4 shrink-0" />
              <span className="truncate font-medium text-gray-300">{currentOrg?.name ?? '—'}</span>
            </div>
          )}
          {isPlatformAdmin && (
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
        <>
          <header className="md:hidden flex items-center h-14 px-4 border-b border-border shrink-0">
            <button
              type="button"
              className="p-2 rounded-lg hover:bg-surface-muted"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
              data-testid="menu-toggle"
            >
              <Menu className="w-5 h-5" />
            </button>
            <span className="ml-2 text-sm font-medium text-white truncate">
              {currentOrg?.name}
            </span>
          </header>
          <main className="flex-1 overflow-y-auto min-w-0" data-testid="main-content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/contacts" element={<ContactsList />} />
              <Route path="/contacts/new" element={<ContactForm />} />
              <Route path="/contacts/:id" element={<ContactDetail />} />
              <Route path="/contacts/:id/edit" element={<ContactForm />} />
              <Route path="/companies" element={<CompaniesList />} />
              <Route path="/companies/new" element={<CompanyForm />} />
              <Route path="/companies/:id" element={<CompanyDetail />} />
              <Route path="/companies/:id/edit" element={<CompanyForm />} />
              <Route path="/inbox" element={<InboxPlaceholder />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/admin" element={<Admin />} />
            </Routes>
          </main>
        </>
      )}
    </div>
  )
}

function InboxPlaceholder() {
  return (
    <div className="p-4 md:p-6" data-testid="inbox-page">
      <h1 className="text-xl font-semibold text-white mb-2">Inbox</h1>
      <p className="text-gray-400 text-sm">
        Threads (email + SMS) will appear here. Connect IMAP and Twilio in a later phase.
      </p>
    </div>
  )
}
