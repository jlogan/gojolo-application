-- Expand lead activity types for inbound outreach and scheduled appointments.

ALTER TABLE public.lead_attempts DROP CONSTRAINT IF EXISTS lead_attempts_type_check;

ALTER TABLE public.lead_attempts ADD CONSTRAINT lead_attempts_type_check CHECK (
  attempt_type IN (
    'application',
    'email_outreach',
    'linkedin_message',
    'upwork_proposal',
    'follow_up',
    'call',
    'meeting',
    'inbound',
    'appointment',
    'other'
  )
);
