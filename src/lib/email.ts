// Call the Supabase Edge Function to send email via Resend.
// Use for: invite emails, notification emails, etc.

import { supabase } from './supabase'

export type SendEmailOptions = {
  to: string | string[]
  subject: string
  html: string
  from?: string
}

export async function sendEmail(options: SendEmailOptions): Promise<{ id?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke('send-email', {
    body: options,
  })
  if (error) return { error: error.message }
  if (data?.error) return { error: data.error }
  return { id: data?.id }
}
