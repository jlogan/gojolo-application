import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Key, Mail } from 'lucide-react'

type ProfileRow = { id: string; display_name: string | null; avatar_url: string | null }

export default function Profile() {
  const { user } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [profileLoading, setProfileLoading] = useState(true)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState<string | null>(null)

  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null)

  const email = user?.email ?? ''
  const provider = user?.app_metadata?.provider ?? 'email'

  useEffect(() => {
    if (!user?.id) return
    supabase
      .from('profiles')
      .select('id, display_name, avatar_url')
      .eq('id', user.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setDisplayName((data as ProfileRow).display_name ?? '')
        }
        setProfileLoading(false)
      })
  }, [user?.id])

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.id) return
    setProfileSaving(true)
    setProfileMessage(null)
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: displayName.trim() || null })
      .eq('id', user.id)
    if (error) {
      setProfileMessage(error.message)
    } else {
      setProfileMessage('Saved.')
    }
    setProfileSaving(false)
  }

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== passwordConfirm) {
      setPasswordMessage('Passwords do not match.')
      return
    }
    if (password.length < 6) {
      setPasswordMessage('Password must be at least 6 characters.')
      return
    }
    setPasswordSaving(true)
    setPasswordMessage(null)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setPasswordMessage(error.message)
    } else {
      setPasswordMessage('Password set. You can now sign in with email and password.')
      setPassword('')
      setPasswordConfirm('')
    }
    setPasswordSaving(false)
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl" data-testid="profile-page">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 mb-6 font-medium"
        data-testid="profile-back"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </Link>

      <h1 className="text-xl font-semibold text-white mb-6">Profile</h1>

      {/* Account (read-only) */}
      <section className="mb-8">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Account</h2>
        <div className="rounded-lg border border-border bg-surface-elevated p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Mail className="w-4 h-4 text-gray-500 shrink-0" />
            <div>
              <p className="text-xs text-gray-500">Email</p>
              <p className="text-gray-200 font-medium">{email || '—'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Signed up via</span>
            <span className="text-gray-400 text-sm font-medium">{provider}</span>
          </div>
        </div>
      </section>

      {/* Profile (display name) */}
      <section className="mb-8">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Display name</h2>
        <form onSubmit={handleSaveProfile} className="rounded-lg border border-border bg-surface-elevated p-4 space-y-4">
          <div>
            <label htmlFor="display-name" className="block text-xs font-medium text-gray-500 mb-1">
              Name
            </label>
            <input
              id="display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
              data-testid="profile-display-name"
            />
          </div>
          {profileMessage && (
            <p className={`text-sm ${profileMessage.startsWith('Saved') ? 'text-accent' : 'text-red-400'}`}>
              {profileMessage}
            </p>
          )}
          <button
            type="submit"
            disabled={profileLoading || profileSaving}
            className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            data-testid="profile-save"
          >
            {profileSaving ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>

      {/* Sign-in options */}
      <section className="mb-8">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Sign-in options</h2>
        <div className="rounded-lg border border-border bg-surface-elevated p-4">
          <div className="flex items-center gap-2 mb-2">
            <Key className="w-4 h-4 text-gray-500 shrink-0" />
            <span className="text-sm font-medium text-gray-300">Password</span>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            Set a password to sign in with email and password (e.g. after signing up with Google). Magic link is on the login page.
          </p>
          <form onSubmit={handleSetPassword} className="space-y-3">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
              data-testid="profile-password"
              autoComplete="new-password"
            />
            <input
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="Confirm password"
              className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-gray-200 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
              data-testid="profile-password-confirm"
              autoComplete="new-password"
            />
            {passwordMessage && (
              <p className={`text-sm ${passwordMessage.includes('now sign in') ? 'text-accent' : 'text-red-400'}`}>
                {passwordMessage}
              </p>
            )}
            <button
              type="submit"
              disabled={passwordSaving || !password || !passwordConfirm}
              className="px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              data-testid="profile-set-password"
            >
              {passwordSaving ? 'Saving…' : 'Set password'}
            </button>
          </form>
        </div>
      </section>
    </div>
  )
}
