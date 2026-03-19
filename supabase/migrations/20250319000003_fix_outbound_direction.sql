-- Fix existing messages: set direction = 'outbound' when from_identifier matches our org's email or aliases.
-- Previously imap-sync always stored direction = 'inbound'; our sent emails were incorrectly triggering Slack notifications.
UPDATE public.inbox_messages m
SET direction = 'outbound'
FROM public.inbox_threads t
WHERE m.thread_id = t.id
  AND m.direction = 'inbound'
  AND m.channel = 'email'
  AND EXISTS (
    SELECT 1 FROM public.imap_accounts a
    WHERE a.org_id = t.org_id AND a.is_active = true
      AND (
        LOWER(TRIM(REGEXP_REPLACE(COALESCE(m.from_identifier, ''), '^.*<([^>]+)>.*$', '\1'))) = LOWER(TRIM(a.email))
        OR LOWER(TRIM(REGEXP_REPLACE(COALESCE(m.from_identifier, ''), '^.*<([^>]+)>.*$', '\1'))) = ANY(
          SELECT LOWER(TRIM(addr)) FROM unnest(COALESCE(a.addresses, '{}')) AS addr WHERE addr IS NOT NULL AND TRIM(addr) <> ''
        )
      )
  );
