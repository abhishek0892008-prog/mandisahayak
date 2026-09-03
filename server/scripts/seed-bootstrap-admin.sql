-- =============================================================================
-- FarmQueue — bootstrap administrator
--
-- THIS IS NOT A MIGRATION and it is NOT government data. It creates the single
-- accountable ADMIN that the two import files demand:
--
--     imports/0001  -v activating_admin=<uuid>   (MSP activation)
--     imports/0002  -v configured_by=<uuid>      (centre configuration)
--
-- Both imports refuse to run without a real user holding the ADMIN role. That
-- refusal is deliberate: no MSP rate and no centre configuration enters the
-- system unattributed. Until now the admin was created by hand, which left the
-- documented reproduction steps ("A=<uuid-of-an-admin-user>") unable to run
-- from a clean database. This file closes that gap.
--
-- WHY THE UUID IS FIXED
--   The imports need the id before they run, and a scripted provision must be
--   able to name it without a round trip. It is a constant, not a secret.
--
-- WHY THERE IS NO PASSWORD
--   password_hash stays NULL, so this account cannot log in: verifyPassword()
--   returns false for a NULL hash (after burning comparable work, so the
--   account is not enumerable by timing). It exists to be *attributed*, never
--   to be authenticated as. Grant a real administrator a real credential
--   through the staff account flow instead.
--
-- Idempotent: safe to re-run against a database that already has it.
-- =============================================================================

BEGIN;

INSERT INTO users (id, full_name, username, password_hash, status)
VALUES (
    '33333333-0000-4000-a000-000000000001',
    'Seed Operator',
    'seed_operator',
    NULL,
    'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT '33333333-0000-4000-a000-000000000001', r.id
  FROM roles r
 WHERE r.code = 'ADMIN'
ON CONFLICT (user_id, role_id) DO NOTHING;

-- Fail loudly rather than let an import discover this later.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = '33333333-0000-4000-a000-000000000001'
           AND r.code = 'ADMIN'
    ) THEN
        RAISE EXCEPTION
            'bootstrap admin was not granted ADMIN; is migration 0011 applied?';
    END IF;
END
$$;

COMMIT;

\echo 'bootstrap admin ready: 33333333-0000-4000-a000-000000000001 (login disabled)'
