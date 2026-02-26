import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useOrg } from '@/contexts/OrgContext'
import { supabase } from '@/lib/supabase'

export default function Login() {
  const { user, loading, signInWithGoogle } = useAuth()
  const { memberships } = useOrg()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'google' | 'email'>('google')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitLoading, setSubmitLoading] = useState(false)
  const [magicLinkSending, setMagicLinkSending] = useState(false)
  const [message, setMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => {
    if (loading) return
    if (user && memberships.length > 0) navigate('/', { replace: true })
    else if (user && memberships.length === 0) navigate('/workspace', { replace: true })
  }, [user, loading, memberships.length, navigate])

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setMessage(null)
    setSubmitLoading(true)
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (error) {
      setMessage({ type: 'error', text: error.message })
    }
    setSubmitLoading(false)
  }

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setMessage(null)
    setMagicLinkSending(true)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/` },
    })
    if (error) {
      setMessage({ type: 'error', text: error.message })
    } else {
      setMessage({ type: 'success', text: 'Check your inbox for a sign-in link.' })
    }
    setMagicLinkSending(false)
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-surface px-4"
      data-testid="login-page"
    >
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold text-white mb-2">jolo</h1>
        <p className="text-gray-400 text-sm mb-8">
          Business software, <span className="text-accent font-medium">not CRM.</span>
        </p>

        {mode === 'google' ? (
          <>
            <button
              type="button"
              onClick={signInWithGoogle}
              className="w-full py-3 px-4 rounded-lg bg-white text-gray-900 font-medium hover:bg-gray-100 flex items-center justify-center gap-2 border border-gray-200"
              data-testid="login-google"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Continue with Google
            </button>
            <button
              type="button"
              onClick={() => setMode('email')}
              className="mt-4 text-sm text-gray-400 hover:text-accent transition-colors"
              data-testid="login-switch-email"
            >
              Sign in with email & password or magic link
            </button>
          </>
        ) : (
          <form className="text-left space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-xs text-gray-500 mb-1">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full py-2.5 px-3 rounded-lg border border-border bg-surface-muted text-gray-200 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                data-testid="login-email-input"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-xs text-gray-500 mb-1">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full py-2.5 px-3 rounded-lg border border-border bg-surface-muted text-gray-200 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                data-testid="login-password-input"
              />
            </div>
            {message && (
              <p
                className={`text-sm ${message.type === 'error' ? 'text-red-400' : 'text-accent'}`}
                data-testid="login-message"
              >
                {message.text}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                onClick={handleEmailSignIn}
                disabled={submitLoading || !email.trim()}
                className="flex-1 py-2.5 rounded-lg bg-accent text-white font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                data-testid="login-email-submit"
              >
                {submitLoading ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={handleMagicLink}
                disabled={magicLinkSending || !email.trim()}
                className="flex-1 py-2.5 rounded-lg border border-border text-gray-300 font-medium hover:bg-surface-muted hover:border-accent/50 disabled:opacity-50 transition-colors"
                data-testid="login-magic-link"
              >
                {magicLinkSending ? 'Sending…' : 'Magic link'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setMode('google')}
              className="w-full text-sm text-gray-400 hover:text-accent transition-colors"
              data-testid="login-switch-google"
            >
              Back to Google
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
