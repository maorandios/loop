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
