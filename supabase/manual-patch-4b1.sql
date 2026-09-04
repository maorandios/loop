-- FileRelay manual patch 4B.1
-- Idempotent. Safe to run even if rotate_workspace_join_code already exists.
-- Paste and run this file in the Supabase SQL Editor.
-- Do not use the Supabase CLI.

BEGIN;

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

REVOKE ALL ON FUNCTION public.rotate_workspace_join_code(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_workspace_join_code(uuid) TO authenticated;

COMMIT;
