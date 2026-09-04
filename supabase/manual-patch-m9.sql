-- FileRelay Milestone 9 patch
-- Idempotent. Paste and run in the Supabase SQL Editor on a database that
-- already applied setup through Milestone 7 (manual-patch-m7.sql).
-- Do not use the Supabase CLI.
--
-- Adds instruction/due_on, revision_requested/completed, unlimited canonical
-- versions (1-1000), and new RPCs. Does not drop or rename legacy RPCs:
-- create_handoff(uuid, text), begin_handoff_return(uuid),
-- finalize_handoff_return_v2(uuid, uuid, bigint, text), mark_return_received(uuid).
-- Those four keep their existing signatures and 0.1.0 behavior.
-- Review uses the existing returned status. return_received remains Legacy.

BEGIN;

ALTER TABLE public.handoffs
  ADD COLUMN IF NOT EXISTS instruction text;
ALTER TABLE public.handoffs
  ADD COLUMN IF NOT EXISTS due_on date;

ALTER TABLE public.handoff_events
  ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE public.handoff_events
  ADD COLUMN IF NOT EXISTS version_number integer;

ALTER TABLE public.handoffs DROP CONSTRAINT IF EXISTS handoffs_instruction_check;
ALTER TABLE public.handoffs
  ADD CONSTRAINT handoffs_instruction_check CHECK (
    instruction IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(instruction)) BETWEEN 1 AND 280
      AND instruction !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE public.handoff_events DROP CONSTRAINT IF EXISTS handoff_events_note_check;
ALTER TABLE public.handoff_events
  ADD CONSTRAINT handoff_events_note_check CHECK (
    note IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(note)) BETWEEN 1 AND 500
      AND note !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE public.handoff_events DROP CONSTRAINT IF EXISTS handoff_events_version_number_check;
ALTER TABLE public.handoff_events
  ADD CONSTRAINT handoff_events_version_number_check CHECK (
    version_number IS NULL
    OR version_number BETWEEN 1 AND 1000
  );

DO $m9_status$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handoffs'
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%uploading%'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%return_received%'
  LOOP
    EXECUTE format('ALTER TABLE public.handoffs DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END
$m9_status$;

ALTER TABLE public.handoffs DROP CONSTRAINT IF EXISTS handoffs_status_check;
ALTER TABLE public.handoffs
  ADD CONSTRAINT handoffs_status_check CHECK (
    status IN (
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
  );

DO $m9_version$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handoff_versions'
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%version_number%'
  LOOP
    EXECUTE format('ALTER TABLE public.handoff_versions DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END
$m9_version$;

ALTER TABLE public.handoff_versions DROP CONSTRAINT IF EXISTS handoff_versions_version_number_check;
ALTER TABLE public.handoff_versions
  ADD CONSTRAINT handoff_versions_version_number_check
  CHECK (version_number BETWEEN 1 AND 1000);

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
      AND private.is_handoff_participant(h.id)
      AND private.handoff_status_visible_to_recipient(h.status)
      AND hv.handoff_id = v_handoff_id
      AND hv.version_number = v_version
      AND hv.storage_path = object_name
      AND (
        v_version = 1
        OR (
          v_version >= 2
          AND private.handoff_status_visible_to_recipient(h.status)
        )
      )
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
  );
END;
$$;

REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text)
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

REVOKE ALL ON FUNCTION private.handoff_status_visible_to_recipient(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.try_parse_handoff_object(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reject_if_completed(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.handoff_status_visible_to_recipient(text)
  TO authenticated;

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
    status
  )
  VALUES (
    v_workspace_id,
    v_sender_id,
    recipient_member_id,
    v_name,
    v_instruction,
    create_handoff_with_context.due_on,
    'uploading'
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

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

  SELECT h.recipient_member_id, h.workspace_id, h.status
  INTO v_recipient_id, v_workspace_id, v_status
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

  INSERT INTO public.handoff_versions (
    handoff_id,
    version_number,
    storage_path,
    file_size,
    blake3,
    uploaded_by_member_id
  )
  VALUES (
    finalize_handoff_return.handoff_id,
    finalize_handoff_return.version_number,
    v_path,
    file_size,
    v_hash,
    v_recipient_id
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

REVOKE ALL ON FUNCTION public.mark_handoff_opened(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_handoff_modified(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_handoff_with_context(uuid, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_handoff_return_next(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_handoff_return(uuid, integer, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_handoff(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_revision(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_handoff(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_handoff_return(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_return_received(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_handoff_opened(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_handoff_modified(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_handoff_with_context(uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_handoff_return_next(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_return(uuid, integer, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_handoff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_revision(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.begin_handoff_return(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_handoff_return_v2(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_return_received(uuid) TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_versions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.handoffs TO authenticated;
GRANT SELECT ON public.handoff_versions TO authenticated;
GRANT SELECT ON public.handoff_events TO authenticated;

COMMIT;
