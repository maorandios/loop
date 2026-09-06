-- FileRelay manual database setup (Milestone 10A)
-- Paste and run this file once in the Supabase SQL Editor for a new project.
-- Existing databases that already ran setup through Milestone 9 should use
-- supabase/manual-patch-m10a.sql (after manual-patch-m9.sql if needed).
-- Do not use the Supabase CLI.
--
-- Hosted Supabase installs contrib extensions (including pgcrypto) in the
-- `extensions` schema. digest() and gen_random_bytes() are therefore called as
-- extensions.digest / extensions.gen_random_bytes. Do not rely on search_path.
-- Do not add the `private` schema to the Data API exposed schemas.

BEGIN;

-- 1. Extension and schemas
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

-- 2. Helper functions that do not depend on tables
CREATE OR REPLACE FUNCTION private.normalize_join_code(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.upper(
    pg_catalog.regexp_replace(
      COALESCE(raw, ''::text),
      '[^a-zA-Z0-9]'::text,
      ''::text,
      'g'::text
    )
  );
$$;

CREATE OR REPLACE FUNCTION private.hash_join_code(raw text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT extensions.digest(
    pg_catalog.convert_to(private.normalize_join_code(raw), 'UTF8'),
    'sha256'
  );
$$;

CREATE OR REPLACE FUNCTION private.generate_join_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
  v_i integer;
BEGIN
  FOR v_i IN 1..8 LOOP
    v_code := v_code || pg_catalog.substr(
      v_alphabet,
      1 + (
        pg_catalog.get_byte(extensions.gen_random_bytes(1), 0)
        % pg_catalog.char_length(v_alphabet)
      ),
      1
    );
  END LOOP;
  RETURN pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4);
END;
$$;

CREATE OR REPLACE FUNCTION private.touch_handoff_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.is_workspace_member(uuid);
DROP FUNCTION IF EXISTS public.normalize_join_code(text);
DROP FUNCTION IF EXISTS public.hash_join_code(text);

-- 3. Tables and indexes
CREATE TABLE IF NOT EXISTS public.workspaces (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(name)) BETWEEN 1 AND 80
  ),
  join_code_hash bytea NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users (id),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_join_code_hash_key
  ON public.workspaces (join_code_hash);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id),
  device_id uuid NOT NULL,
  display_name text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(display_name)) BETWEEN 1 AND 50
  ),
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_user_key
  ON public.workspace_members (workspace_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_device_key
  ON public.workspace_members (workspace_id, device_id);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_workspace_per_user
  ON public.workspace_members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_id_id_key
  ON public.workspace_members (workspace_id, id);

CREATE TABLE IF NOT EXISTS public.handoffs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  sender_member_id uuid NOT NULL REFERENCES public.workspace_members (id),
  recipient_member_id uuid NOT NULL REFERENCES public.workspace_members (id),
  original_filename text CHECK (
    original_filename IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(original_filename)) BETWEEN 1 AND 255
      AND original_filename !~ '[[:cntrl:]]'
      AND original_filename !~ '[. ]$'
    )
  ),
  instruction text CHECK (
    instruction IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(instruction)) BETWEEN 1 AND 280
      AND instruction !~ '[[:cntrl:]]'
    )
  ),
  due_on date,
  status text CHECK (
    status IS NULL
    OR status IN (
      'uploading',
      'sent',
      'received',
      'opened',
      'modified',
      'returning',
      'returned',
      'return_received',
      'failed',
      'revision_requested',
      'completed'
    )
  ),
  flow_version smallint NOT NULL DEFAULT 1,
  request_status text,
  active_transfer_id uuid,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (sender_member_id <> recipient_member_id),
  CONSTRAINT handoffs_flow_status_check CHECK (
    flow_version IN (1, 2)
    AND (
      (
        flow_version = 1
        AND status IS NOT NULL
        AND status IN (
          'uploading',
          'sent',
          'received',
          'opened',
          'modified',
          'returning',
          'returned',
          'return_received',
          'failed',
          'revision_requested',
          'completed'
        )
        AND request_status IS NULL
      )
      OR (
        flow_version = 2
        AND status IS NULL
        AND request_status IN ('open', 'completed', 'cancelled')
        AND (
          (
            request_status = 'open'
            AND active_transfer_id IS NOT NULL
            AND closed_at IS NULL
            AND cancelled_at IS NULL
          )
          OR (
            request_status = 'completed'
            AND closed_at IS NOT NULL
            AND active_transfer_id IS NULL
            AND cancelled_at IS NULL
          )
          OR (
            request_status = 'cancelled'
            AND cancelled_at IS NOT NULL
            AND active_transfer_id IS NULL
            AND closed_at IS NULL
          )
        )
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS handoffs_id_workspace_id_key
  ON public.handoffs (id, workspace_id);
CREATE INDEX IF NOT EXISTS handoffs_workspace_id_idx
  ON public.handoffs (workspace_id);
CREATE INDEX IF NOT EXISTS handoffs_recipient_member_id_idx
  ON public.handoffs (recipient_member_id);
CREATE INDEX IF NOT EXISTS handoffs_sender_member_id_idx
  ON public.handoffs (sender_member_id);
CREATE INDEX IF NOT EXISTS handoffs_flow_version_idx
  ON public.handoffs (flow_version);
CREATE INDEX IF NOT EXISTS handoffs_request_status_open_idx
  ON public.handoffs (request_status)
  WHERE request_status = 'open';
CREATE INDEX IF NOT EXISTS handoffs_active_transfer_id_idx
  ON public.handoffs (active_transfer_id);

CREATE TABLE IF NOT EXISTS public.handoff_versions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES public.handoffs (id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number BETWEEN 1 AND 1000),
  storage_path text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(storage_path)) BETWEEN 1 AND 1024
  ),
  file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 52428800),
  blake3 text NOT NULL CHECK (blake3 ~ '^[0-9a-f]{64}$'),
  uploaded_by_member_id uuid NOT NULL REFERENCES public.workspace_members (id),
  file_name text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(file_name)) BETWEEN 1 AND 255
    AND file_name !~ '[[:cntrl:]]'
    AND file_name !~ '[. ]$'
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE UNIQUE INDEX IF NOT EXISTS handoff_versions_handoff_version_key
  ON public.handoff_versions (handoff_id, version_number);

CREATE TABLE IF NOT EXISTS public.handoff_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES public.handoffs (id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES public.workspace_members (id),
  transfer_id uuid,
  client_request_id uuid,
  event_type text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(event_type)) > 0),
  note text CHECK (
    note IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(note)) BETWEEN 1 AND 500
      AND note !~ '[[:cntrl:]]'
    )
  ),
  version_number integer CHECK (
    version_number IS NULL
    OR version_number BETWEEN 1 AND 1000
  ),
  handling_round integer CHECK (
    handling_round IS NULL
    OR handling_round BETWEEN 1 AND 1000
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT handoff_events_opened_round_required_check CHECK (
    event_type IS DISTINCT FROM 'opened'
    OR handling_round BETWEEN 1 AND 1000
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS handoff_events_business_request_key
  ON public.handoff_events (handoff_id, event_type, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS handoff_events_opened_round_key
  ON public.handoff_events (transfer_id, handling_round)
  WHERE event_type = 'opened' AND transfer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.handoff_transfers (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES public.handoffs (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  parent_transfer_id uuid,
  from_member_id uuid NOT NULL,
  to_member_id uuid NOT NULL,
  requested_action text NOT NULL CHECK (requested_action IN ('approval', 'review', 'update', 'file_request')),
  instruction text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(instruction)) BETWEEN 1 AND 280
    AND instruction !~ '[[:cntrl:]]'
  ),
  due_on date,
  status text NOT NULL CHECK (
    status IN (
      'preparing',
      'active',
      'waiting_child',
      'returned_to_sender',
      'failed',
      'closed'
    )
  ),
  result_action text CHECK (
    result_action IS NULL
    OR result_action IN (
      'approved',
      'review_completed',
      'returned_with_file',
      'returned_with_reply',
      'rejected'
    )
  ),
  result_note text CHECK (
    result_note IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(result_note)) BETWEEN 1 AND 500
      AND result_note !~ '[[:cntrl:]]'
    )
  ),
  result_version_number integer CHECK (
    result_version_number IS NULL
    OR result_version_number BETWEEN 1 AND 1000
  ),
  pending_object_id uuid,
  pending_version_number integer,
  pending_storage_path text,
  pending_upload_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ended_at timestamptz,
  last_reminder_at timestamptz,
  handling_round integer NOT NULL DEFAULT 1 CHECK (handling_round BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (from_member_id <> to_member_id),
  CHECK (
    (
      pending_object_id IS NULL
      AND pending_version_number IS NULL
      AND pending_storage_path IS NULL
      AND pending_upload_expires_at IS NULL
    )
    OR (
      pending_object_id IS NOT NULL
      AND pending_version_number BETWEEN 1 AND 1000
      AND pg_catalog.char_length(pg_catalog.btrim(pending_storage_path)) BETWEEN 1 AND 1024
      AND pending_upload_expires_at IS NOT NULL
    )
  ),
  CHECK (
    (status IN ('preparing', 'active', 'failed', 'waiting_child') AND result_action IS NULL AND ended_at IS NULL)
    OR (status = 'returned_to_sender' AND result_action IS NOT NULL AND ended_at IS NULL)
    OR (status = 'closed' AND ended_at IS NOT NULL)
  ),
  CHECK (result_action IS DISTINCT FROM 'rejected' OR result_note IS NOT NULL),
  CONSTRAINT handoff_transfers_returned_with_reply_check CHECK (
    result_action IS DISTINCT FROM 'returned_with_reply'
    OR (
      result_note IS NOT NULL
      AND result_version_number IS NULL
    )
  ),
  CONSTRAINT handoff_transfers_returned_with_file_check CHECK (
    result_action IS DISTINCT FROM 'returned_with_file'
    OR result_version_number IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS handoff_transfers_handoff_id_id_key
  ON public.handoff_transfers (handoff_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS handoff_transfers_one_root_key
  ON public.handoff_transfers (handoff_id)
  WHERE parent_transfer_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS handoff_transfers_one_live_key
  ON public.handoff_transfers (handoff_id)
  WHERE status IN ('preparing', 'active', 'returned_to_sender', 'failed');
CREATE INDEX IF NOT EXISTS handoff_transfers_handoff_id_idx
  ON public.handoff_transfers (handoff_id);
CREATE INDEX IF NOT EXISTS handoff_transfers_parent_idx
  ON public.handoff_transfers (parent_transfer_id);
CREATE INDEX IF NOT EXISTS handoff_transfers_from_idx
  ON public.handoff_transfers (from_member_id);
CREATE INDEX IF NOT EXISTS handoff_transfers_to_idx
  ON public.handoff_transfers (to_member_id);

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_handoff_workspace_fkey'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_handoff_workspace_fkey
      FOREIGN KEY (handoff_id, workspace_id)
      REFERENCES public.handoffs (id, workspace_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_from_member_fkey'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_from_member_fkey
      FOREIGN KEY (workspace_id, from_member_id)
      REFERENCES public.workspace_members (workspace_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_to_member_fkey'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_to_member_fkey
      FOREIGN KEY (workspace_id, to_member_id)
      REFERENCES public.workspace_members (workspace_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_parent_belonging_fkey'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_parent_belonging_fkey
      FOREIGN KEY (handoff_id, parent_transfer_id)
      REFERENCES public.handoff_transfers (handoff_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_result_version_fkey'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_result_version_fkey
      FOREIGN KEY (handoff_id, result_version_number)
      REFERENCES public.handoff_versions (handoff_id, version_number);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoffs_active_transfer_belonging_fkey'
  ) THEN
    ALTER TABLE public.handoffs
      ADD CONSTRAINT handoffs_active_transfer_belonging_fkey
      FOREIGN KEY (id, active_transfer_id)
      REFERENCES public.handoff_transfers (handoff_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_events_transfer_belonging_fkey'
  ) THEN
    ALTER TABLE public.handoff_events
      ADD CONSTRAINT handoff_events_transfer_belonging_fkey
      FOREIGN KEY (handoff_id, transfer_id)
      REFERENCES public.handoff_transfers (handoff_id, id);
  END IF;
END
$fk$;

-- M10C-LEGACY-START
-- M10C-A: repair M10A v1 backfill before returned_with_file CHECK.
-- v1 return files start at version 2. Do not invent a version or rewrite result_action.

DO $m10c_v2_returned_with_file$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.handoff_transfers t
    JOIN public.handoffs h ON h.id = t.handoff_id
    WHERE h.flow_version = 2
      AND t.result_action = 'returned_with_file'
      AND t.result_version_number IS NULL
  ) THEN
    RAISE EXCEPTION 'm10c_v2_returned_with_file_missing_version'
      USING ERRCODE = 'P0001';
  END IF;
END
$m10c_v2_returned_with_file$;

UPDATE public.handoff_transfers AS t
SET result_version_number = derived.return_version
FROM public.handoffs AS h
JOIN LATERAL (
  SELECT pg_catalog.max(hv.version_number) AS return_version
  FROM public.handoff_versions AS hv
  WHERE hv.handoff_id = h.id
    AND hv.version_number >= 2
) AS derived ON derived.return_version IS NOT NULL
WHERE t.handoff_id = h.id
  AND t.parent_transfer_id IS NULL
  AND h.flow_version = 1
  AND t.result_action = 'returned_with_file'
  AND t.result_version_number IS NULL
  AND h.status IN ('returned', 'return_received');

DO $m10c_legacy_returned_with_file$
DECLARE
  v_leftover text;
BEGIN
  SELECT pg_catalog.string_agg(pg_catalog.right(h.id::text, 4), ', ' ORDER BY h.id)
  INTO v_leftover
  FROM public.handoff_transfers t
  JOIN public.handoffs h ON h.id = t.handoff_id
  WHERE h.flow_version = 1
    AND t.result_action = 'returned_with_file'
    AND t.result_version_number IS NULL;

  IF v_leftover IS NOT NULL THEN
    RAISE EXCEPTION 'm10c_legacy_returned_with_file_unmigratable'
      USING ERRCODE = 'P0001', DETAIL = v_leftover;
  END IF;
END
$m10c_legacy_returned_with_file$;
-- M10C-LEGACY-END

CREATE TABLE IF NOT EXISTS public.handoff_command_receipts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  command_name text NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(command_name)) > 0),
  actor_member_id uuid NOT NULL REFERENCES public.workspace_members (id),
  client_request_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb,
  handoff_id uuid REFERENCES public.handoffs (id) ON DELETE CASCADE,
  transfer_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE UNIQUE INDEX IF NOT EXISTS handoff_command_receipts_actor_request_key
  ON public.handoff_command_receipts (actor_member_id, client_request_id);

DROP TRIGGER IF EXISTS handoffs_set_updated_at ON public.handoffs;
CREATE TRIGGER handoffs_set_updated_at
BEFORE UPDATE ON public.handoffs
FOR EACH ROW
EXECUTE FUNCTION private.touch_handoff_updated_at();

DROP TRIGGER IF EXISTS handoff_transfers_set_updated_at ON public.handoff_transfers;
CREATE TRIGGER handoff_transfers_set_updated_at
BEFORE UPDATE ON public.handoff_transfers
FOR EACH ROW
EXECUTE FUNCTION private.touch_handoff_updated_at();

-- 4. Functions that depend on tables
CREATE OR REPLACE FUNCTION private.is_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id
      AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION private.is_handoff_participant(p_handoff_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.handoffs h
    JOIN public.workspace_members m
      ON m.id IN (h.sender_member_id, h.recipient_member_id)
    WHERE h.id = p_handoff_id
      AND m.user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1
    FROM public.handoff_transfers t
    JOIN public.workspace_members m
      ON m.id IN (t.from_member_id, t.to_member_id)
    WHERE t.handoff_id = p_handoff_id
      AND m.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION private.handoff_status_visible_to_recipient(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_status IN (
    'sent',
    'received',
    'opened',
    'modified',
    'returning',
    'returned',
    'return_received',
    'revision_requested',
    'completed'
  );
$$;

CREATE OR REPLACE FUNCTION private.handoff_readable(p_handoff_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.handoffs h
    WHERE h.id = p_handoff_id
      AND (
        (
          h.flow_version = 1
          AND (
            EXISTS (
              SELECT 1
              FROM public.workspace_members sender
              WHERE sender.id = h.sender_member_id
                AND sender.user_id = auth.uid()
            )
            OR (
              EXISTS (
                SELECT 1
                FROM public.workspace_members recipient
                WHERE recipient.id = h.recipient_member_id
                  AND recipient.user_id = auth.uid()
              )
              AND private.handoff_status_visible_to_recipient(h.status)
            )
          )
        )
        OR (
          h.flow_version = 2
          AND (
            (
              EXISTS (
                SELECT 1
                FROM public.handoff_transfers active_hop
                WHERE active_hop.id = h.active_transfer_id
                  AND active_hop.status IN ('preparing', 'failed')
              )
              AND EXISTS (
                SELECT 1
                FROM public.handoff_transfers active_hop
                JOIN public.workspace_members actor
                  ON actor.id = active_hop.from_member_id
                WHERE active_hop.id = h.active_transfer_id
                  AND actor.user_id = auth.uid()
              )
            )
            OR (
              NOT EXISTS (
                SELECT 1
                FROM public.handoff_transfers active_hop
                WHERE active_hop.id = h.active_transfer_id
                  AND active_hop.status IN ('preparing', 'failed')
              )
              AND (
                EXISTS (
                  SELECT 1
                  FROM public.workspace_members sender
                  WHERE sender.id = h.sender_member_id
                    AND sender.user_id = auth.uid()
                )
                OR EXISTS (
                  SELECT 1
                  FROM public.handoff_transfers t
                  JOIN public.workspace_members m
                    ON m.id IN (t.from_member_id, t.to_member_id)
                  WHERE t.handoff_id = h.id
                    AND m.user_id = auth.uid()
                )
              )
            )
          )
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION private.reject_if_flow_v2(p_handoff_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.handoffs h
    WHERE h.id = p_handoff_id
      AND h.flow_version = 2
  ) THEN
    RAISE EXCEPTION 'flow_version_mismatch' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.command_fingerprint(p_canonical text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(COALESCE(p_canonical, ''), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION private.claim_command_receipt(
  p_actor_member_id uuid,
  p_client_request_id uuid,
  p_command_name text,
  p_fingerprint text,
  OUT won boolean,
  OUT receipt_id uuid,
  OUT existing_result jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_command text;
  v_fingerprint text;
BEGIN
  IF p_actor_member_id IS NULL
     OR p_client_request_id IS NULL
     OR p_command_name IS NULL
     OR p_fingerprint IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;

  LOOP
    INSERT INTO public.handoff_command_receipts (
      command_name,
      actor_member_id,
      client_request_id,
      request_fingerprint
    )
    VALUES (
      p_command_name,
      p_actor_member_id,
      p_client_request_id,
      p_fingerprint
    )
    ON CONFLICT (actor_member_id, client_request_id) DO NOTHING
    RETURNING id INTO receipt_id;

    IF receipt_id IS NOT NULL THEN
      won := true;
      existing_result := NULL;
      RETURN;
    END IF;

    SELECT r.id, r.command_name, r.request_fingerprint, r.result
    INTO receipt_id, v_command, v_fingerprint, existing_result
    FROM public.handoff_command_receipts r
    WHERE r.actor_member_id = p_actor_member_id
      AND r.client_request_id = p_client_request_id
    FOR UPDATE;

    IF receipt_id IS NULL THEN
      CONTINUE;
    END IF;

    IF v_command IS DISTINCT FROM p_command_name
       OR v_fingerprint IS DISTINCT FROM p_fingerprint THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;

    IF existing_result IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;

    won := false;
    RETURN;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.finish_command_receipt(
  p_receipt_id uuid,
  p_result jsonb,
  p_handoff_id uuid DEFAULT NULL,
  p_transfer_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.handoff_command_receipts
  SET result = p_result,
      handoff_id = COALESCE(p_handoff_id, handoff_id),
      transfer_id = COALESCE(p_transfer_id, transfer_id)
  WHERE id = p_receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.handoffs_active_transfer_status_ok()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.flow_version = 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.active_transfer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.handoff_transfers t
    WHERE t.id = NEW.active_transfer_id
      AND t.handoff_id = NEW.id
      AND t.status IN ('preparing', 'active', 'returned_to_sender', 'failed')
  ) THEN
    RAISE EXCEPTION 'active_transfer_status_invalid' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.handoff_transfers_active_status_ok()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.handoffs h
    WHERE h.id = NEW.handoff_id
      AND h.flow_version = 1
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('preparing', 'active', 'returned_to_sender', 'failed') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.handoffs h
    WHERE h.active_transfer_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'active_transfer_status_invalid' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS handoffs_active_transfer_status_trg ON public.handoffs;
CREATE CONSTRAINT TRIGGER handoffs_active_transfer_status_trg
AFTER INSERT OR UPDATE OF active_transfer_id, request_status ON public.handoffs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.handoffs_active_transfer_status_ok();

DROP TRIGGER IF EXISTS handoff_transfers_active_status_trg ON public.handoff_transfers;
CREATE CONSTRAINT TRIGGER handoff_transfers_active_status_trg
AFTER UPDATE OF status ON public.handoff_transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.handoff_transfers_active_status_ok();

-- M10C-A2-HELPERS-START
CREATE OR REPLACE FUNCTION private.assert_safe_file_name(p_file_name text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_name text := NULLIF(pg_catalog.btrim(p_file_name), ''::text);
  v_stem text;
BEGIN
  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) < 1
     OR pg_catalog.char_length(v_name) > 255
     OR v_name ~ '[\\/]'
     OR v_name LIKE '%..%'
     OR v_name ~ '[[:cntrl:]]'
     OR v_name ~ '[. ]$'
  THEN
    RAISE EXCEPTION 'unsafe_file_name' USING ERRCODE = '22023';
  END IF;

  v_stem := pg_catalog.upper(
    CASE
      WHEN v_name ~ '\.[^.]+$' THEN pg_catalog.regexp_replace(v_name, '\.[^.]+$', '')
      ELSE v_name
    END
  );

  IF v_stem IN (
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ) THEN
    RAISE EXCEPTION 'unsafe_file_name' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.insert_handoff_version(
  p_handoff_id uuid,
  p_version_number integer,
  p_storage_path text,
  p_file_size bigint,
  p_blake3 text,
  p_uploaded_by_member_id uuid,
  p_file_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := NULLIF(pg_catalog.btrim(p_file_name), ''::text);
BEGIN
  PERFORM private.assert_safe_file_name(v_name);

  INSERT INTO public.handoff_versions (
    handoff_id,
    version_number,
    storage_path,
    file_size,
    blake3,
    uploaded_by_member_id,
    file_name
  )
  VALUES (
    p_handoff_id,
    p_version_number,
    p_storage_path,
    p_file_size,
    p_blake3,
    p_uploaded_by_member_id,
    v_name
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_reserved_upload_matches(
  p_workspace_id uuid,
  p_handoff_id uuid,
  p_user_id uuid,
  p_object_id uuid,
  p_file_size bigint,
  p_pending_object_id uuid,
  p_pending_version_number integer,
  p_pending_storage_path text,
  p_blake3 text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_path text;
  v_object_size bigint;
  v_object_owner_id text;
BEGIN
  IF p_blake3 IS NULL OR p_blake3 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF p_pending_object_id IS DISTINCT FROM p_object_id
     OR p_pending_version_number IS NULL
     OR p_pending_storage_path IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  v_path := p_workspace_id::text || '/' || p_handoff_id::text
    || '/v' || p_pending_version_number::text || '/' || p_object_id::text;

  IF p_pending_storage_path IS DISTINCT FROM v_path
     OR p_object_id::text IS DISTINCT FROM pg_catalog.split_part(v_path, '/', 4) THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_object_size IS DISTINCT FROM p_file_size THEN
    RAISE EXCEPTION 'handoff_object_size_mismatch' USING ERRCODE = '22023';
  END IF;

  RETURN v_path;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_handoff_original_filename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_handoff_id uuid;
  v_flow smallint;
  v_name text;
  v_action text;
BEGIN
  IF TG_TABLE_NAME = 'handoffs' THEN
    v_handoff_id := NEW.id;
    v_flow := NEW.flow_version;
    v_name := NEW.original_filename;
  ELSE
    IF NEW.parent_transfer_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
    v_handoff_id := NEW.handoff_id;
    SELECT h.flow_version, h.original_filename
    INTO v_flow, v_name
    FROM public.handoffs h
    WHERE h.id = v_handoff_id;
  END IF;

  SELECT t.requested_action
  INTO v_action
  FROM public.handoff_transfers t
  WHERE t.handoff_id = v_handoff_id
    AND t.parent_transfer_id IS NULL;

  IF v_flow = 1 THEN
    IF v_name IS NULL OR pg_catalog.btrim(v_name) = '' THEN
      RAISE EXCEPTION 'original_filename_required' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF v_action IS NULL THEN
    RAISE EXCEPTION 'original_filename_required' USING ERRCODE = '23514';
  END IF;

  IF v_action = 'file_request' THEN
    IF v_name IS NOT NULL THEN
      RAISE EXCEPTION 'original_filename_not_allowed' USING ERRCODE = '23514';
    END IF;
  ELSIF v_name IS NULL OR pg_catalog.btrim(v_name) = '' THEN
    RAISE EXCEPTION 'original_filename_required' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
-- M10C-A2-HELPERS-END

-- M10C-A2-TRIGGERS-START
DROP TRIGGER IF EXISTS handoffs_original_filename_trg ON public.handoffs;
CREATE CONSTRAINT TRIGGER handoffs_original_filename_trg
AFTER INSERT OR UPDATE OF original_filename, flow_version ON public.handoffs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.assert_handoff_original_filename();

DROP TRIGGER IF EXISTS handoff_transfers_original_filename_trg ON public.handoff_transfers;
CREATE CONSTRAINT TRIGGER handoff_transfers_original_filename_trg
AFTER INSERT OR UPDATE OF requested_action, parent_transfer_id, handoff_id ON public.handoff_transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.assert_handoff_original_filename();
-- M10C-A2-TRIGGERS-END


CREATE OR REPLACE FUNCTION private.try_parse_handoff_object(
  object_name text,
  OUT workspace_id uuid,
  OUT handoff_id uuid,
  OUT version_number integer
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_parts text[];
  v_uuid text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  workspace_id := NULL;
  handoff_id := NULL;
  version_number := NULL;

  IF object_name IS NULL THEN
    RETURN;
  END IF;

  v_parts := pg_catalog.string_to_array(object_name, '/');
  IF pg_catalog.array_length(v_parts, 1) IS DISTINCT FROM 4 THEN
    RETURN;
  END IF;
  IF v_parts[1] IS NULL OR NOT (v_parts[1] ~* v_uuid) THEN
    RETURN;
  END IF;
  IF v_parts[2] IS NULL OR NOT (v_parts[2] ~* v_uuid) THEN
    RETURN;
  END IF;
  IF v_parts[3] IS NULL
     OR pg_catalog.char_length(v_parts[3]) > 5
     OR v_parts[3] !~ '^v[1-9][0-9]*$' THEN
    RETURN;
  END IF;
  IF v_parts[4] IS NULL OR NOT (v_parts[4] ~* v_uuid) THEN
    RETURN;
  END IF;

  BEGIN
    workspace_id := v_parts[1]::uuid;
    handoff_id := v_parts[2]::uuid;
    version_number := pg_catalog.substr(v_parts[3], 2)::integer;
    IF version_number < 1 OR version_number > 1000 THEN
      workspace_id := NULL;
      handoff_id := NULL;
      version_number := NULL;
      RETURN;
    END IF;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      workspace_id := NULL;
      handoff_id := NULL;
      version_number := NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION private.can_read_handoff_object(object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_handoff_id uuid;
  v_version integer;
BEGIN
  SELECT p.workspace_id, p.handoff_id, p.version_number
  INTO v_workspace_id, v_handoff_id, v_version
  FROM private.try_parse_handoff_object(object_name) AS p;

  IF v_workspace_id IS NULL OR v_handoff_id IS NULL OR v_version IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.handoffs h
    JOIN public.handoff_versions hv
      ON hv.handoff_id = h.id
    WHERE h.id = v_handoff_id
      AND h.workspace_id = v_workspace_id
      AND private.handoff_readable(h.id)
      AND hv.handoff_id = v_handoff_id
      AND hv.version_number = v_version
      AND hv.storage_path = object_name
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_read_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.can_upload_handoff_object(object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_handoff_id uuid;
  v_version integer;
BEGIN
  SELECT p.workspace_id, p.handoff_id, p.version_number
  INTO v_workspace_id, v_handoff_id, v_version
  FROM private.try_parse_handoff_object(object_name) AS p;

  IF v_workspace_id IS NULL OR v_handoff_id IS NULL OR v_version IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.handoffs h
    JOIN public.workspace_members m ON m.user_id = auth.uid()
    WHERE h.id = v_handoff_id
      AND h.workspace_id = v_workspace_id
      AND (
        (
          h.flow_version = 1
          AND (
            (
              v_version = 1
              AND m.id = h.sender_member_id
              AND h.status = 'uploading'
            )
            OR (
              v_version >= 2
              AND v_version <= 1000
              AND m.id = h.recipient_member_id
              AND h.status = 'returning'
              AND v_version = (
                SELECT COALESCE(pg_catalog.max(hv.version_number), 0) + 1
                FROM public.handoff_versions hv
                WHERE hv.handoff_id = h.id
              )
            )
          )
        )
        OR (
          h.flow_version = 2
          AND h.request_status = 'open'
          AND EXISTS (
            SELECT 1
            FROM public.handoff_transfers t
            WHERE t.id = h.active_transfer_id
              AND t.handoff_id = h.id
              AND t.pending_object_id IS NOT NULL
              AND t.pending_storage_path = object_name
              AND t.pending_version_number = v_version
              AND t.pending_object_id::text = pg_catalog.split_part(object_name, '/', 4)
              AND t.pending_upload_expires_at > pg_catalog.now()
              AND (
                (t.status = 'preparing' AND m.id = t.from_member_id)
                OR (t.status = 'active' AND m.id = t.to_member_id)
              )
          )
        )
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.can_delete_reserved_handoff_object(object_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_handoff_id uuid;
  v_version integer;
BEGIN
  SELECT p.workspace_id, p.handoff_id, p.version_number
  INTO v_workspace_id, v_handoff_id, v_version
  FROM private.try_parse_handoff_object(object_name) AS p;

  IF v_workspace_id IS NULL OR v_handoff_id IS NULL OR v_version IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.handoffs h
    JOIN public.handoff_transfers t ON t.id = h.active_transfer_id
    JOIN public.workspace_members m ON m.user_id = auth.uid()
    WHERE h.id = v_handoff_id
      AND h.workspace_id = v_workspace_id
      AND h.flow_version = 2
      AND h.request_status = 'open'
      AND t.handoff_id = h.id
      AND t.parent_transfer_id IS NULL
      AND t.pending_object_id IS NOT NULL
      AND t.pending_storage_path = object_name
      AND t.pending_version_number = v_version
      AND t.pending_object_id::text = pg_catalog.split_part(object_name, '/', 4)
      AND NOT EXISTS (
        SELECT 1
        FROM public.handoff_versions hv
        WHERE hv.storage_path = object_name
      )
      AND (
        (t.status IN ('preparing', 'failed') AND t.from_member_id = m.id)
        OR (t.status = 'active' AND t.to_member_id = m.id)
        OR m.id = h.sender_member_id
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_delete_reserved_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_delete_reserved_handoff_object(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.can_delete_handoff_object(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.can_delete_reserved_handoff_object(object_name);
$$;

REVOKE ALL ON FUNCTION private.can_delete_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_delete_handoff_object(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION private.reject_if_completed(p_status text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_status = 'completed' THEN
    RAISE EXCEPTION 'handoff_already_completed' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.reject_if_completed(text)
  FROM PUBLIC, anon, authenticated;

-- 5. GRANT and REVOKE
REVOKE ALL ON FUNCTION private.normalize_join_code(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.hash_join_code(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.generate_join_code() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.touch_handoff_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.handoff_status_visible_to_recipient(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.try_parse_handoff_object(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reject_if_completed(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.is_workspace_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.is_handoff_participant(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.handoff_readable(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reject_if_flow_v2(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.command_fingerprint(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.claim_command_receipt(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.finish_command_receipt(uuid, jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.handoffs_active_transfer_status_ok() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.handoff_transfers_active_status_ok() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_read_handoff_object(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_delete_reserved_handoff_object(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_delete_handoff_object(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_workspace_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_handoff_participant(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.handoff_readable(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_delete_reserved_handoff_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_delete_handoff_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.handoff_status_visible_to_recipient(text) TO authenticated;

REVOKE ALL ON public.workspaces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.workspace_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoffs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoff_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoff_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoff_transfers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoff_command_receipts FROM PUBLIC, anon, authenticated;

GRANT SELECT (id, name, created_by, created_at) ON public.workspaces TO authenticated;
GRANT SELECT ON public.workspace_members TO authenticated;
GRANT UPDATE (last_seen_at, display_name) ON public.workspace_members TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_versions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.handoffs TO authenticated;
GRANT SELECT ON public.handoff_versions TO authenticated;
GRANT SELECT ON public.handoff_events TO authenticated;
GRANT SELECT ON public.handoff_transfers TO authenticated;

-- 6. RLS policies
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_command_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_command_receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspaces_select_member ON public.workspaces;
CREATE POLICY workspaces_select_member
  ON public.workspaces
  FOR SELECT
  TO authenticated
  USING (private.is_workspace_member(id));

DROP POLICY IF EXISTS workspace_members_select_same_team ON public.workspace_members;
CREATE POLICY workspace_members_select_same_team
  ON public.workspace_members
  FOR SELECT
  TO authenticated
  USING (private.is_workspace_member(workspace_id));

DROP POLICY IF EXISTS workspace_members_update_self ON public.workspace_members;
CREATE POLICY workspace_members_update_self
  ON public.workspace_members
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS handoffs_select_member ON public.handoffs;
DROP POLICY IF EXISTS handoffs_select_participant ON public.handoffs;
CREATE POLICY handoffs_select_participant
  ON public.handoffs
  FOR SELECT
  TO authenticated
  USING (private.handoff_readable(id));

DROP POLICY IF EXISTS handoffs_insert_sender ON public.handoffs;
DROP POLICY IF EXISTS handoffs_update_member ON public.handoffs;
DROP POLICY IF EXISTS handoffs_update_participant ON public.handoffs;

DROP POLICY IF EXISTS handoff_versions_select_member ON public.handoff_versions;
DROP POLICY IF EXISTS handoff_versions_select_participant ON public.handoff_versions;
CREATE POLICY handoff_versions_select_participant
  ON public.handoff_versions
  FOR SELECT
  TO authenticated
  USING (private.handoff_readable(handoff_id));

DROP POLICY IF EXISTS handoff_versions_insert_member ON public.handoff_versions;

DROP POLICY IF EXISTS handoff_events_select_member ON public.handoff_events;
DROP POLICY IF EXISTS handoff_events_select_participant ON public.handoff_events;
CREATE POLICY handoff_events_select_participant
  ON public.handoff_events
  FOR SELECT
  TO authenticated
  USING (private.handoff_readable(handoff_id));

DROP POLICY IF EXISTS handoff_events_insert_member ON public.handoff_events;

DROP POLICY IF EXISTS handoff_transfers_select_participant ON public.handoff_transfers;
CREATE POLICY handoff_transfers_select_participant
  ON public.handoff_transfers
  FOR SELECT
  TO authenticated
  USING (private.handoff_readable(handoff_id));

-- 7. RPCs
CREATE OR REPLACE FUNCTION public.create_workspace(display_name text, device_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_name text := pg_catalog.btrim(display_name);
  v_workspace_id uuid;
  v_member_id uuid;
  v_pretty text;
  v_attempt integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) = 0
     OR pg_catalog.char_length(v_name) > 50 THEN
    RAISE EXCEPTION 'workspace_creation_failed' USING ERRCODE = '22023';
  END IF;

  IF device_id IS NULL THEN
    RAISE EXCEPTION 'workspace_creation_failed' USING ERRCODE = '22023';
  END IF;

  FOR v_attempt IN 1..8 LOOP
    v_pretty := private.generate_join_code();

    BEGIN
      INSERT INTO public.workspaces (name, join_code_hash, created_by)
      VALUES ('הצוות של ' || v_name, private.hash_join_code(v_pretty), v_user_id)
      RETURNING id INTO v_workspace_id;

      INSERT INTO public.workspace_members (workspace_id, user_id, device_id, display_name)
      VALUES (v_workspace_id, v_user_id, device_id, v_name)
      RETURNING id INTO v_member_id;

      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        IF EXISTS (
          SELECT 1 FROM public.workspace_members WHERE user_id = v_user_id
        ) THEN
          RAISE EXCEPTION 'already_in_workspace' USING ERRCODE = '23505';
        END IF;
        IF v_attempt = 8 THEN
          RAISE EXCEPTION 'workspace_creation_failed' USING ERRCODE = '23505';
        END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'workspace_id', v_workspace_id,
    'join_code', v_pretty,
    'member_id', v_member_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.join_workspace(join_code text, display_name text, device_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_name text := pg_catalog.btrim(display_name);
  v_workspace_id uuid;
  v_member_id uuid;
  v_existing_workspace_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) = 0
     OR pg_catalog.char_length(v_name) > 50
     OR device_id IS NULL THEN
    RAISE EXCEPTION 'invalid_join_code' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.char_length(private.normalize_join_code(join_code)) <> 8 THEN
    RAISE EXCEPTION 'invalid_join_code' USING ERRCODE = '22023';
  END IF;

  SELECT w.id
  INTO v_workspace_id
  FROM public.workspaces w
  WHERE w.join_code_hash = private.hash_join_code(join_code);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_join_code' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_member_id
  FROM public.workspace_members m
  WHERE m.workspace_id = v_workspace_id
    AND m.user_id = v_user_id;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'workspace_id', v_workspace_id,
      'member_id', v_member_id
    );
  END IF;

  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, device_id, display_name)
    VALUES (v_workspace_id, v_user_id, device_id, v_name)
    RETURNING id INTO v_member_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT m.id, m.workspace_id
      INTO v_member_id, v_existing_workspace_id
      FROM public.workspace_members m
      WHERE m.user_id = v_user_id;

      IF v_existing_workspace_id = v_workspace_id THEN
        RETURN pg_catalog.jsonb_build_object(
          'workspace_id', v_workspace_id,
          'member_id', v_member_id
        );
      END IF;

      RAISE EXCEPTION 'already_in_workspace' USING ERRCODE = '23505';
  END;

  RETURN pg_catalog.jsonb_build_object(
    'workspace_id', v_workspace_id,
    'member_id', v_member_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_workspace_join_code(workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_pretty text;
  v_attempt integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF workspace_id IS NULL THEN
    RAISE EXCEPTION 'join_code_rotate_failed' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id = workspace_id
      AND w.created_by = v_user_id
  ) THEN
    RAISE EXCEPTION 'join_code_rotate_failed' USING ERRCODE = '42501';
  END IF;

  FOR v_attempt IN 1..8 LOOP
    v_pretty := private.generate_join_code();

    BEGIN
      UPDATE public.workspaces
      SET join_code_hash = private.hash_join_code(v_pretty)
      WHERE id = workspace_id;
      EXIT;
    EXCEPTION
      WHEN unique_violation THEN
        IF v_attempt = 8 THEN
          RAISE EXCEPTION 'join_code_rotate_failed' USING ERRCODE = '23505';
        END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('join_code', v_pretty);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_handoff(
  recipient_member_id uuid,
  original_filename text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_name text := pg_catalog.btrim(original_filename);
  v_sender_id uuid;
  v_workspace_id uuid;
  v_recipient_workspace uuid;
  v_handoff_id uuid;
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) = 0
     OR pg_catalog.char_length(v_name) > 255
     OR v_name ~ '[\\/]'
     OR v_name LIKE '%..%'
     OR original_filename ~ '[[:cntrl:]]'
     OR original_filename ~ '[. ]$'
     OR pg_catalog.upper(
          CASE
            WHEN v_name ~ '\.[^.]+$' THEN pg_catalog.regexp_replace(v_name, '\.[^.]+$', '')
            ELSE v_name
          END
        ) IN (
          'CON', 'PRN', 'AUX', 'NUL',
          'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
          'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
        )
  THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  IF recipient_member_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id, m.workspace_id
  INTO v_sender_id, v_workspace_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT m.workspace_id
  INTO v_recipient_workspace
  FROM public.workspace_members m
  WHERE m.id = recipient_member_id;

  IF v_recipient_workspace IS NULL
     OR v_recipient_workspace IS DISTINCT FROM v_workspace_id
     OR recipient_member_id = v_sender_id THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.handoffs (
    workspace_id,
    sender_member_id,
    recipient_member_id,
    original_filename,
    status,
    flow_version
  )
  VALUES (
    v_workspace_id,
    v_sender_id,
    recipient_member_id,
    v_name,
    'uploading',
    1
  )
  RETURNING id INTO v_handoff_id;

  v_path := v_workspace_id::text || '/' || v_handoff_id::text || '/v1/' || v_object_id::text;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', v_handoff_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'workspace_id', v_workspace_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_handoff_with_context(
  recipient_member_id uuid,
  original_filename text,
  instruction text,
  due_on date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_name text := pg_catalog.btrim(original_filename);
  v_instruction text := pg_catalog.btrim(instruction);
  v_sender_id uuid;
  v_workspace_id uuid;
  v_recipient_workspace uuid;
  v_handoff_id uuid;
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_instruction IS NULL
     OR pg_catalog.char_length(v_instruction) < 1
     OR pg_catalog.char_length(v_instruction) > 280
     OR v_instruction ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'instruction_required' USING ERRCODE = '22023';
  END IF;

  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) = 0
     OR pg_catalog.char_length(v_name) > 255
     OR v_name ~ '[\\/]'
     OR v_name LIKE '%..%'
     OR original_filename ~ '[[:cntrl:]]'
     OR original_filename ~ '[. ]$'
     OR pg_catalog.upper(
          CASE
            WHEN v_name ~ '\.[^.]+$' THEN pg_catalog.regexp_replace(v_name, '\.[^.]+$', '')
            ELSE v_name
          END
        ) IN (
          'CON', 'PRN', 'AUX', 'NUL',
          'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
          'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
        )
  THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  IF recipient_member_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id, m.workspace_id
  INTO v_sender_id, v_workspace_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT m.workspace_id
  INTO v_recipient_workspace
  FROM public.workspace_members m
  WHERE m.id = recipient_member_id;

  IF v_recipient_workspace IS NULL
     OR v_recipient_workspace IS DISTINCT FROM v_workspace_id
     OR recipient_member_id = v_sender_id THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.handoffs (
    workspace_id,
    sender_member_id,
    recipient_member_id,
    original_filename,
    instruction,
    due_on,
    status,
    flow_version
  )
  VALUES (
    v_workspace_id,
    v_sender_id,
    recipient_member_id,
    v_name,
    v_instruction,
    create_handoff_with_context.due_on,
    'uploading',
    1
  )
  RETURNING id INTO v_handoff_id;

  v_path := v_workspace_id::text || '/' || v_handoff_id::text || '/v1/' || v_object_id::text;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', v_handoff_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'workspace_id', v_workspace_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_handoff_v1(
  handoff_id uuid,
  object_id uuid,
  file_size bigint,
  blake3 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_path text;
  v_object_size bigint;
  v_object_owner_id text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(blake3));
  v_file_name text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(finalize_handoff_v1.handoff_id);

  IF handoff_id IS NULL OR object_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF file_size IS NULL OR file_size <= 0 OR file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.sender_member_id, h.workspace_id, h.status, h.original_filename
  INTO v_sender_id, v_workspace_id, v_status, v_file_name
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = finalize_handoff_v1.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'sent'
     AND EXISTS (
       SELECT 1 FROM public.handoff_versions v
       WHERE v.handoff_id = finalize_handoff_v1.handoff_id
         AND v.version_number = 1
     ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  IF v_status IS DISTINCT FROM 'uploading' THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.handoff_versions v
    WHERE v.handoff_id = finalize_handoff_v1.handoff_id
      AND v.version_number = 1
  ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  v_path := v_workspace_id::text || '/' || finalize_handoff_v1.handoff_id::text
    || '/v1/' || object_id::text;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM v_user_id::text THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_object_size IS DISTINCT FROM file_size THEN
    RAISE EXCEPTION 'handoff_object_size_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM private.insert_handoff_version(
    finalize_handoff_v1.handoff_id,
    1,
    v_path,
    file_size,
    v_hash,
    v_sender_id,
    v_file_name
  );

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (finalize_handoff_v1.handoff_id, v_sender_id, 'finalized');

  UPDATE public.handoffs
  SET status = 'sent'
  WHERE id = finalize_handoff_v1.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', finalize_handoff_v1.handoff_id,
    'status', 'sent'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_handoff(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(fail_handoff.handoff_id);

  SELECT h.sender_member_id, h.status
  INTO v_sender_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = fail_handoff.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'uploading' THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'failed'
  WHERE id = fail_handoff.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (fail_handoff.handoff_id, v_sender_id, 'failed');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', fail_handoff.handoff_id,
    'status', 'failed'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_received(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(mark_handoff_received.handoff_id);

  SELECT h.recipient_member_id, h.status
  INTO v_recipient_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = mark_handoff_received.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_receive_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'received' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_received.handoff_id,
      'status', 'received'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'handoff_receive_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'received'
  WHERE id = mark_handoff_received.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_received.handoff_id, v_recipient_id, 'received');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_received.handoff_id,
    'status', 'received'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_opened(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(mark_handoff_opened.handoff_id);

  SELECT h.recipient_member_id, h.status
  INTO v_recipient_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = mark_handoff_opened.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'opened' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_opened.handoff_id,
      'status', 'opened'
    );
  END IF;

  IF v_status IN ('modified', 'returning', 'returned', 'return_received') THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_opened.handoff_id,
      'status', v_status
    );
  END IF;

  PERFORM private.reject_if_completed(v_status);

  IF v_status = 'revision_requested' THEN
    UPDATE public.handoffs
    SET status = 'opened'
    WHERE id = mark_handoff_opened.handoff_id;

    INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
    VALUES (mark_handoff_opened.handoff_id, v_recipient_id, 'opened');

    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_opened.handoff_id,
      'status', 'opened'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'opened'
  WHERE id = mark_handoff_opened.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_opened.handoff_id, v_recipient_id, 'opened');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_opened.handoff_id,
    'status', 'opened'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_modified(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(mark_handoff_modified.handoff_id);

  SELECT h.recipient_member_id, h.status
  INTO v_recipient_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = mark_handoff_modified.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_modify_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'modified' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_modified.handoff_id,
      'status', 'modified'
    );
  END IF;

  PERFORM private.reject_if_completed(v_status);

  IF v_status NOT IN ('opened', 'received', 'revision_requested') THEN
    RAISE EXCEPTION 'handoff_modify_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'modified'
  WHERE id = mark_handoff_modified.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_modified.handoff_id, v_recipient_id, 'modified');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_modified.handoff_id,
    'status', 'modified'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_handoff_unmodified(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(mark_handoff_unmodified.handoff_id);

  SELECT h.recipient_member_id, h.status
  INTO v_recipient_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = mark_handoff_unmodified.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_unmodify_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'opened' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_handoff_unmodified.handoff_id,
      'status', 'opened'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'modified' THEN
    RAISE EXCEPTION 'handoff_unmodify_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'opened'
  WHERE id = mark_handoff_unmodified.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_handoff_unmodified.handoff_id, v_recipient_id, 'restored');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_handoff_unmodified.handoff_id,
    'status', 'opened'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_handoff_return(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(begin_handoff_return.handoff_id);

  SELECT h.recipient_member_id, h.workspace_id, h.status
  INTO v_recipient_id, v_workspace_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = begin_handoff_return.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'modified' THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_workspace_id::text || '/' || begin_handoff_return.handoff_id::text
    || '/v2/' || v_object_id::text;

  UPDATE public.handoffs
  SET status = 'returning'
  WHERE id = begin_handoff_return.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (begin_handoff_return.handoff_id, v_recipient_id, 'returning');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', begin_handoff_return.handoff_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'status', 'returning'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_handoff_return_next(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_next integer;
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(begin_handoff_return_next.handoff_id);

  SELECT h.recipient_member_id, h.workspace_id, h.status
  INTO v_recipient_id, v_workspace_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = begin_handoff_return_next.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_completed(v_status);

  IF v_status IS DISTINCT FROM 'modified' THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.max(v.version_number), 0) + 1
  INTO v_next
  FROM public.handoff_versions v
  WHERE v.handoff_id = begin_handoff_return_next.handoff_id;

  IF v_next < 2 OR v_next > 1000 THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_workspace_id::text || '/' || begin_handoff_return_next.handoff_id::text
    || '/v' || v_next::text || '/' || v_object_id::text;

  UPDATE public.handoffs
  SET status = 'returning'
  WHERE id = begin_handoff_return_next.handoff_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    event_type,
    version_number
  )
  VALUES (
    begin_handoff_return_next.handoff_id,
    v_recipient_id,
    'returning',
    v_next
  );

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', begin_handoff_return_next.handoff_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'version_number', v_next,
    'status', 'returning'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_handoff_return_v2(
  handoff_id uuid,
  object_id uuid,
  file_size bigint,
  blake3 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_path text;
  v_object_size bigint;
  v_object_owner_id text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(blake3));
  v_file_name text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(finalize_handoff_return_v2.handoff_id);

  IF handoff_id IS NULL OR object_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF file_size IS NULL OR file_size <= 0 OR file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.recipient_member_id, h.workspace_id, h.status, h.original_filename
  INTO v_recipient_id, v_workspace_id, v_status, v_file_name
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = finalize_handoff_return_v2.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'returned'
     AND EXISTS (
       SELECT 1 FROM public.handoff_versions v
       WHERE v.handoff_id = finalize_handoff_return_v2.handoff_id
         AND v.version_number = 2
     ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  IF v_status IS DISTINCT FROM 'returning' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.handoff_versions v
    WHERE v.handoff_id = finalize_handoff_return_v2.handoff_id
      AND v.version_number = 2
  ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  v_path := v_workspace_id::text || '/' || finalize_handoff_return_v2.handoff_id::text
    || '/v2/' || object_id::text;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM v_user_id::text THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_object_size IS DISTINCT FROM file_size THEN
    RAISE EXCEPTION 'handoff_object_size_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM private.insert_handoff_version(
    finalize_handoff_return_v2.handoff_id,
    2,
    v_path,
    file_size,
    v_hash,
    v_recipient_id,
    v_file_name
  );

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (finalize_handoff_return_v2.handoff_id, v_recipient_id, 'returned');

  UPDATE public.handoffs
  SET status = 'returned'
  WHERE id = finalize_handoff_return_v2.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', finalize_handoff_return_v2.handoff_id,
    'status', 'returned'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_handoff_return(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(fail_handoff_return.handoff_id);

  SELECT h.recipient_member_id, h.status
  INTO v_recipient_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = fail_handoff_return.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'returning' THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'modified'
  WHERE id = fail_handoff_return.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (fail_handoff_return.handoff_id, v_recipient_id, 'return_failed');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', fail_handoff_return.handoff_id,
    'status', 'modified'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_return_received(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(mark_return_received.handoff_id);

  SELECT h.sender_member_id, h.status
  INTO v_sender_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = mark_return_received.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_receive_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'return_received' THEN
    RETURN pg_catalog.jsonb_build_object(
      'handoff_id', mark_return_received.handoff_id,
      'status', 'return_received'
    );
  END IF;

  IF v_status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'handoff_return_receive_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET status = 'return_received'
  WHERE id = mark_return_received.handoff_id;

  INSERT INTO public.handoff_events (handoff_id, actor_member_id, event_type)
  VALUES (mark_return_received.handoff_id, v_sender_id, 'return_received');

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', mark_return_received.handoff_id,
    'status', 'return_received'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_handoff_return(
  handoff_id uuid,
  version_number integer,
  object_id uuid,
  file_size bigint,
  blake3 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_recipient_id uuid;
  v_workspace_id uuid;
  v_status text;
  v_expected integer;
  v_path text;
  v_object_size bigint;
  v_object_owner_id text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(blake3));
  v_file_name text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(finalize_handoff_return.handoff_id);

  IF handoff_id IS NULL OR object_id IS NULL OR version_number IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF version_number < 2 OR version_number > 1000 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF file_size IS NULL OR file_size <= 0 OR file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.recipient_member_id, h.workspace_id, h.status, h.original_filename
  INTO v_recipient_id, v_workspace_id, v_status, v_file_name
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.recipient_member_id
  WHERE h.id = finalize_handoff_return.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_completed(v_status);

  SELECT COALESCE(pg_catalog.max(v.version_number), 0) + 1
  INTO v_expected
  FROM public.handoff_versions v
  WHERE v.handoff_id = finalize_handoff_return.handoff_id;

  IF v_status = 'returned'
     AND EXISTS (
       SELECT 1 FROM public.handoff_versions v
       WHERE v.handoff_id = finalize_handoff_return.handoff_id
         AND v.version_number = finalize_handoff_return.version_number
     ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  IF v_status IS DISTINCT FROM 'returning' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF finalize_handoff_return.version_number IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.handoff_versions v
    WHERE v.handoff_id = finalize_handoff_return.handoff_id
      AND v.version_number = finalize_handoff_return.version_number
  ) THEN
    RAISE EXCEPTION 'handoff_already_finalized' USING ERRCODE = '23505';
  END IF;

  v_path := v_workspace_id::text || '/' || finalize_handoff_return.handoff_id::text
    || '/v' || finalize_handoff_return.version_number::text || '/' || object_id::text;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM v_user_id::text THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_object_size IS DISTINCT FROM file_size THEN
    RAISE EXCEPTION 'handoff_object_size_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM private.insert_handoff_version(
    finalize_handoff_return.handoff_id,
    finalize_handoff_return.version_number,
    v_path,
    file_size,
    v_hash,
    v_recipient_id,
    v_file_name
  );

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    event_type,
    version_number
  )
  VALUES (
    finalize_handoff_return.handoff_id,
    v_recipient_id,
    'returned',
    finalize_handoff_return.version_number
  );

  UPDATE public.handoffs
  SET status = 'returned'
  WHERE id = finalize_handoff_return.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', finalize_handoff_return.handoff_id,
    'status', 'returned',
    'version_number', finalize_handoff_return.version_number
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_handoff(handoff_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_status text;
  v_version integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(complete_handoff.handoff_id);

  SELECT h.sender_member_id, h.status
  INTO v_sender_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = complete_handoff.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_completed(v_status);

  IF v_status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.max(v.version_number)
  INTO v_version
  FROM public.handoff_versions v
  WHERE v.handoff_id = complete_handoff.handoff_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    event_type,
    version_number
  )
  VALUES (
    complete_handoff.handoff_id,
    v_sender_id,
    'completed',
    v_version
  );

  UPDATE public.handoffs
  SET status = 'completed'
  WHERE id = complete_handoff.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', complete_handoff.handoff_id,
    'status', 'completed'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_revision(handoff_id uuid, note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sender_id uuid;
  v_status text;
  v_note text := pg_catalog.btrim(note);
  v_version integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_flow_v2(request_revision.handoff_id);

  IF v_note IS NULL
     OR pg_catalog.char_length(v_note) < 1
     OR pg_catalog.char_length(v_note) > 500
     OR v_note ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'revision_note_required' USING ERRCODE = '22023';
  END IF;

  SELECT h.sender_member_id, h.status
  INTO v_sender_id, v_status
  FROM public.handoffs h
  JOIN public.workspace_members m ON m.id = h.sender_member_id
  WHERE h.id = request_revision.handoff_id
    AND m.user_id = v_user_id
  FOR UPDATE;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '42501';
  END IF;

  PERFORM private.reject_if_completed(v_status);

  IF v_status IS DISTINCT FROM 'returned' THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.max(v.version_number)
  INTO v_version
  FROM public.handoff_versions v
  WHERE v.handoff_id = request_revision.handoff_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    event_type,
    note,
    version_number
  )
  VALUES (
    request_revision.handoff_id,
    v_sender_id,
    'revision_requested',
    v_note,
    v_version
  );

  UPDATE public.handoffs
  SET status = 'revision_requested'
  WHERE id = request_revision.handoff_id;

  RETURN pg_catalog.jsonb_build_object(
    'handoff_id', request_revision.handoff_id,
    'status', 'revision_requested'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_handoff_v2(
  p_recipient_member_id uuid,
  p_original_filename text,
  p_requested_action text,
  p_instruction text,
  p_due_on date,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_name text := pg_catalog.btrim(p_original_filename);
  v_instruction text := pg_catalog.btrim(p_instruction);
  v_action text := pg_catalog.btrim(p_requested_action);
  v_sender_id uuid;
  v_workspace_id uuid;
  v_recipient_workspace uuid;
  v_handoff_id uuid := pg_catalog.gen_random_uuid();
  v_transfer_id uuid := pg_catalog.gen_random_uuid();
  v_object_id uuid := pg_catalog.gen_random_uuid();
  v_path text;
  v_expires timestamptz := pg_catalog.now() + interval '60 minutes';
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_instruction IS NULL
     OR pg_catalog.char_length(v_instruction) < 1
     OR pg_catalog.char_length(v_instruction) > 280
     OR v_instruction ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'instruction_required' USING ERRCODE = '22023';
  END IF;

  IF v_action IS NULL OR v_action NOT IN ('approval', 'review', 'update') THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  IF v_name IS NULL
     OR pg_catalog.char_length(v_name) = 0
     OR pg_catalog.char_length(v_name) > 255
     OR v_name ~ '[\\/]'
     OR v_name LIKE '%..%'
     OR p_original_filename ~ '[[:cntrl:]]'
     OR p_original_filename ~ '[. ]$'
     OR pg_catalog.upper(
          CASE
            WHEN v_name ~ '\.[^.]+$' THEN pg_catalog.regexp_replace(v_name, '\.[^.]+$', '')
            ELSE v_name
          END
        ) IN (
          'CON', 'PRN', 'AUX', 'NUL',
          'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
          'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
        )
  THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  IF p_recipient_member_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id, m.workspace_id
  INTO v_sender_id, v_workspace_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT m.workspace_id
  INTO v_recipient_workspace
  FROM public.workspace_members m
  WHERE m.id = p_recipient_member_id;

  IF v_recipient_workspace IS NULL
     OR v_recipient_workspace IS DISTINCT FROM v_workspace_id
     OR p_recipient_member_id = v_sender_id THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_sender_id,
    p_client_request_id,
    'create_handoff_v2',
    private.command_fingerprint(
      p_recipient_member_id::text || E'\t' || v_name || E'\t' || v_action || E'\t'
      || v_instruction || E'\t' || COALESCE(p_due_on::text, '')
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  v_path := v_workspace_id::text || '/' || v_handoff_id::text || '/v1/' || v_object_id::text;

  INSERT INTO public.handoffs (
    id,
    workspace_id,
    sender_member_id,
    recipient_member_id,
    original_filename,
    instruction,
    due_on,
    status,
    flow_version,
    request_status,
    active_transfer_id
  )
  VALUES (
    v_handoff_id,
    v_workspace_id,
    v_sender_id,
    p_recipient_member_id,
    v_name,
    v_instruction,
    p_due_on,
    NULL,
    2,
    'open',
    v_transfer_id
  );

  INSERT INTO public.handoff_transfers (
    id,
    handoff_id,
    workspace_id,
    parent_transfer_id,
    from_member_id,
    to_member_id,
    requested_action,
    instruction,
    due_on,
    status,
    pending_object_id,
    pending_version_number,
    pending_storage_path,
    pending_upload_expires_at
  )
  VALUES (
    v_transfer_id,
    v_handoff_id,
    v_workspace_id,
    NULL,
    v_sender_id,
    p_recipient_member_id,
    v_action,
    v_instruction,
    p_due_on,
    'preparing',
    v_object_id,
    1,
    v_path,
    v_expires
  );

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    v_handoff_id,
    v_sender_id,
    v_transfer_id,
    p_client_request_id,
    'created'
  );

  v_result := pg_catalog.jsonb_build_object(
    'handoff_id', v_handoff_id,
    'transfer_id', v_transfer_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'pending_upload_expires_at', v_expires
  );

  PERFORM private.finish_command_receipt(v_receipt_id, v_result, v_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_handoff_v2_initial(
  p_handoff_id uuid,
  p_object_id uuid,
  p_file_size bigint,
  p_blake3 text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_workspace_id uuid;
  v_transfer_id uuid;
  v_status text;
  v_pending_object uuid;
  v_pending_version integer;
  v_pending_path text;
  v_path text;
  v_hash text := pg_catalog.lower(pg_catalog.btrim(p_blake3));
  v_object_size bigint;
  v_object_owner_id text;
  v_file_name text;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_object_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'finalize_handoff_v2_initial',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || p_object_id::text || E'\t'
      || p_file_size::text || E'\t' || v_hash
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT h.workspace_id, h.active_transfer_id, t.status, t.from_member_id,
         t.pending_object_id, t.pending_version_number, t.pending_storage_path
  INTO v_workspace_id, v_transfer_id, v_status, v_actor_id,
       v_pending_object, v_pending_version, v_pending_path
  FROM public.handoffs h
  JOIN public.handoff_transfers t ON t.id = h.active_transfer_id
  JOIN public.workspace_members m ON m.id = t.from_member_id
  WHERE h.id = p_handoff_id
    AND h.flow_version = 2
    AND h.request_status = 'open'
    AND m.user_id = v_user_id
  FOR UPDATE OF h;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT h.original_filename
  INTO v_file_name
  FROM public.handoffs h
  WHERE h.id = p_handoff_id;

  IF v_status = 'active'
     AND EXISTS (
       SELECT 1 FROM public.handoff_versions v
       WHERE v.handoff_id = p_handoff_id
         AND v.version_number = 1
         AND v.storage_path = v_pending_path
     ) THEN
    v_result := pg_catalog.jsonb_build_object(
      'request_status', 'open',
      'transfer_status', 'active',
      'version_number', 1
    );
    PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_transfer_id);
    RETURN v_result;
  END IF;

  IF v_status IS DISTINCT FROM 'preparing'
     OR v_pending_object IS DISTINCT FROM p_object_id
     OR v_pending_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_workspace_id::text || '/' || p_handoff_id::text || '/v1/' || p_object_id::text;
  IF v_pending_path IS DISTINCT FROM v_path
     OR p_object_id::text IS DISTINCT FROM pg_catalog.split_part(v_path, '/', 4) THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT (o.metadata->>'size')::bigint, o.owner_id
  INTO v_object_size, v_object_owner_id
  FROM storage.objects o
  WHERE o.bucket_id = 'filerelay'
    AND o.name = v_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_object_missing' USING ERRCODE = 'P0001';
  END IF;

  IF v_object_owner_id IS DISTINCT FROM v_user_id::text THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_object_size IS DISTINCT FROM p_file_size THEN
    RAISE EXCEPTION 'handoff_object_size_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM private.insert_handoff_version(
    p_handoff_id,
    1,
    v_path,
    p_file_size,
    v_hash,
    v_actor_id,
    v_file_name
  );

  UPDATE public.handoff_transfers
  SET status = 'active',
      pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    version_number
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_transfer_id,
    p_client_request_id,
    'finalized',
    1
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'open',
    'transfer_status', 'active',
    'version_number', 1
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_handoff_v2_initial(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_transfer_id uuid;
  v_status text;
  v_pending_path text;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
  v_object_exists boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'fail_handoff_v2_initial',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT h.active_transfer_id, t.status, t.from_member_id, t.pending_storage_path
  INTO v_transfer_id, v_status, v_actor_id, v_pending_path
  FROM public.handoffs h
  JOIN public.handoff_transfers t ON t.id = h.active_transfer_id
  JOIN public.workspace_members m ON m.id = t.from_member_id
  WHERE h.id = p_handoff_id
    AND h.flow_version = 2
    AND h.request_status = 'open'
    AND m.user_id = v_user_id
  FOR UPDATE OF h;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'failed' AND v_pending_path IS NULL THEN
    v_result := pg_catalog.jsonb_build_object('transfer_status', 'failed');
    PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_transfer_id);
    RETURN v_result;
  END IF;

  IF v_status IS DISTINCT FROM 'preparing' AND v_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '22023';
  END IF;

  IF v_pending_path IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM storage.objects o
      WHERE o.bucket_id = 'filerelay'
        AND o.name = v_pending_path
    )
    INTO v_object_exists;

    IF v_object_exists THEN
      RAISE EXCEPTION 'handoff_abort_cleanup_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.handoff_transfers
  SET status = 'failed',
      pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_transfer_id,
    p_client_request_id,
    'failed'
  );

  v_result := pg_catalog.jsonb_build_object('transfer_status', 'failed');
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.retry_handoff_v2_initial(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_workspace_id uuid;
  v_transfer_id uuid;
  v_status text;
  v_pending_object uuid;
  v_pending_version integer;
  v_pending_path text;
  v_pending_expires timestamptz;
  v_object_id uuid;
  v_path text;
  v_expires timestamptz;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_retry_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_retry_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'retry_handoff_v2_initial',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT h.workspace_id, h.active_transfer_id, t.status, t.from_member_id,
         t.pending_object_id, t.pending_version_number,
         t.pending_storage_path, t.pending_upload_expires_at
  INTO v_workspace_id, v_transfer_id, v_status, v_actor_id,
       v_pending_object, v_pending_version, v_pending_path, v_pending_expires
  FROM public.handoffs h
  JOIN public.handoff_transfers t ON t.id = h.active_transfer_id
  JOIN public.workspace_members m ON m.id = t.from_member_id
  WHERE h.id = p_handoff_id
    AND h.flow_version = 2
    AND h.request_status = 'open'
    AND m.user_id = v_user_id
  FOR UPDATE OF h;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'handoff_retry_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'handoff_retry_failed' USING ERRCODE = '22023';
  END IF;

  IF v_pending_object IS NOT NULL
     OR v_pending_version IS NOT NULL
     OR v_pending_path IS NOT NULL
     OR v_pending_expires IS NOT NULL THEN
    RAISE EXCEPTION 'reservation_still_held' USING ERRCODE = 'P0001';
  END IF;

  v_object_id := pg_catalog.gen_random_uuid();
  v_expires := pg_catalog.now() + interval '60 minutes';
  v_path := v_workspace_id::text || '/' || p_handoff_id::text || '/v1/' || v_object_id::text;

  UPDATE public.handoff_transfers
  SET status = 'preparing',
      pending_object_id = v_object_id,
      pending_version_number = 1,
      pending_storage_path = v_path,
      pending_upload_expires_at = v_expires
  WHERE id = v_transfer_id;

  v_result := pg_catalog.jsonb_build_object(
    'handoff_id', p_handoff_id,
    'transfer_id', v_transfer_id,
    'object_id', v_object_id,
    'storage_path', v_path,
    'pending_upload_expires_at', v_expires
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_transfer_reminder(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_transfer_id uuid;
  v_status text;
  v_last timestamptz;
  v_sent timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'reminder_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'reminder_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'send_transfer_reminder',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT h.active_transfer_id, t.status, t.from_member_id, t.last_reminder_at
  INTO v_transfer_id, v_status, v_actor_id, v_last
  FROM public.handoffs h
  JOIN public.handoff_transfers t ON t.id = h.active_transfer_id
  JOIN public.workspace_members m ON m.id = t.from_member_id
  WHERE h.id = p_handoff_id
    AND h.flow_version = 2
    AND h.request_status = 'open'
    AND m.user_id = v_user_id
  FOR UPDATE OF h;

  IF v_transfer_id IS NULL THEN
    RAISE EXCEPTION 'reminder_failed' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'reminder_failed' USING ERRCODE = '22023';
  END IF;

  IF v_last IS NOT NULL AND v_last > v_sent - interval '10 minutes' THEN
    RAISE EXCEPTION 'reminder_cooldown' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.handoff_transfers
  SET last_reminder_at = v_sent
  WHERE id = v_transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_transfer_id,
    p_client_request_id,
    'reminder_sent'
  );

  v_result := pg_catalog.jsonb_build_object(
    'sent_at', v_sent,
    'next_allowed_at', v_sent + interval '10 minutes'
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

-- M10C-FUNCTIONS-START
CREATE OR REPLACE FUNCTION private.assert_result_matches_request(
  p_requested_action text,
  p_result_action text
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_requested_action = 'approval'
     AND p_result_action IN ('approved', 'rejected') THEN
    RETURN;
  END IF;

  IF p_requested_action = 'review'
     AND p_result_action IN ('review_completed', 'rejected') THEN
    RETURN;
  END IF;

  IF p_requested_action = 'update'
     AND p_result_action IN ('returned_with_file', 'returned_with_reply', 'rejected') THEN
    RETURN;
  END IF;

  IF p_requested_action = 'file_request'
     AND p_result_action IN ('returned_with_file', 'rejected') THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'result_action_mismatch' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_v2_open_root(p_handoff_id uuid)
RETURNS TABLE (
  workspace_id uuid,
  sender_member_id uuid,
  transfer_id uuid,
  transfer_status text,
  from_member_id uuid,
  to_member_id uuid,
  requested_action text,
  handling_round integer,
  result_action text,
  result_note text,
  result_version_number integer,
  pending_object_id uuid,
  pending_version_number integer,
  pending_storage_path text,
  pending_upload_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace uuid;
  v_sender uuid;
  v_recipient uuid;
  v_flow smallint;
  v_request text;
  v_active uuid;
  v_parent uuid;
BEGIN
  IF p_handoff_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.workspace_id, h.sender_member_id, h.recipient_member_id,
         h.flow_version, h.request_status, h.active_transfer_id
  INTO v_workspace, v_sender, v_recipient, v_flow, v_request, v_active
  FROM public.handoffs h
  WHERE h.id = p_handoff_id
  FOR UPDATE OF h;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  IF v_flow IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  IF v_request = 'completed' THEN
    RAISE EXCEPTION 'handoff_already_completed' USING ERRCODE = '22023';
  END IF;

  IF v_request = 'cancelled' THEN
    RAISE EXCEPTION 'handoff_already_cancelled' USING ERRCODE = '22023';
  END IF;

  IF v_request IS DISTINCT FROM 'open' OR v_active IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.workspace_members m
    WHERE m.user_id = auth.uid()
      AND m.id IN (v_sender, v_recipient)
  ) THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  SELECT t.id, t.status, t.from_member_id, t.to_member_id, t.requested_action,
         t.handling_round, t.result_action, t.result_note, t.result_version_number,
         t.pending_object_id, t.pending_version_number, t.pending_storage_path,
         t.pending_upload_expires_at, t.parent_transfer_id
  INTO transfer_id, transfer_status, from_member_id, to_member_id, requested_action,
       handling_round, result_action, result_note, result_version_number,
       pending_object_id, pending_version_number, pending_storage_path,
       pending_upload_expires_at, v_parent
  FROM public.handoff_transfers t
  WHERE t.id = v_active
    AND t.handoff_id = p_handoff_id
  FOR UPDATE OF t;

  IF transfer_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  IF v_parent IS NOT NULL THEN
    RAISE EXCEPTION 'not_root_transfer' USING ERRCODE = '22023';
  END IF;

  workspace_id := v_workspace;
  sender_member_id := v_sender;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_root_transfer_opened(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_event_id uuid;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'mark_root_transfer_opened',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.requested_action = 'file_request'
     AND v_hop.transfer_status = 'active' THEN
    RAISE EXCEPTION 'file_request_not_yet_supplied' USING ERRCODE = '22023';
  END IF;

  IF v_hop.transfer_status = 'active'
     AND v_hop.to_member_id = v_actor_id THEN
    NULL;
  ELSIF v_hop.transfer_status = 'returned_to_sender'
     AND v_hop.from_member_id = v_actor_id
     AND v_hop.result_version_number IS NOT NULL THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'handoff_open_failed' USING ERRCODE = '42501';
  END IF;

  SELECT e.id
  INTO v_event_id
  FROM public.handoff_events e
  WHERE e.transfer_id = v_hop.transfer_id
    AND e.event_type = 'opened'
    AND e.handling_round = v_hop.handling_round;

  IF v_event_id IS NULL THEN
    BEGIN
      INSERT INTO public.handoff_events (
        handoff_id,
        actor_member_id,
        transfer_id,
        client_request_id,
        event_type,
        handling_round
      )
      VALUES (
        p_handoff_id,
        v_actor_id,
        v_hop.transfer_id,
        p_client_request_id,
        'opened',
        v_hop.handling_round
      )
      RETURNING id INTO v_event_id;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT e.id
        INTO v_event_id
        FROM public.handoff_events e
        WHERE e.transfer_id = v_hop.transfer_id
          AND e.event_type = 'opened'
          AND e.handling_round = v_hop.handling_round;
    END;
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'handling_round', v_hop.handling_round,
    'event_id', v_event_id
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_transfer_result_upload(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_object_id uuid;
  v_version integer;
  v_path text;
  v_expires timestamptz;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'begin_transfer_result_upload',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  v_expires := pg_catalog.now() + interval '60 minutes';

  IF v_hop.pending_object_id IS NOT NULL
     AND v_hop.pending_version_number IS NOT NULL
     AND v_hop.pending_storage_path IS NOT NULL
     AND v_hop.pending_upload_expires_at IS NOT NULL THEN
    UPDATE public.handoff_transfers
    SET pending_upload_expires_at = v_expires
    WHERE id = v_hop.transfer_id
      AND pending_object_id = v_hop.pending_object_id
      AND pending_version_number = v_hop.pending_version_number
      AND pending_storage_path = v_hop.pending_storage_path;

    v_result := pg_catalog.jsonb_build_object(
      'object_id', v_hop.pending_object_id,
      'version_number', v_hop.pending_version_number,
      'storage_path', v_hop.pending_storage_path,
      'pending_upload_expires_at', v_expires
    );
    PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
    RETURN v_result;
  END IF;

  v_object_id := pg_catalog.gen_random_uuid();
  SELECT COALESCE(pg_catalog.max(hv.version_number), 0) + 1
  INTO v_version
  FROM public.handoff_versions hv
  WHERE hv.handoff_id = p_handoff_id;

  IF v_version IS NULL OR v_version < 1 OR v_version > 1000 THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  v_path := v_hop.workspace_id::text || '/' || p_handoff_id::text
    || '/v' || v_version::text || '/' || v_object_id::text;

  UPDATE public.handoff_transfers
  SET pending_object_id = v_object_id,
      pending_version_number = v_version,
      pending_storage_path = v_path,
      pending_upload_expires_at = v_expires
  WHERE id = v_hop.transfer_id
    AND pending_object_id IS NULL
    AND pending_version_number IS NULL
    AND pending_storage_path IS NULL
    AND pending_upload_expires_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_still_held' USING ERRCODE = 'P0001';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'object_id', v_object_id,
    'version_number', v_version,
    'storage_path', v_path,
    'pending_upload_expires_at', v_expires
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_transfer_upload_reservation(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_expires timestamptz;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'renew_transfer_upload_reservation',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF NOT (
       (v_hop.transfer_status = 'preparing' AND v_hop.from_member_id = v_actor_id)
       OR (v_hop.transfer_status = 'active' AND v_hop.to_member_id = v_actor_id)
     ) THEN
    RAISE EXCEPTION 'handoff_return_begin_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.pending_object_id IS NULL
     OR v_hop.pending_version_number IS NULL
     OR v_hop.pending_storage_path IS NULL
     OR v_hop.pending_upload_expires_at IS NULL THEN
    RAISE EXCEPTION 'reservation_missing' USING ERRCODE = 'P0001';
  END IF;

  v_expires := pg_catalog.now() + interval '60 minutes';

  UPDATE public.handoff_transfers
  SET pending_upload_expires_at = v_expires
  WHERE id = v_hop.transfer_id
    AND pending_object_id = v_hop.pending_object_id
    AND pending_version_number = v_hop.pending_version_number
    AND pending_storage_path = v_hop.pending_storage_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_missing' USING ERRCODE = 'P0001';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'object_id', v_hop.pending_object_id,
    'version_number', v_hop.pending_version_number,
    'storage_path', v_hop.pending_storage_path,
    'pending_upload_expires_at', v_expires
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_transfer_result(
  p_handoff_id uuid,
  p_result_action text,
  p_result_note text,
  p_object_id uuid,
  p_file_size bigint,
  p_blake3 text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_action text := pg_catalog.btrim(p_result_action);
  v_note text := NULLIF(pg_catalog.btrim(p_result_note), ''::text);
  v_hash text := pg_catalog.lower(pg_catalog.btrim(p_blake3));
  v_path text;
  v_file_name text;
  v_now timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL
     OR p_object_id IS NULL
     OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL
     AND (
       pg_catalog.char_length(v_note) < 1
       OR pg_catalog.char_length(v_note) > 500
       OR v_note ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'finalize_transfer_result',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || COALESCE(v_action, '') || E'\t'
      || COALESCE(v_note, '') || E'\t' || p_object_id::text || E'\t'
      || p_file_size::text || E'\t' || v_hash
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.requested_action = 'file_request' THEN
    RAISE EXCEPTION 'result_action_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_action = 'returned_with_reply' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  PERFORM private.assert_result_matches_request(v_hop.requested_action, v_action);

  IF v_action IN ('rejected', 'returned_with_reply') AND v_note IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.original_filename
  INTO v_file_name
  FROM public.handoffs h
  WHERE h.id = p_handoff_id;

  v_path := private.assert_reserved_upload_matches(
    v_hop.workspace_id,
    p_handoff_id,
    v_user_id,
    p_object_id,
    p_file_size,
    v_hop.pending_object_id,
    v_hop.pending_version_number,
    v_hop.pending_storage_path,
    v_hash
  );

  PERFORM private.insert_handoff_version(
    p_handoff_id,
    v_hop.pending_version_number,
    v_path,
    p_file_size,
    v_hash,
    v_actor_id,
    v_file_name
  );

  IF v_action = 'approved' THEN
    UPDATE public.handoffs
    SET active_transfer_id = NULL,
        request_status = 'completed',
        closed_at = v_now
    WHERE id = p_handoff_id;

    UPDATE public.handoff_transfers
    SET status = 'closed',
        ended_at = v_now,
        result_action = 'approved',
        result_note = v_note,
        result_version_number = v_hop.pending_version_number,
        pending_object_id = NULL,
        pending_version_number = NULL,
        pending_storage_path = NULL,
        pending_upload_expires_at = NULL
    WHERE id = v_hop.transfer_id;
  ELSE
    UPDATE public.handoff_transfers
    SET status = 'returned_to_sender',
        result_action = v_action,
        result_note = v_note,
        result_version_number = v_hop.pending_version_number,
        pending_object_id = NULL,
        pending_version_number = NULL,
        pending_storage_path = NULL,
        pending_upload_expires_at = NULL
    WHERE id = v_hop.transfer_id;
  END IF;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    note,
    version_number,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    v_action,
    v_note,
    v_hop.pending_version_number,
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', CASE WHEN v_action = 'approved' THEN 'completed' ELSE 'open' END,
    'transfer_status', CASE WHEN v_action = 'approved' THEN 'closed' ELSE 'returned_to_sender' END,
    'result_action', v_action,
    'version_number', v_hop.pending_version_number
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_transfer_result_without_file(
  p_handoff_id uuid,
  p_result_action text,
  p_result_note text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_action text := pg_catalog.btrim(p_result_action);
  v_note text := NULLIF(pg_catalog.btrim(p_result_note), ''::text);
  v_now timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NOT NULL
     AND (
       pg_catalog.char_length(v_note) < 1
       OR pg_catalog.char_length(v_note) > 500
       OR v_note ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'submit_transfer_result_without_file',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || COALESCE(v_action, '') || E'\t' || COALESCE(v_note, '')
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  IF v_action = 'returned_with_file' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  PERFORM private.assert_result_matches_request(v_hop.requested_action, v_action);

  IF v_action IN ('rejected', 'returned_with_reply') AND v_note IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hop.pending_object_id IS NOT NULL
     OR v_hop.pending_version_number IS NOT NULL
     OR v_hop.pending_storage_path IS NOT NULL
     OR v_hop.pending_upload_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'reservation_still_held' USING ERRCODE = 'P0001';
  END IF;

  IF v_action = 'approved' THEN
    UPDATE public.handoffs
    SET active_transfer_id = NULL,
        request_status = 'completed',
        closed_at = v_now
    WHERE id = p_handoff_id;

    UPDATE public.handoff_transfers
    SET status = 'closed',
        ended_at = v_now,
        result_action = 'approved',
        result_note = v_note,
        result_version_number = NULL
    WHERE id = v_hop.transfer_id;
  ELSE
    UPDATE public.handoff_transfers
    SET status = 'returned_to_sender',
        result_action = v_action,
        result_note = v_note,
        result_version_number = NULL
    WHERE id = v_hop.transfer_id;
  END IF;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    note,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    v_action,
    v_note,
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', CASE WHEN v_action = 'approved' THEN 'completed' ELSE 'open' END,
    'transfer_status', CASE WHEN v_action = 'approved' THEN 'closed' ELSE 'returned_to_sender' END,
    'result_action', v_action
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.abort_transfer_result_upload(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_object_exists boolean;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'abort_transfer_result_upload',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.pending_object_id IS NULL
     AND v_hop.pending_version_number IS NULL
     AND v_hop.pending_storage_path IS NULL
     AND v_hop.pending_upload_expires_at IS NULL THEN
    v_result := pg_catalog.jsonb_build_object('transfer_status', 'active');
    PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
    RETURN v_result;
  END IF;

  IF v_hop.pending_storage_path IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM storage.objects o
      WHERE o.bucket_id = 'filerelay'
        AND o.name = v_hop.pending_storage_path
    )
    INTO v_object_exists;

    IF v_object_exists THEN
      RAISE EXCEPTION 'handoff_abort_cleanup_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.handoff_transfers
  SET pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_hop.transfer_id;

  v_result := pg_catalog.jsonb_build_object('transfer_status', 'active');
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_root_transfer_result(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_now timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'accept_root_transfer_result',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'returned_to_sender'
     OR v_hop.from_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.requested_action = 'file_request'
     AND (
       v_hop.result_action IS DISTINCT FROM 'returned_with_file'
       OR v_hop.result_version_number IS NULL
     ) THEN
    RAISE EXCEPTION 'handoff_complete_failed' USING ERRCODE = '22023';
  END IF;

  UPDATE public.handoffs
  SET active_transfer_id = NULL,
      request_status = 'completed',
      closed_at = v_now
  WHERE id = p_handoff_id;

  UPDATE public.handoff_transfers
  SET status = 'closed',
      ended_at = v_now
  WHERE id = v_hop.transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'completed',
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'completed',
    'transfer_status', 'closed'
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_root_transfer_revision(
  p_handoff_id uuid,
  p_note text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_note text := pg_catalog.btrim(p_note);
  v_next_round integer;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '22023';
  END IF;

  IF v_note IS NULL
     OR pg_catalog.char_length(v_note) < 1
     OR pg_catalog.char_length(v_note) > 500
     OR v_note ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'revision_note_required' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'request_root_transfer_revision',
    private.command_fingerprint(p_handoff_id::text || E'\t' || v_note)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.transfer_status IS DISTINCT FROM 'returned_to_sender'
     OR v_hop.from_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_revision_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.handling_round >= 1000 THEN
    RAISE EXCEPTION 'handling_round_limit' USING ERRCODE = '22023';
  END IF;

  v_next_round := v_hop.handling_round + 1;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    note,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'revision_requested',
    v_note,
    v_hop.handling_round
  );

  UPDATE public.handoff_transfers
  SET status = 'active',
      handling_round = v_next_round,
      result_action = NULL,
      result_note = NULL,
      result_version_number = NULL
  WHERE id = v_hop.transfer_id;

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'open',
    'transfer_status', 'active',
    'handling_round', v_next_round
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_root_handoff_v2(
  p_handoff_id uuid,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_object_exists boolean;
  v_now timestamptz := pg_catalog.now();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'cancel_root_handoff_v2',
    private.command_fingerprint(p_handoff_id::text)
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.sender_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_fail_failed' USING ERRCODE = '42501';
  END IF;

  IF v_hop.pending_storage_path IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM storage.objects o
      WHERE o.bucket_id = 'filerelay'
        AND o.name = v_hop.pending_storage_path
    )
    INTO v_object_exists;

    IF v_object_exists THEN
      RAISE EXCEPTION 'handoff_abort_cleanup_required' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.handoffs
  SET active_transfer_id = NULL,
      request_status = 'cancelled',
      cancelled_at = v_now
  WHERE id = p_handoff_id;

  UPDATE public.handoff_transfers
  SET status = 'closed',
      ended_at = v_now,
      pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_hop.transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'cancelled'
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'cancelled',
    'transfer_status', 'closed'
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;
-- M10C-FUNCTIONS-END


-- M10C-A2-FUNCTIONS-START
CREATE OR REPLACE FUNCTION public.create_file_request_v2(
  p_recipient_member_id uuid,
  p_instruction text,
  p_due_on date,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_instruction text := pg_catalog.btrim(p_instruction);
  v_sender_id uuid;
  v_workspace_id uuid;
  v_recipient_workspace uuid;
  v_handoff_id uuid := pg_catalog.gen_random_uuid();
  v_transfer_id uuid := pg_catalog.gen_random_uuid();
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF v_instruction IS NULL
     OR pg_catalog.char_length(v_instruction) < 1
     OR pg_catalog.char_length(v_instruction) > 280
     OR v_instruction ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'instruction_required' USING ERRCODE = '22023';
  END IF;

  IF p_recipient_member_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '22023';
  END IF;

  SELECT m.id, m.workspace_id
  INTO v_sender_id, v_workspace_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_sender_id IS NULL THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT m.workspace_id
  INTO v_recipient_workspace
  FROM public.workspace_members m
  WHERE m.id = p_recipient_member_id;

  IF v_recipient_workspace IS NULL
     OR v_recipient_workspace IS DISTINCT FROM v_workspace_id
     OR p_recipient_member_id = v_sender_id THEN
    RAISE EXCEPTION 'handoff_create_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_sender_id,
    p_client_request_id,
    'create_file_request_v2',
    private.command_fingerprint(
      p_recipient_member_id::text || E'\t' || v_instruction || E'\t'
      || COALESCE(p_due_on::text, '')
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  INSERT INTO public.handoffs (
    id,
    workspace_id,
    sender_member_id,
    recipient_member_id,
    original_filename,
    instruction,
    due_on,
    status,
    flow_version,
    request_status,
    active_transfer_id
  )
  VALUES (
    v_handoff_id,
    v_workspace_id,
    v_sender_id,
    p_recipient_member_id,
    NULL,
    v_instruction,
    p_due_on,
    NULL,
    2,
    'open',
    v_transfer_id
  );

  INSERT INTO public.handoff_transfers (
    id,
    handoff_id,
    workspace_id,
    parent_transfer_id,
    from_member_id,
    to_member_id,
    requested_action,
    instruction,
    due_on,
    status
  )
  VALUES (
    v_transfer_id,
    v_handoff_id,
    v_workspace_id,
    NULL,
    v_sender_id,
    p_recipient_member_id,
    'file_request',
    v_instruction,
    p_due_on,
    'active'
  );

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type
  )
  VALUES (
    v_handoff_id,
    v_sender_id,
    v_transfer_id,
    p_client_request_id,
    'created'
  );

  v_result := pg_catalog.jsonb_build_object(
    'handoff_id', v_handoff_id,
    'transfer_id', v_transfer_id
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, v_handoff_id, v_transfer_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_file_request_result(
  p_handoff_id uuid,
  p_file_name text,
  p_object_id uuid,
  p_file_size bigint,
  p_blake3 text,
  p_client_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_actor_id uuid;
  v_hop record;
  v_name text := NULLIF(pg_catalog.btrim(p_file_name), ''::text);
  v_hash text := pg_catalog.lower(pg_catalog.btrim(p_blake3));
  v_path text;
  v_won boolean;
  v_receipt_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF p_handoff_id IS NULL
     OR p_object_id IS NULL
     OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '22023';
  END IF;

  PERFORM private.assert_safe_file_name(v_name);

  SELECT m.id
  INTO v_actor_id
  FROM public.workspace_members m
  WHERE m.user_id = v_user_id;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  SELECT c.won, c.receipt_id, c.existing_result
  INTO v_won, v_receipt_id, v_existing
  FROM private.claim_command_receipt(
    v_actor_id,
    p_client_request_id,
    'finalize_file_request_result',
    private.command_fingerprint(
      p_handoff_id::text || E'\t' || v_name || E'\t' || p_object_id::text || E'\t'
      || p_file_size::text || E'\t' || v_hash
    )
  ) AS c;

  IF NOT v_won THEN
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_incomplete' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_existing;
  END IF;

  SELECT * INTO v_hop FROM private.assert_v2_open_root(p_handoff_id);

  IF v_hop.requested_action IS DISTINCT FROM 'file_request' THEN
    RAISE EXCEPTION 'result_action_mismatch' USING ERRCODE = '22023';
  END IF;

  IF v_hop.transfer_status IS DISTINCT FROM 'active'
     OR v_hop.to_member_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'handoff_return_finalize_failed' USING ERRCODE = '42501';
  END IF;

  v_path := private.assert_reserved_upload_matches(
    v_hop.workspace_id,
    p_handoff_id,
    v_user_id,
    p_object_id,
    p_file_size,
    v_hop.pending_object_id,
    v_hop.pending_version_number,
    v_hop.pending_storage_path,
    v_hash
  );

  PERFORM private.insert_handoff_version(
    p_handoff_id,
    v_hop.pending_version_number,
    v_path,
    p_file_size,
    v_hash,
    v_actor_id,
    v_name
  );

  UPDATE public.handoff_transfers
  SET status = 'returned_to_sender',
      result_action = 'returned_with_file',
      result_note = NULL,
      result_version_number = v_hop.pending_version_number,
      pending_object_id = NULL,
      pending_version_number = NULL,
      pending_storage_path = NULL,
      pending_upload_expires_at = NULL
  WHERE id = v_hop.transfer_id;

  INSERT INTO public.handoff_events (
    handoff_id,
    actor_member_id,
    transfer_id,
    client_request_id,
    event_type,
    version_number,
    handling_round
  )
  VALUES (
    p_handoff_id,
    v_actor_id,
    v_hop.transfer_id,
    p_client_request_id,
    'returned_with_file',
    v_hop.pending_version_number,
    v_hop.handling_round
  );

  v_result := pg_catalog.jsonb_build_object(
    'request_status', 'open',
    'transfer_status', 'returned_to_sender',
    'result_action', 'returned_with_file',
    'version_number', v_hop.pending_version_number
  );
  PERFORM private.finish_command_receipt(v_receipt_id, v_result, p_handoff_id, v_hop.transfer_id);
  RETURN v_result;
END;
$$;
-- M10C-A2-FUNCTIONS-END


REVOKE ALL ON FUNCTION public.create_workspace(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_workspace(text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rotate_workspace_join_code(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_handoff(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_handoff_v1(uuid, uuid, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_handoff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_handoff_received(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_handoff_opened(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_handoff_modified(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_handoff_unmodified(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.begin_handoff_return(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_handoff_return(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_return_received(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_handoff_with_context(uuid, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_handoff_return_next(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_handoff_return(uuid, integer, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_handoff(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_revision(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_workspace(text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_workspace_join_code(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_v1(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_handoff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_received(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_opened(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_modified(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_unmodified(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_handoff_return(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_handoff_return(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_return_received(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_handoff_with_context(uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_handoff_return_next(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_return(uuid, integer, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_handoff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_revision(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_handoff_v2(uuid, text, text, text, date, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_handoff_v2_initial(uuid, uuid, bigint, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_handoff_v2_initial(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_handoff_v2_initial(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_transfer_reminder(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_handoff_v2(uuid, text, text, text, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_v2_initial(uuid, uuid, bigint, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_handoff_v2_initial(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retry_handoff_v2_initial(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_transfer_reminder(uuid, uuid) TO authenticated;
-- M10C-GRANTS-START
REVOKE ALL ON FUNCTION private.assert_result_matches_request(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_v2_open_root(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_root_transfer_opened(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_transfer_result_upload(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_transfer_upload_reservation(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_transfer_result_upload(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_root_transfer_result(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_root_transfer_revision(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_root_handoff_v2(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_root_transfer_opened(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_transfer_result_upload(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.renew_transfer_upload_reservation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_transfer_result(uuid, text, text, uuid, bigint, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_transfer_result_without_file(uuid, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.abort_transfer_result_upload(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_root_transfer_result(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_root_transfer_revision(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_root_handoff_v2(uuid, uuid) TO authenticated;
-- M10C-GRANTS-END


-- M10C-A2-GRANTS-START
REVOKE ALL ON FUNCTION private.assert_safe_file_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.insert_handoff_version(uuid, integer, text, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_reserved_upload_matches(uuid, uuid, uuid, uuid, bigint, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_handoff_original_filename() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_file_request_v2(uuid, text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_file_request_result(uuid, text, uuid, bigint, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_file_request_v2(uuid, text, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_file_request_result(uuid, text, uuid, bigint, text, uuid) TO authenticated;
-- M10C-A2-GRANTS-END


-- 8. Storage
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('filerelay', 'filerelay', false, 52428800)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS filerelay_storage_select ON storage.objects;
CREATE POLICY filerelay_storage_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'filerelay'
    AND private.can_read_handoff_object(name)
  );

DROP POLICY IF EXISTS filerelay_storage_select_for_delete ON storage.objects;
CREATE POLICY filerelay_storage_select_for_delete
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'filerelay'
    AND private.can_delete_handoff_object(name)
    AND storage.allow_any_operation(ARRAY[
      'storage.object.delete',
      'storage.object.delete_many'
    ])
  );

DROP POLICY IF EXISTS filerelay_storage_insert ON storage.objects;
CREATE POLICY filerelay_storage_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'filerelay'
    AND private.can_upload_handoff_object(name)
  );

DROP POLICY IF EXISTS filerelay_storage_update ON storage.objects;
DROP POLICY IF EXISTS filerelay_storage_delete ON storage.objects;
CREATE POLICY filerelay_storage_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'filerelay'
    AND private.can_delete_reserved_handoff_object(name)
  );

-- 9. Realtime publication
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'workspace_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_members;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'handoffs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.handoffs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'handoff_versions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.handoff_versions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'handoff_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.handoff_events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'handoff_transfers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.handoff_transfers;
  END IF;
END
$pub$;

COMMIT;
