# Secrets – all in Supabase

All **sensitive** secrets are stored in Supabase (Edge Function secrets or database). The app repo and Vercel only hold **public** config: Supabase URL and anon key.

---

## Supabase Edge Function secrets

Set these via CLI (they are available to Edge Functions as `Deno.env.get('...')`):

```bash
# Required for send-email function (Resend)
supabase secrets set RESEND_API_KEY=re_xxxx

# Optional: sender address (verified domain in Resend)
supabase secrets set RESEND_FROM="jolo <notifications@gojolo.io>"
```

**User notifications (Profile → Notifications: Task assigned, Thread assigned, Mentioned in thread)**

The `process-user-notification` Edge Function sends Slack DMs and/or Resend emails based on each user’s preference. It is invoked by database triggers and must be allowed by a shared secret.

1. Set a secret (e.g. `openssl rand -hex 24`) and store it in Supabase and in the DB:

```bash
# Same value must be in Supabase secrets AND in app_config (see below)
supabase secrets set NOTIFICATION_INTERNAL_SECRET=your_random_secret_here
```

2. In the database, insert/update `app_config` so triggers can call the function (run in SQL Editor or a migration):

```sql
-- Use your project URL from Dashboard → Project Settings → API
INSERT INTO public.app_config (key, value) VALUES
  ('supabase_url', 'https://YOUR_PROJECT_REF.supabase.co'),
  ('notification_internal_secret', 'your_random_secret_here')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Without these, notifications are still enqueued but not sent until the config is set.

**IMAP account test/save (`imap-test-and-save`):**

```bash
# 32-byte hex key for encrypting stored IMAP/SMTP passwords (generate: openssl rand -hex 32)
supabase secrets set ENCRYPTION_KEY=your64charhex...
```

This function skips gateway JWT verification (see `supabase/config.toml`) and verifies the user inside the function. If you deploy without using the repo’s config, deploy with:

```bash
supabase functions deploy imap-test-and-save --no-verify-jwt
```

**Future (add when you implement):**

```bash
# AI gateway (Phase 2)
supabase secrets set OPENAI_API_KEY=sk-xxxx

# Twilio webhooks / outbound SMS (Phase 1 threads)
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxx
supabase secrets set TWILIO_AUTH_TOKEN=xxxx
supabase secrets set TWILIO_WEBHOOK_SECRET=xxxx
```

List current secrets (values are hidden):

```bash
supabase secrets list
```

---

## What does NOT go in the repo or Vercel

- Do **not** put `RESEND_API_KEY`, `OPENAI_API_KEY`, Twilio keys, or any other API secrets in:
  - `.env` (local)
  - Vercel environment variables (except the two below)
  - Any file committed to git

---

## What goes in .env / Vercel (public only)

Only these are needed for the frontend; they are safe to be public (RLS protects data):

| Variable                 | Where       | Purpose                    |
|--------------------------|-------------|----------------------------|
| `VITE_SUPABASE_URL`      | .env, Vercel| Supabase project URL       |
| `VITE_SUPABASE_ANON_KEY`| .env, Vercel| Supabase anon (public) key |

Copy from Supabase Dashboard → Project Settings → API.

---

## Per-org / app data in the database

- **IMAP/SMTP** (mail accounts): stored in tables (e.g. `mail_accounts`), with credentials encrypted or in a vault; never in Edge Function secrets.
- **Google OAuth** for Gmail: configured in Supabase Dashboard (Auth) or in DB per org when we add that flow.
