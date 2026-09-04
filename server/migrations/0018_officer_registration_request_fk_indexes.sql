-- =============================================================================
-- FarmQueue — 0018_officer_registration_request_fk_indexes
--
-- Indexes the three foreign keys 0017 introduced without one.
--
-- WHY THIS IS NOT COSMETIC. PostgreSQL indexes the REFERENCING side of a
-- foreign key for you exactly never. Every one of these three columns points at
-- a table whose rows are deleted or updated in normal operation, and each such
-- statement must prove no child row still references the parent. With no index
-- that proof is a sequential scan of officer_registration_requests, taken while
-- holding a lock on the parent row — so the cost lands on the parent's writer,
-- not on this table's reader, which is what makes it easy to miss.
--
--   requested_centre_id -> procurement_centres   deactivating a centre
--   decided_by_user_id  -> users                 any user-row maintenance
--   created_officer_id  -> officers              deactivating an officer
--
-- The table is small today, so the scan is cheap today. That is a fact about
-- the current data, not about the schema, and `verify-schema.sql` check A6 and
-- `static-check.mjs` both assert the schema property rather than the data — so
-- both have been failing since 0017 landed. This makes them pass by fixing the
-- cause.
--
-- 0017 is already applied and is therefore not edited: this is a new,
-- forward-only migration, per the project's migration rule.
--
-- IF NOT EXISTS on each index so a database that was hand-patched between 0017
-- and this migration still applies cleanly.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS officer_registration_requests_requested_centre_id_idx
    ON officer_registration_requests (requested_centre_id);

CREATE INDEX IF NOT EXISTS officer_registration_requests_decided_by_user_id_idx
    ON officer_registration_requests (decided_by_user_id);

CREATE INDEX IF NOT EXISTS officer_registration_requests_created_officer_id_idx
    ON officer_registration_requests (created_officer_id);

INSERT INTO schema_migrations (version, name)
VALUES ('0018', 'officer_registration_request_fk_indexes');

COMMIT;
