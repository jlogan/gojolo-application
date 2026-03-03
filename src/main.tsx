import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { supabaseMisconfigured } from '@/lib/supabase'
import { AuthProvider } from '@/contexts/AuthContext'
import { OrgProvider } from '@/contexts/OrgContext'
import App from './App'
import './index.css'

const rootEl = document.getElementById('root')!
const root = createRoot(rootEl)

class AppErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('App error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0f0f0f', color: '#e4e4e7', fontFamily: 'Inter, system-ui, sans-serif',
          padding: '2rem', textAlign: 'center',
        }}>
          <div style={{ maxWidth: '32rem' }}>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#fff', marginBottom: '0.5rem' }}>
              Something went wrong
            </h1>
            <p style={{ fontSize: '0.875rem', color: '#f87171', marginBottom: '1rem', wordBreak: 'break-word' }}>
              {this.state.error.message}
            </p>
            <p style={{ fontSize: '0.8125rem', color: '#71717a' }}>
              Check the browser console for details. If Supabase is not running locally, start Docker and run{' '}
              <code style={{ color: '#14b8a6' }}>supabase start</code>.
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

try {
  if (supabaseMisconfigured) {
    root.render(
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0f0f0f', color: '#e4e4e7', fontFamily: 'Inter, system-ui, sans-serif',
        padding: '2rem', textAlign: 'center',
      }}>
        <div style={{ maxWidth: '28rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#fff', marginBottom: '0.75rem' }}>
            jolo
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#a1a1aa', marginBottom: '1.5rem' }}>
            Missing environment variables. The app cannot connect to Supabase.
          </p>
          <div style={{
            background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '0.5rem',
            padding: '1rem', textAlign: 'left', fontSize: '0.8125rem', color: '#d4d4d8',
          }}>
            <p style={{ marginBottom: '0.5rem', fontWeight: 500, color: '#fff' }}>
              Set these in your CI/CD build environment:
            </p>
            <code style={{ display: 'block', color: '#14b8a6', wordBreak: 'break-all' }}>
              VITE_SUPABASE_URL=https://your-project.supabase.co
            </code>
            <code style={{ display: 'block', color: '#14b8a6', wordBreak: 'break-all', marginTop: '0.25rem' }}>
              VITE_SUPABASE_ANON_KEY=your-anon-key
            </code>
            <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: '#71717a' }}>
              These are baked into the JS bundle at build time by Vite.
              Find them in Supabase Dashboard → Project Settings → API.
            </p>
          </div>
        </div>
      </div>,
    )
  } else {
    root.render(
      <StrictMode>
        <AppErrorBoundary>
          <BrowserRouter>
            <AuthProvider>
              <OrgProvider>
                <App />
              </OrgProvider>
            </AuthProvider>
          </BrowserRouter>
        </AppErrorBoundary>
      </StrictMode>,
    )
  }
} catch (err) {
  root.render(
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0f0f0f', color: '#e4e4e7', fontFamily: 'system-ui, sans-serif',
      padding: '2rem', textAlign: 'center',
    }}>
      <div style={{ maxWidth: '32rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#fff', marginBottom: '0.5rem' }}>
          Failed to start
        </h1>
        <p style={{ fontSize: '0.875rem', color: '#f87171', wordBreak: 'break-word' }}>
          {err instanceof Error ? err.message : String(err)}
        </p>
      </div>
    </div>,
  )
}
