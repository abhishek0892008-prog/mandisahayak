-- =============================================================================
-- FarmQueue — 0010_governance
-- Append-only audit log, reference-data versions, job run ledger.
--
-- AUDIT IMMUTABILITY IS ENFORCED IN TWO INDEPENDENT WAYS:
--   1. Statement-level BEFORE triggers on UPDATE, DELETE and TRUNCATE that
--      raise unconditionally. Statement-level (not row-level) so that even a
--      zero-row "DELETE FROM audit_logs" is refused.
--   2. A privilege revocation for the application role, applied only if that
--      role exists in the target environment.
-- Between them, tampering requires a superuser and still leaves a trace.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

CREATE TABLE audit_logs (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at    timestamptz NOT NULL DEFAULT now(),

    -- RESTRICT, not SET NULL: a SET NULL would be an UPDATE, which the
    -- immutability trigger below refuses. It also means a user who has acted
    -- can never be hard-deleted, which is the correct outcome for an audit trail.
    actor_user_id  uuid        REFERENCES users (id) ON DELETE RESTRICT,
    actor_role     text,
    actor_ip       inet,
    request_id     text,

    action         text        NOT NULL,
    entity_type    text        NOT NULL,
    entity_id      uuid,

    before_state   jsonb,
    after_state    jsonb,
    metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT audit_logs_action_not_blank
        CHECK (btrim(action) <> ''),

    CONSTRAINT audit_logs_entity_type_not_blank
        CHECK (btrim(entity_type) <> ''),

    CONSTRAINT audit_logs_actor_role_allowed
        CHECK (actor_role IS NULL OR actor_role IN ('FARMER', 'OFFICER', 'ADMIN', 'SYSTEM')),

    CONSTRAINT audit_logs_metadata_is_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE audit_logs IS
    'Append-only. Written in the same transaction as the change it records: if '
    'the audit write fails, the change rolls back. before_state and after_state '
    'pass through the same redactor as application logs, so no OTP, session '
    'token, full phone number or bank data ever reaches this table.';

CREATE INDEX audit_logs_occurred_at_idx  ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_actor_user_idx   ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx       ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx       ON audit_logs (action, occurred_at DESC);
CREATE INDEX audit_logs_request_id_idx   ON audit_logs (request_id);

-- Immutability, layer 1: triggers.
CREATE TRIGGER audit_logs_forbid_update
    BEFORE UPDATE ON audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_logs_forbid_delete
    BEFORE DELETE ON audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_logs_forbid_truncate
    BEFORE TRUNCATE ON audit_logs
    FOR EACH STATEMENT
    EXECUTE FUNCTION forbid_mutation();

-- Immutability, layer 2: privileges.
-- The application role is created by the deployment environment, not by this
-- migration, so the revocation is conditional. FARMQUEUE_APP_ROLE names the role;
-- adjust it if your deployment uses a different name.
DO $$
DECLARE
    app_role CONSTANT text := 'farmqueue_app';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
        EXECUTE format(
            'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM %I',
            app_role
        );
        RAISE NOTICE 'Revoked UPDATE/DELETE/TRUNCATE on audit_logs from %', app_role;
    ELSE
        RAISE NOTICE
            'Role % does not exist; skipping audit_logs privilege revocation. '
            'Create the role and re-apply the REVOKE before production use.',
            app_role;
    END IF;
END
$$;


-- -----------------------------------------------------------------------------
-- reference_versions — lets a client ask "has this changed?" instead of
-- refetching master data it already holds (offline/sync strategy, Phase 1 §20).
-- -----------------------------------------------------------------------------
CREATE TABLE reference_versions (
    resource    text        PRIMARY KEY,
    version     bigint      NOT NULL DEFAULT 1,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reference_versions_version_positive
        CHECK (version > 0)
);

COMMENT ON TABLE reference_versions IS
    'Monotonic version per reference dataset. Bumped whenever the underlying '
    'master data changes, so clients can skip large refetches.';


-- -----------------------------------------------------------------------------
-- job_runs — makes "did the reminder job run, and what did it do?" answerable.
-- -----------------------------------------------------------------------------
CREATE TABLE job_runs (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_name         text        NOT NULL,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz,
    outcome          text,
    processed_count  integer     NOT NULL DEFAULT 0,
    error            text,
    metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT job_runs_outcome_allowed
        CHECK (outcome IS NULL OR outcome IN ('SUCCESS', 'FAILED', 'SKIPPED_LOCKED')),

    CONSTRAINT job_runs_processed_count_nonnegative
        CHECK (processed_count >= 0),

    CONSTRAINT job_runs_finish_after_start
        CHECK (finished_at IS NULL OR finished_at >= started_at),

    CONSTRAINT job_runs_completion_consistent
        CHECK ((outcome IS NULL) = (finished_at IS NULL)),

    CONSTRAINT job_runs_metadata_is_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE job_runs IS
    'One row per scheduled job execution. SKIPPED_LOCKED records a worker that '
    'correctly declined to run because another worker held the advisory lock.';

CREATE INDEX job_runs_job_name_started_idx ON job_runs (job_name, started_at DESC);
CREATE INDEX job_runs_outcome_idx          ON job_runs (outcome);

INSERT INTO schema_migrations (version, name) VALUES ('0010', 'governance');

COMMIT;
