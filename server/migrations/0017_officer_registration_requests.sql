-- =============================================================================
-- FarmQueue — 0017_officer_registration_requests
--
-- Lets a prospective officer apply for an account, WITHOUT that application
-- being an account.
--
-- SECURITY POSTURE — read before changing anything here.
--
--   An officer records arrivals, weighments, quality and payment state for
--   farmers. Self-service creation of a live officer would therefore be a
--   privilege-escalation route open to the public internet. So a submission
--   here creates NO row in `users`, NO row in `officers`, NO entry in
--   `user_roles`, and NO centre assignment. It cannot authenticate, because
--   there is nothing to authenticate against: `startStaffLogin` reads `users`,
--   and this table is not `users`.
--
--   An administrator holding `officer.create` converts an approved request
--   into a real officer through the existing admin path. That approval is the
--   only way a row here becomes an account, and it is audited like every other
--   officer creation.
--
--   The password is hashed at submission (same scrypt helper as everywhere
--   else) so that a plaintext secret is never stored while an application
--   waits. It is carried over on approval so the applicant's chosen password
--   keeps working; it is never readable back.
-- =============================================================================

BEGIN;

CREATE TABLE officer_registration_requests (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

    full_name             text        NOT NULL,
    phone_e164            e164_t      NOT NULL,
    username              text        NOT NULL,
    employee_code         text        NOT NULL,
    designation           text,

    -- scrypt hash, never plaintext. Same format as users.password_hash.
    password_hash         text        NOT NULL,

    -- The posting the applicant is asking for. An administrator may approve a
    -- different centre; this records what was requested, not what was granted.
    requested_centre_id   uuid        NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,

    status                text        NOT NULL DEFAULT 'PENDING',

    -- Set together when a decision is taken.
    decided_at            timestamptz,
    decided_by_user_id    uuid        REFERENCES users (id) ON DELETE RESTRICT,
    decision_note         text,

    -- The officer created on approval, so a request is traceable to its account.
    created_officer_id    uuid        REFERENCES officers (id) ON DELETE RESTRICT,

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT officer_registration_requests_status_allowed
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),

    CONSTRAINT officer_registration_requests_decision_consistent
        CHECK ((status = 'PENDING') = (decided_at IS NULL)),

    CONSTRAINT officer_registration_requests_approval_has_officer
        CHECK (status <> 'APPROVED' OR created_officer_id IS NOT NULL),

    CONSTRAINT officer_registration_requests_full_name_not_blank
        CHECK (btrim(full_name) <> '' AND length(full_name) <= 120),

    -- Mirrors users_username_format, so an approved request can always become a
    -- user row without a second validation pass.
    CONSTRAINT officer_registration_requests_username_format
        CHECK (username ~ '^[a-z0-9._-]{3,64}$')
);

-- At most one request in flight per identifier. Partial, so a rejected
-- applicant may reapply and an approved one does not block the identifier
-- forever (uniqueness in `users` takes over at that point).
CREATE UNIQUE INDEX officer_registration_requests_one_pending_username
    ON officer_registration_requests (username)
    WHERE status = 'PENDING';

CREATE UNIQUE INDEX officer_registration_requests_one_pending_employee_code
    ON officer_registration_requests (employee_code)
    WHERE status = 'PENDING';

CREATE UNIQUE INDEX officer_registration_requests_one_pending_phone
    ON officer_registration_requests (phone_e164)
    WHERE status = 'PENDING';

CREATE INDEX officer_registration_requests_status_idx
    ON officer_registration_requests (status, created_at DESC);

CREATE TRIGGER officer_registration_requests_set_updated_at
    BEFORE UPDATE ON officer_registration_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE officer_registration_requests IS
    'Applications for an officer account. NOT accounts: a row here grants '
    'nothing and cannot authenticate. An administrator with officer.create '
    'converts an approved request into a real officer.';

COMMENT ON COLUMN officer_registration_requests.password_hash IS
    'scrypt hash of the password the applicant chose, carried over to '
    'users.password_hash on approval. Never stored or returned in plaintext.';

COMMENT ON COLUMN officer_registration_requests.requested_centre_id IS
    'The posting asked for. An administrator may assign a different centre; '
    'this column records the request, never the grant.';

INSERT INTO schema_migrations (version, name) VALUES ('0017', 'officer_registration_requests');

COMMIT;
