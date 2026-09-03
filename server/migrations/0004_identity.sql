-- =============================================================================
-- FarmQueue — 0004_identity
-- Users, roles, permissions, farmers, officers, sessions, OTP, consent.
--
-- DECISION D-6 (approved): farmer registration collects NO Aadhaar digits and
-- NO bank details. There is deliberately no aadhaar_last4 column and no
-- ifsc_code column anywhere in this schema. Four Aadhaar digits verify nothing,
-- and an IFSC without an account number cannot receive a payment.
--
-- SECURITY: there is no plaintext OTP column and no plaintext session token
-- column in this file. Both are stored only as hashes (bytea).
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- users — one row per human, regardless of role.
-- Farmers authenticate by phone + OTP. Staff authenticate by username +
-- password + OTP second factor (Phase 1 §4.1). Roles are additive.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name          text         NOT NULL,
    phone_e164         e164_t       UNIQUE,
    username           text         UNIQUE,
    password_hash      text,
    locale             locale_t     NOT NULL DEFAULT 'en',
    status             text         NOT NULL DEFAULT 'ACTIVE',
    phone_verified_at  timestamptz,
    last_login_at      timestamptz,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT users_status_allowed
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),

    CONSTRAINT users_full_name_not_blank
        CHECK (btrim(full_name) <> '' AND length(full_name) <= 120),

    CONSTRAINT users_username_format
        CHECK (username IS NULL OR username ~ '^[a-z0-9._-]{3,64}$'),

    -- Every user must be addressable by at least one identifier.
    CONSTRAINT users_identifier_present
        CHECK (phone_e164 IS NOT NULL OR username IS NOT NULL)
);

COMMENT ON TABLE users IS
    'One row per human. No Aadhaar reference and no bank details are stored '
    '(Decision D-6/D-7).';
COMMENT ON COLUMN users.password_hash IS
    'Argon2id hash, staff accounts only. NULL for farmers, who never have a password.';

CREATE INDEX users_status_idx ON users (status);

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- data_sources user columns could not be given foreign keys in 0002.
ALTER TABLE data_sources
    ADD CONSTRAINT data_sources_retrieved_by_user_id_fkey
    FOREIGN KEY (retrieved_by_user_id) REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE data_sources
    ADD CONSTRAINT data_sources_last_verified_by_user_id_fkey
    FOREIGN KEY (last_verified_by_user_id) REFERENCES users (id) ON DELETE RESTRICT;


-- -----------------------------------------------------------------------------
-- roles / permissions / grants.
-- SUPER_ADMIN is deliberately not permitted; adding it later is a one-line
-- ALTER of the CHECK constraint plus a seed row.
-- -----------------------------------------------------------------------------
CREATE TABLE roles (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text        NOT NULL UNIQUE,
    name         text        NOT NULL,
    description  text,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT roles_code_allowed
        CHECK (code IN ('FARMER', 'OFFICER', 'ADMIN'))
);


CREATE TABLE permissions (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code         text        NOT NULL UNIQUE,
    description  text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT permissions_code_format
        CHECK (code ~ '^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$')
);

COMMENT ON TABLE permissions IS
    'Seeded by migration and not user-editable. Route handlers declare a '
    'permission code; a startup assertion refuses to boot if any route omits one.';


CREATE TABLE role_permissions (
    role_id        uuid        NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission_id  uuid        NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX role_permissions_permission_id_idx ON role_permissions (permission_id);


CREATE TABLE user_roles (
    user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id            uuid        NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
    granted_at         timestamptz NOT NULL DEFAULT now(),
    granted_by_user_id uuid        REFERENCES users (id) ON DELETE RESTRICT,

    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_id_idx    ON user_roles (role_id);
CREATE INDEX user_roles_granted_by_idx ON user_roles (granted_by_user_id);


-- -----------------------------------------------------------------------------
-- farmers — the minimal-data profile (Phase 1 §6).
-- Necessary fields only: who they are (on users), and where they are.
-- -----------------------------------------------------------------------------
CREATE TABLE farmers (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
    district_id  uuid        REFERENCES districts (id) ON DELETE RESTRICT,
    village_id   uuid        REFERENCES villages (id)  ON DELETE RESTRICT,
    status       text        NOT NULL DEFAULT 'ACTIVE',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT farmers_status_allowed
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED'))
);

COMMENT ON TABLE farmers IS
    'Minimal-data farmer profile. Deliberately contains no aadhaar_last4 and no '
    'ifsc_code column (Decision D-6). Name and phone live on users.';

CREATE INDEX farmers_district_id_idx ON farmers (district_id);
CREATE INDEX farmers_village_id_idx  ON farmers (village_id);
CREATE INDEX farmers_status_idx      ON farmers (status);

CREATE TRIGGER farmers_set_updated_at
    BEFORE UPDATE ON farmers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- officers. Created by an administrator; never self-registered.
-- Centre assignments live in 0005_centres.sql, after procurement_centres exists.
-- -----------------------------------------------------------------------------
CREATE TABLE officers (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
    employee_code       text        UNIQUE,
    designation         text,
    status              text        NOT NULL DEFAULT 'ACTIVE',
    created_by_user_id  uuid        REFERENCES users (id) ON DELETE RESTRICT,
    deactivated_at      timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT officers_status_allowed
        CHECK (status IN ('ACTIVE', 'INACTIVE')),

    CONSTRAINT officers_deactivation_consistent
        CHECK ((status = 'INACTIVE') = (deactivated_at IS NOT NULL))
);

CREATE INDEX officers_status_idx     ON officers (status);
CREATE INDEX officers_created_by_idx ON officers (created_by_user_id);

CREATE TRIGGER officers_set_updated_at
    BEFORE UPDATE ON officers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- sessions — opaque server-side sessions. Only the hash of the token is stored,
-- so a database leak yields no usable session.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash           bytea       NOT NULL UNIQUE,
    created_at           timestamptz NOT NULL DEFAULT now(),
    last_seen_at         timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz NOT NULL,
    absolute_expires_at  timestamptz NOT NULL,
    ip                   inet,
    user_agent           text,
    revoked_at           timestamptz,
    revoked_reason       text,

    CONSTRAINT sessions_idle_expiry_after_creation
        CHECK (expires_at > created_at),

    CONSTRAINT sessions_absolute_expiry_not_before_idle
        CHECK (absolute_expires_at >= expires_at)
);

COMMENT ON COLUMN sessions.token_hash IS
    'SHA-256 of the session token. The token itself is never stored.';

CREATE INDEX sessions_user_id_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);


-- -----------------------------------------------------------------------------
-- pending_registrations — short-lived holding area between "start OTP" and
-- "verify OTP". No users/farmers row exists until the phone is verified, so an
-- unverified person creates no identity. Purged by a worker job.
-- -----------------------------------------------------------------------------
CREATE TABLE pending_registrations (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164             e164_t      NOT NULL,
    full_name              text        NOT NULL,
    district_id            uuid        REFERENCES districts (id) ON DELETE RESTRICT,
    village_id             uuid        REFERENCES villages (id)  ON DELETE RESTRICT,
    locale                 locale_t    NOT NULL DEFAULT 'en',
    consent_policy_version text        NOT NULL,
    consent_text_hash      bytea       NOT NULL,
    expires_at             timestamptz NOT NULL,
    created_ip             inet,
    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT pending_registrations_full_name_not_blank
        CHECK (btrim(full_name) <> ''),

    CONSTRAINT pending_registrations_expiry_after_creation
        CHECK (expires_at > created_at)
);

COMMENT ON TABLE pending_registrations IS
    'Unverified registration payloads, TTL ~15 minutes. Holds the minimum-data '
    'fields only (D-6): name, phone, district, village, locale, consent record.';

CREATE INDEX pending_registrations_phone_idx      ON pending_registrations (phone_e164);
CREATE INDEX pending_registrations_expires_at_idx ON pending_registrations (expires_at);
CREATE INDEX pending_registrations_district_idx   ON pending_registrations (district_id);
CREATE INDEX pending_registrations_village_idx    ON pending_registrations (village_id);


-- -----------------------------------------------------------------------------
-- otp_challenges.
-- The OTP is stored ONLY as a peppered HMAC. There is no plaintext column, so
-- there is no code path by which a stored OTP could be returned to a client.
-- -----------------------------------------------------------------------------
CREATE TABLE otp_challenges (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose                  text        NOT NULL,
    phone_e164               e164_t      NOT NULL,
    user_id                  uuid        REFERENCES users (id) ON DELETE CASCADE,
    pending_registration_id  uuid        REFERENCES pending_registrations (id) ON DELETE CASCADE,
    otp_hash                 bytea       NOT NULL,
    expires_at               timestamptz NOT NULL,
    attempts                 smallint    NOT NULL DEFAULT 0,
    max_attempts             smallint    NOT NULL DEFAULT 5,
    resend_count             smallint    NOT NULL DEFAULT 0,
    max_resends              smallint    NOT NULL DEFAULT 3,
    last_sent_at             timestamptz NOT NULL DEFAULT now(),
    consumed_at              timestamptz,
    status                   text        NOT NULL DEFAULT 'PENDING',
    created_ip               inet,
    created_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT otp_challenges_purpose_allowed
        CHECK (purpose IN ('FARMER_REGISTER', 'FARMER_LOGIN', 'STAFF_2FA')),

    CONSTRAINT otp_challenges_status_allowed
        CHECK (status IN ('PENDING', 'CONSUMED', 'EXPIRED', 'FAILED')),

    CONSTRAINT otp_challenges_attempts_nonnegative
        CHECK (attempts >= 0 AND attempts <= max_attempts),

    CONSTRAINT otp_challenges_max_attempts_positive
        CHECK (max_attempts > 0),

    CONSTRAINT otp_challenges_resends_within_limit
        CHECK (resend_count >= 0 AND resend_count <= max_resends),

    CONSTRAINT otp_challenges_expiry_after_creation
        CHECK (expires_at > created_at),

    -- A registration challenge must point at the pending payload it will
    -- consume; a login or staff challenge must point at an existing user.
    CONSTRAINT otp_challenges_subject_matches_purpose
        CHECK (
            (purpose = 'FARMER_REGISTER'
                AND pending_registration_id IS NOT NULL
                AND user_id IS NULL)
            OR
            (purpose IN ('FARMER_LOGIN', 'STAFF_2FA')
                AND pending_registration_id IS NULL)
        ),

    CONSTRAINT otp_challenges_consumed_consistent
        CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL))
);

COMMENT ON TABLE otp_challenges IS
    'One-time-password challenges. otp_hash is HMAC-SHA256(otp, server pepper); '
    'the pepper lives in the environment, not in this database. No plaintext '
    'OTP column exists anywhere in this schema.';

CREATE INDEX otp_challenges_phone_purpose_idx ON otp_challenges (phone_e164, purpose);
CREATE INDEX otp_challenges_expires_at_idx    ON otp_challenges (expires_at);
CREATE INDEX otp_challenges_user_id_idx       ON otp_challenges (user_id);
CREATE INDEX otp_challenges_pending_reg_idx   ON otp_challenges (pending_registration_id);


-- -----------------------------------------------------------------------------
-- consents — the lawful basis for holding the data above.
-- Storing the hash of the exact text shown lets us later prove what was agreed.
-- -----------------------------------------------------------------------------
CREATE TABLE consents (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose            text        NOT NULL,
    policy_version     text        NOT NULL,
    policy_text_hash   bytea       NOT NULL,
    granted_at         timestamptz NOT NULL DEFAULT now(),
    granted_ip         inet,
    withdrawn_at       timestamptz,

    CONSTRAINT consents_purpose_allowed
        CHECK (purpose IN ('SERVICE_USE', 'SMS_NOTIFICATIONS')),

    CONSTRAINT consents_withdrawal_after_grant
        CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at),

    CONSTRAINT consents_unique_per_purpose_version
        UNIQUE (user_id, purpose, policy_version)
);


-- -----------------------------------------------------------------------------
-- rate_limit_buckets — fixed-window counters, in the database rather than in
-- process memory so limits survive restarts and hold across API instances.
-- -----------------------------------------------------------------------------
CREATE TABLE rate_limit_buckets (
    bucket_key         text        NOT NULL,
    window_started_at  timestamptz NOT NULL,
    hits               integer     NOT NULL DEFAULT 0,
    expires_at         timestamptz NOT NULL,

    PRIMARY KEY (bucket_key, window_started_at),

    CONSTRAINT rate_limit_buckets_hits_nonnegative
        CHECK (hits >= 0)
);

CREATE INDEX rate_limit_buckets_expires_at_idx ON rate_limit_buckets (expires_at);

INSERT INTO schema_migrations (version, name) VALUES ('0004', 'identity');

COMMIT;
