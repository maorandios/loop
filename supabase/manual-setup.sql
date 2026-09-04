-- FileRelay manual database setup (Milestone 9)
-- Paste and run this file once in the Supabase SQL Editor for a new project.
-- Existing databases that already ran setup through Milestone 7 should use
-- supabase/manual-patch-m9.sql instead of this file.
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

CREATE TABLE IF NOT EXISTS public.handoffs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  sender_member_id uuid NOT NULL REFERENCES public.workspace_members (id),
  recipient_member_id uuid NOT NULL REFERENCES public.workspace_members (id),
  original_filename text NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(original_filename)) BETWEEN 1 AND 255
  ),
  instruction text CHECK (
    instruction IS NULL
    OR (
      pg_catalog.char_length(pg_catalog.btrim(instruction)) BETWEEN 1 AND 280
      AND instruction !~ '[[:cntrl:]]'
    )
  ),
  due_on date,
  status text NOT NULL CHECK (
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
  ),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK (sender_member_id <> recipient_member_id)
);

CREATE INDEX IF NOT EXISTS handoffs_workspace_id_idx
  ON public.handoffs (workspace_id);
CREATE INDEX IF NOT EXISTS handoffs_recipient_member_id_idx
  ON public.handoffs (recipient_member_id);
CREATE INDEX IF NOT EXISTS handoffs_sender_member_id_idx
  ON public.handoffs (sender_member_id);

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
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE UNIQUE INDEX IF NOT EXISTS handoff_versions_handoff_version_key
  ON public.handoff_versions (handoff_id, version_number);

CREATE TABLE IF NOT EXISTS public.handoff_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  handoff_id uuid NOT NULL REFERENCES public.handoffs (id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES public.workspace_members (id),
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
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

DROP TRIGGER IF EXISTS handoffs_set_updated_at ON public.handoffs;
CREATE TRIGGER handoffs_set_updated_at
BEFORE UPDATE ON public.handoffs
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
REVOKE ALL ON FUNCTION private.can_read_handoff_object(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.can_upload_handoff_object(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.is_workspace_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_handoff_participant(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_read_handoff_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_upload_handoff_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.handoff_status_visible_to_recipient(text) TO authenticated;

REVOKE ALL ON public.workspaces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.workspace_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoffs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoff_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.handoff_events FROM PUBLIC, anon, authenticated;

GRANT SELECT (id, name, created_by, created_at) ON public.workspaces TO authenticated;
GRANT SELECT ON public.workspace_members TO authenticated;
GRANT UPDATE (last_seen_at, display_name) ON public.workspace_members TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoffs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_versions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handoff_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.handoffs TO authenticated;
GRANT SELECT ON public.handoff_versions TO authenticated;
GRANT SELECT ON public.handoff_events TO authenticated;

-- 6. RLS policies
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoffs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_events FORCE ROW LEVEL SECURITY;

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
  USING (
    EXISTS (
      SELECT 1
      FROM public.workspace_members sender
      WHERE sender.id = handoffs.sender_member_id
        AND sender.user_id = auth.uid()
    )
    OR (
      EXISTS (
        SELECT 1
        FROM public.workspace_members recipient
        WHERE recipient.id = handoffs.recipient_member_id
          AND recipient.user_id = auth.uid()
      )
      AND private.handoff_status_visible_to_recipient(handoffs.status)
    )
  );

DROP POLICY IF EXISTS handoffs_insert_sender ON public.handoffs;
DROP POLICY IF EXISTS handoffs_update_member ON public.handoffs;
DROP POLICY IF EXISTS handoffs_update_participant ON public.handoffs;

DROP POLICY IF EXISTS handoff_versions_select_member ON public.handoff_versions;
DROP POLICY IF EXISTS handoff_versions_select_participant ON public.handoff_versions;
CREATE POLICY handoff_versions_select_participant
  ON public.handoff_versions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members sender ON sender.id = h.sender_member_id
      WHERE h.id = handoff_versions.handoff_id
        AND sender.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members recipient ON recipient.id = h.recipient_member_id
      WHERE h.id = handoff_versions.handoff_id
        AND recipient.user_id = auth.uid()
        AND private.handoff_status_visible_to_recipient(h.status)
    )
  );

DROP POLICY IF EXISTS handoff_versions_insert_member ON public.handoff_versions;

DROP POLICY IF EXISTS handoff_events_select_member ON public.handoff_events;
DROP POLICY IF EXISTS handoff_events_select_participant ON public.handoff_events;
CREATE POLICY handoff_events_select_participant
  ON public.handoff_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members sender ON sender.id = h.sender_member_id
      WHERE h.id = handoff_events.handoff_id
        AND sender.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.handoffs h
      JOIN public.workspace_members recipient ON recipient.id = h.recipient_member_id
      WHERE h.id = handoff_events.handoff_id
        AND recipient.user_id = auth.uid()
        AND private.handoff_status_visible_to_recipient(h.status)
    )
  );

DROP POLICY IF EXISTS handoff_events_insert_member ON public.handoff_events;

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
    status
  )
  VALUES (
    v_workspace_id,
    v_sender_id,
    recipient_member_id,
    v_name,
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF handoff_id IS NULL OR object_id IS NULL THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF file_size IS NULL OR file_size <= 0 OR file_size > 52428800 THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'handoff_finalize_failed' USING ERRCODE = '22023';
  END IF;

  SELECT h.sender_member_id, h.workspace_id, h.status
  INTO v_sender_id, v_workspace_id, v_status
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

  INSERT INTO public.handoff_versions (
    handoff_id,
    version_number,
    storage_path,
    file_size,
    blake3,
    uploaded_by_member_id
  )
  VALUES (
    finalize_handoff_v1.handoff_id,
    1,
    v_path,
    file_size,
    v_hash,
    v_sender_id
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'anonymous_auth_failed' USING ERRCODE = '42501';
  END IF;

  IF handoff_id IS NULL OR object_id IS NULL THEN
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

  INSERT INTO public.handoff_versions (
    handoff_id,
    version_number,
    storage_path,
    file_size,
    blake3,
    uploaded_by_member_id
  )
  VALUES (
    finalize_handoff_return_v2.handoff_id,
    2,
    v_path,
    file_size,
    v_hash,
    v_recipient_id
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
END
$pub$;

COMMIT;
