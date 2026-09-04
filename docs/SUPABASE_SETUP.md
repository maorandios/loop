# הכנת FileRelay ל־Supabase

בצע את הצעדים האלה ידנית. אין צורך ב־Supabase CLI.

1. צור פרויקט חדש ב־Supabase Dashboard.
2. הפעל Anonymous Sign-Ins:
   Authentication → Providers → Anonymous Sign-Ins → Enable.
3. הרץ SQL לפי מצב הפרויקט. אין להשתמש ב־Supabase CLI.
   - פרויקט חדש: הרץ רק `supabase/manual-setup.sql` (כולל סכימת Milestone 9).
   - פרויקט קיים אחרי Milestone 7: הרץ `supabase/manual-patch-m9.sql`.
   - פרויקט ישן יותר: setup המקורי → `manual-patch-4b1.sql` → `manual-patch-m6.sql` → `manual-patch-m7.sql` → `manual-patch-m9.sql`.
   אל תריץ את `manual-setup.sql` המלא על מסד שכבר הוקם.
4. העתק את ה־Project URL.
5. העתק רק את ה־publishable key (לא `service_role`).
6. צור קובץ `.env.local` בשורש הפרויקט עם שני הערכים בלבד:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

7. הפעל את האפליקציה ובדוק שני מחשבים: באחד צור צוות, בשני הצטרף עם הקוד.

## שאילתות אימות ידניות

הרץ את השאילתות האלה ב־SQL Editor רק אחרי ההקמה. אין צורך ב־CLI.

```sql
-- RLS מופעל על כל חמש הטבלאות
SELECT n.nspname AS schema, c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'workspaces',
    'workspace_members',
    'handoffs',
    'handoff_versions',
    'handoff_events'
  )
ORDER BY c.relname;

-- פונקציות SECURITY DEFINER וה־search_path שלהן
SELECT
  n.nspname AS schema,
  p.proname AS function_name,
  p.prosecdef AS security_definer,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname IN ('public', 'private')
ORDER BY n.nspname, p.proname;

-- הרשאות EXECUTE של anon ושל authenticated
SELECT
  n.nspname AS schema,
  p.proname AS function_name,
  r.rolname AS grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname IN ('public', 'private')
  AND p.proname IN (
    'create_workspace',
    'join_workspace',
    'rotate_workspace_join_code',
    'create_handoff',
    'create_handoff_with_context',
    'finalize_handoff_v1',
    'fail_handoff',
    'mark_handoff_received',
    'begin_handoff_return',
    'begin_handoff_return_next',
    'finalize_handoff_return_v2',
    'finalize_handoff_return',
    'mark_return_received',
    'complete_handoff',
    'request_revision',
    'is_workspace_member',
    'normalize_join_code',
    'hash_join_code',
    'generate_join_code'
  )
  AND r.rolname IN ('anon', 'authenticated')
ORDER BY p.proname, r.rolname;

-- ה־bucket הוא private ומגבלת הקובץ היא 50MB
SELECT id, name, public, file_size_limit
FROM storage.buckets
WHERE id = 'filerelay';

-- הטבלאות נוספו ל־Realtime publication
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND tablename IN (
    'workspace_members',
    'handoffs',
    'handoff_versions',
    'handoff_events'
  )
ORDER BY tablename;
```

בדוק ש־`proconfig` של כל פונקציית `SECURITY DEFINER` כולל `search_path=""`.
`is_workspace_member` צריכה להיות בסכמת `private`, ושלושת ה־RPC בסכמת `public`.
`anon` לא אמור לקבל `EXECUTE`. אל תוסיף את סכמת `private` לרשימת הסכמות החשופות ב־Data API.

## תרחישי בדיקה לאחר החיבור

הרץ את התרחישים האלה רק אחרי החיבור החי. אין להריץ אותם עכשיו.

1. משתמש A יוצר צוות.
2. משתמש B מצטרף עם קוד ההצטרפות.
3. משתמש C שאינו חבר לא רואה את הצוות.
4. חבר צוות שאינו השולח או המקבל ב־handoff לא רואה את ה־handoff, את הגרסאות, את האירועים או את קובץ ה־Storage.
5. B אינו יכול להעלות `v1` (`<workspace_id>/<handoff_id>/v<N>/<object_id>`).
6. A אינו יכול להעלות גרסת החזרה. `vN` כאשר N≥2 מותר רק לנמען בזמן `returning`, ורק אם N הוא בדיוק `max(version_number)+1`.
7. אי אפשר לדרוס קובץ קיים באותו נתיב, ואין upsert.
8. אי אפשר למחוק קובץ דרך לקוח רגיל. אין מדיניות DELETE על `storage.objects`.
9. אי אפשר לשנות `sender_member_id`, `recipient_member_id`, `workspace_id`, `original_filename` או `created_at` אחרי יצירת handoff. אין DML ישיר על `handoffs`, `handoff_versions` ו-`handoff_events`; שינוי מצב רק דרך RPC.
10. משתמש אינו יכול ליצור `handoff_events` עם `actor_member_id` של חבר אחר, ואינו יכול ליצור אירוע עם `actor_member_id` ריק. אירועים נכתבים רק מ-RPC.
