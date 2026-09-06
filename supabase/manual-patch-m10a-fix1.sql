-- FileRelay Milestone 10A fix 1
-- Apply in the Supabase SQL Editor after Milestone 10A.
-- Idempotent and safe to re-run. Do not use the Supabase CLI.
-- Adds a delete-only Storage SELECT policy so abort can locate a reserved object.
-- Does not rewrite RPCs, rows, versions, or storage objects.

BEGIN;

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

COMMIT;
