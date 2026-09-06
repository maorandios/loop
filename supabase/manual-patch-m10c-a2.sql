-- FileRelay Milestone 10C-A2 patch
-- Apply once in the Supabase SQL Editor after manual-patch-m10c.sql and manual-patch-m10c-fix1.sql.
-- New projects should run supabase/manual-setup.sql instead.
-- Idempotent and safe to re-run. Do not use the Supabase CLI.
-- Adds file_request and per-version file_name. Does not rewrite storage paths.

BEGIN;

DO $m10c_a2_requested_action$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'handoff_transfers'
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%requested_action%'
      AND pg_catalog.pg_get_constraintdef(c.oid) NOT ILIKE '%file_request%'
  LOOP
    EXECUTE format('ALTER TABLE public.handoff_transfers DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_transfers_requested_action_check'
  ) THEN
    ALTER TABLE public.handoff_transfers
      ADD CONSTRAINT handoff_transfers_requested_action_check
      CHECK (requested_action IN ('approval', 'review', 'update', 'file_request'));
  END IF;
END
$m10c_a2_requested_action$;

ALTER TABLE public.handoffs
  ALTER COLUMN original_filename DROP NOT NULL;

DO $m10c_a2_original_filename_check$
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
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%original_filename%'
      AND pg_catalog.pg_get_constraintdef(c.oid) NOT ILIKE '%IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE public.handoffs DROP CONSTRAINT %I', r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoffs_original_filename_null_or_safe_check'
  ) THEN
    ALTER TABLE public.handoffs
      ADD CONSTRAINT handoffs_original_filename_null_or_safe_check
      CHECK (
        original_filename IS NULL
        OR (
          pg_catalog.char_length(pg_catalog.btrim(original_filename)) BETWEEN 1 AND 255
          AND original_filename !~ '[[:cntrl:]]'
          AND original_filename !~ '[. ]$'
        )
      );
  END IF;
END
$m10c_a2_original_filename_check$;

ALTER TABLE public.handoff_versions
  ADD COLUMN IF NOT EXISTS file_name text;

UPDATE public.handoff_versions v
SET file_name = h.original_filename
FROM public.handoffs h
WHERE v.handoff_id = h.id
  AND v.file_name IS NULL;

DO $m10c_a2_version_file_name_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.handoff_versions
    WHERE file_name IS NULL
       OR pg_catalog.btrim(file_name) = ''
  ) THEN
    RAISE EXCEPTION 'm10c_a2_version_file_name_unmigratable' USING ERRCODE = 'P0001';
  END IF;
END
$m10c_a2_version_file_name_guard$;

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

DO $m10c_a2_file_name_not_null$
BEGIN
  ALTER TABLE public.handoff_versions
    ALTER COLUMN file_name SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'handoff_versions_file_name_safe_check'
  ) THEN
    ALTER TABLE public.handoff_versions
      ADD CONSTRAINT handoff_versions_file_name_safe_check
      CHECK (
        pg_catalog.char_length(pg_catalog.btrim(file_name)) BETWEEN 1 AND 255
        AND file_name !~ '[[:cntrl:]]'
        AND file_name !~ '[. ]$'
      );
  END IF;
END
$m10c_a2_file_name_not_null$;

REVOKE ALL ON FUNCTION private.assert_safe_file_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.insert_handoff_version(uuid, integer, text, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_reserved_upload_matches(uuid, uuid, uuid, uuid, bigint, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_handoff_original_filename() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_file_request_v2(uuid, text, date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_file_request_result(uuid, text, uuid, bigint, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_file_request_v2(uuid, text, date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_file_request_result(uuid, text, uuid, bigint, text, uuid) TO authenticated;

COMMIT;
