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
