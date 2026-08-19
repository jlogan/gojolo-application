-- Gmail label state on inbox messages/threads + list/search RPC filters.

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS gmail_labels text[],
  ADD COLUMN IF NOT EXISTS in_gmail_inbox boolean NOT NULL DEFAULT true;

ALTER TABLE public.inbox_threads
  ADD COLUMN IF NOT EXISTS gmail_labels text[],
  ADD COLUMN IF NOT EXISTS in_gmail_inbox boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.inbox_messages.gmail_labels IS 'Custom Gmail labels (non-system) from IMAP X-GM-LABELS / ImapFlow labels.';
COMMENT ON COLUMN public.inbox_messages.in_gmail_inbox IS 'True when message has Gmail \\Inbox label; non-Gmail messages stay true.';
COMMENT ON COLUMN public.inbox_threads.gmail_labels IS 'Union of custom Gmail labels on thread messages.';
COMMENT ON COLUMN public.inbox_threads.in_gmail_inbox IS 'Derived from latest non-draft message in_gmail_inbox; default inbox hides false.';

CREATE INDEX IF NOT EXISTS idx_inbox_messages_in_gmail_inbox
  ON public.inbox_messages (imap_account_id, in_gmail_inbox)
  WHERE imap_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbox_threads_org_in_gmail_inbox
  ON public.inbox_threads (org_id, in_gmail_inbox);

CREATE INDEX IF NOT EXISTS idx_inbox_threads_gmail_labels
  ON public.inbox_threads USING GIN (gmail_labels);

CREATE OR REPLACE FUNCTION public.sync_inbox_thread_gmail_labels(p_thread_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.inbox_threads t
  SET
    gmail_labels = CASE
      WHEN sub.labels IS NULL OR array_length(sub.labels, 1) IS NULL THEN NULL
      ELSE sub.labels
    END,
    in_gmail_inbox = COALESCE(sub.in_inbox, true),
    updated_at = now()
  FROM (
    SELECT
      (
        SELECT array_agg(DISTINCT lbl ORDER BY lbl)
        FROM public.inbox_messages m
        CROSS JOIN LATERAL unnest(COALESCE(m.gmail_labels, '{}'::text[])) AS lbl
        WHERE m.thread_id = p_thread_id
      ) AS labels,
      (
        SELECT m.in_gmail_inbox
        FROM public.inbox_messages m
        WHERE m.thread_id = p_thread_id
          AND COALESCE(m.is_draft, false) = false
        ORDER BY m.received_at DESC, m.id DESC
        LIMIT 1
      ) AS in_inbox
  ) sub
  WHERE t.id = p_thread_id;
$$;

GRANT EXECUTE ON FUNCTION public.sync_inbox_thread_gmail_labels(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_inbox_thread_gmail_labels(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.list_inbox_gmail_labels(
  p_org_id uuid,
  p_imap_account_id uuid DEFAULT NULL
)
RETURNS TABLE (
  label text,
  thread_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    lbl AS label,
    count(*)::bigint AS thread_count
  FROM public.inbox_threads t
  CROSS JOIN LATERAL unnest(COALESCE(t.gmail_labels, '{}'::text[])) AS lbl
  WHERE t.org_id = p_org_id
    AND t.channel = 'email'
    AND (p_imap_account_id IS NULL OR t.imap_account_id = p_imap_account_id)
    AND lbl IS NOT NULL
    AND btrim(lbl) <> ''
  GROUP BY lbl
  ORDER BY lbl;
$$;

GRANT EXECUTE ON FUNCTION public.list_inbox_gmail_labels(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_inbox_gmail_labels(uuid, uuid) TO service_role;

DROP FUNCTION IF EXISTS public.search_inbox_threads(uuid, uuid, text, text, integer, integer, uuid);

CREATE OR REPLACE FUNCTION public.search_inbox_threads(
  p_org_id uuid,
  p_user_id uuid,
  p_filter text DEFAULT 'inbox',
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_imap_account_id uuid DEFAULT NULL,
  p_gmail_label text DEFAULT NULL,
  p_gmail_label_mode text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  channel text,
  status text,
  subject text,
  last_message_at timestamptz,
  created_at timestamptz,
  from_address text,
  imap_account_id uuid,
  mailbox_address text,
  inbox_thread_assignments jsonb,
  message_count bigint,
  has_draft boolean,
  gmail_labels text[],
  in_gmail_inbox boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH search_terms AS (
    SELECT
      NULLIF(BTRIM(COALESCE(p_query, '')), '') AS raw,
      public.normalize_inbox_search_text(BTRIM(COALESCE(p_query, ''))) AS normalized
  ),
  visible_threads AS (
    SELECT t.*
    FROM public.inbox_threads t
    CROSS JOIN search_terms sq
    WHERE t.org_id = p_org_id
      AND (
        auth.uid() IS NULL
        OR auth.uid() = p_user_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.organization_users ou
        WHERE ou.org_id = t.org_id
          AND ou.user_id = COALESCE(auth.uid(), p_user_id)
      )
      AND EXISTS (
        SELECT 1
        FROM public.inbox_messages m
        WHERE m.thread_id = t.id
      )
      AND (p_imap_account_id IS NULL OR t.imap_account_id = p_imap_account_id)
      AND (
        CASE COALESCE(NULLIF(BTRIM(p_gmail_label_mode), ''), '')
          WHEN 'include' THEN
            p_gmail_label IS NOT NULL
            AND COALESCE(t.gmail_labels, '{}'::text[]) @> ARRAY[p_gmail_label]
          WHEN 'exclude' THEN
            p_gmail_label IS NULL
            OR NOT (COALESCE(t.gmail_labels, '{}'::text[]) @> ARRAY[p_gmail_label])
          ELSE true
        END
      )
      AND (
        CASE COALESCE(NULLIF(BTRIM(p_gmail_label_mode), ''), '')
          WHEN 'include' THEN true
          ELSE
            CASE COALESCE(NULLIF(p_filter, ''), 'inbox')
              WHEN 'inbox' THEN t.in_gmail_inbox = true
              ELSE true
            END
        END
      )
      AND (
        CASE COALESCE(NULLIF(p_filter, ''), 'inbox')
          WHEN 'inbox' THEN t.status = 'open'
            AND (
              NOT EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id)
              OR EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id AND a.user_id = p_user_id)
            )
          WHEN 'assigned' THEN t.status = 'open'
            AND EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id AND a.user_id = p_user_id)
          WHEN 'closed' THEN t.status = 'closed'
            AND (
              NOT EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id)
              OR EXISTS (SELECT 1 FROM public.inbox_thread_assignments a WHERE a.thread_id = t.id AND a.user_id = p_user_id)
            )
          WHEN 'trash' THEN t.status = 'archived'
          WHEN 'all' THEN (
            t.status <> 'archived'
            OR EXISTS (
              SELECT 1
              FROM public.inbox_messages m
              WHERE m.thread_id = t.id
                AND m.is_draft = true
            )
          )
          ELSE t.status = 'open'
        END
      )
      AND (
        sq.raw IS NULL
        OR (
          EXISTS (
            SELECT 1
            FROM public.inbox_messages m
            WHERE m.thread_id = t.id
          )
          AND (
            public.inbox_search_metadata_matches(t.subject, sq.raw, sq.normalized)
            OR public.inbox_search_metadata_matches(t.from_address, sq.raw, sq.normalized)
            OR public.inbox_search_metadata_matches(t.mailbox_address, sq.raw, sq.normalized)
            OR EXISTS (
              SELECT 1 FROM public.imap_accounts ia
              WHERE ia.id = t.imap_account_id
                AND ia.org_id = p_org_id
                AND (
                  public.inbox_search_metadata_matches(ia.email, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(ia.label, sq.raw, sq.normalized)
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public.inbox_messages m
              WHERE m.thread_id = t.id
                AND (
                  public.inbox_search_metadata_matches(m.from_identifier, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(m.to_identifier, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(m.cc, sq.raw, sq.normalized)
                  OR public.inbox_search_body_matches(m.body, sq.raw)
                  OR public.inbox_search_body_matches(m.html_body, sq.raw)
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public.inbox_thread_contacts itc
              JOIN public.contacts c ON c.id = itc.contact_id AND c.org_id = p_org_id
              LEFT JOIN public.companies co ON co.id = c.company_id AND co.org_id = p_org_id
              WHERE itc.thread_id = t.id
                AND (
                  public.inbox_search_metadata_matches(c.name, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(c.email, sq.raw, sq.normalized)
                  OR public.inbox_search_metadata_matches(co.name, sq.raw, sq.normalized)
                )
            )
          )
        )
      )
    ORDER BY t.last_message_at DESC, t.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT
    vt.id,
    vt.org_id,
    vt.channel,
    vt.status,
    vt.subject,
    vt.last_message_at,
    vt.created_at,
    vt.from_address,
    vt.imap_account_id,
    vt.mailbox_address,
    COALESCE(assignments.items, '[]'::jsonb) AS inbox_thread_assignments,
    CASE
      WHEN sq.raw IS NULL THEN 0::bigint
      ELSE COALESCE(counts.message_count, 0)::bigint
    END AS message_count,
    COALESCE(draft_flags.has_draft, false) AS has_draft,
    vt.gmail_labels,
    vt.in_gmail_inbox
  FROM visible_threads vt
  CROSS JOIN search_terms sq
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('user_id', a.user_id) ORDER BY a.assigned_at) AS items
    FROM public.inbox_thread_assignments a
    WHERE a.thread_id = vt.id
  ) assignments ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS message_count
    FROM public.inbox_messages m
    WHERE m.thread_id = vt.id
  ) counts ON sq.raw IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM public.inbox_messages m
      WHERE m.thread_id = vt.id
        AND m.is_draft = true
    ) AS has_draft
  ) draft_flags ON true
  ORDER BY vt.last_message_at DESC, vt.id DESC;
$$;

GRANT EXECUTE ON FUNCTION public.search_inbox_threads(uuid, uuid, text, text, integer, integer, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_inbox_threads(uuid, uuid, text, text, integer, integer, uuid, text, text) TO service_role;

-- Backfill thread gmail metadata from messages (message labels populate on next IMAP sync).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT m.thread_id AS tid
    FROM public.inbox_messages m
    INNER JOIN public.imap_accounts ia ON ia.id = m.imap_account_id
    WHERE ia.host ILIKE '%gmail.com%'
  LOOP
    PERFORM public.sync_inbox_thread_gmail_labels(r.tid);
  END LOOP;
END $$;
