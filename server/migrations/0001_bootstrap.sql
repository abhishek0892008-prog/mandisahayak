-- =============================================================================
-- FarmQueue — 0001_bootstrap
-- Extensions, version guard, migration ledger, shared domains, shared triggers.
--
-- STATUS: WRITTEN, NOT EXECUTED. No PostgreSQL server was available in the
--         environment where this file was authored.
--         See docs/database-schema.md section 9 for what remains unverified.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Server version guard.
--   PostgreSQL 13+ is the true minimum:
--     - gen_random_uuid() became a core function in 13 (previously pgcrypto)
--     - GENERATED ALWAYS AS ... STORED requires 12
--     - EXCLUDE USING gist with btree_gist requires no special version
--   PostgreSQL 16 is the target.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF current_setting('server_version_num')::int < 130000 THEN
        RAISE EXCEPTION
            'FarmQueue requires PostgreSQL 13 or newer (target: 16). Found: %',
            current_setting('server_version');
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Extensions.
--   btree_gist  — REQUIRED. Allows scalar equality (uuid, smallint, text) to be
--                 combined with range overlap (&&) inside one EXCLUDE USING gist
--                 constraint. Without it, the overbooking-prevention constraints
--                 in 0008_operations.sql cannot be created.
--   pgcrypto    — NOT installed. gen_random_uuid() is core from PG13, and no
--                 other pgcrypto function is used by this schema.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Migration ledger.
-- Each migration file inserts its own row as its final statement, inside the
-- same transaction as its DDL. Re-running an already-applied file therefore
-- fails on the primary key and rolls back in full, rather than half-applying.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text        PRIMARY KEY,
    name        text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE schema_migrations IS
    'Applied migration ledger. One row per migration file, written by the file itself.';

-- -----------------------------------------------------------------------------
-- Shared domains.
-- Domains give one definition per controlled vocabulary, reused across tables,
-- so the allowed values cannot drift between tables.
-- -----------------------------------------------------------------------------

-- Data classification (Phase 1 §8). Every externally-sourced or operator-supplied
-- record carries one of these. OFFICIAL additionally requires a source_id, which
-- is enforced per table by a CHECK constraint (see the *_official_requires_source
-- constraints throughout).
CREATE DOMAIN data_type_t AS text
    CONSTRAINT data_type_t_allowed_values
    CHECK (VALUE IN ('OFFICIAL', 'CONFIGURED', 'TEST'));

COMMENT ON DOMAIN data_type_t IS
    'OFFICIAL = from a verifiable government publication (requires source_id). '
    'CONFIGURED = entered by an authorised operator. '
    'TEST = development/demo fixture. Never presented as government data.';

-- Publication scope. Copied from the source onto the record so that a
-- state-level figure can never be re-labelled as a facility-level one.
CREATE DOMAIN data_scope_t AS text
    CONSTRAINT data_scope_t_allowed_values
    CHECK (VALUE IN ('NATIONAL', 'STATE', 'DISTRICT', 'FACILITY', 'CENTRE'));

COMMENT ON DOMAIN data_scope_t IS
    'The granularity at which the source actually published the value. '
    'Never widened or narrowed after import.';

-- Supported user interface / SMS languages.
CREATE DOMAIN locale_t AS text
    CONSTRAINT locale_t_allowed_values
    CHECK (VALUE IN ('en', 'hi'));

-- E.164 telephone number, e.g. +919876543210.
-- standard_conforming_strings is on by default in supported versions, so the
-- backslash below is a literal backslash and the regex sees \+ (literal plus).
CREATE DOMAIN e164_t AS text
    CONSTRAINT e164_t_format
    CHECK (VALUE ~ '^\+[1-9][0-9]{7,14}$');

COMMENT ON DOMAIN e164_t IS
    'E.164 phone number including the leading +. Normalisation happens in the '
    'application before insert.';

-- Booking lifecycle states (Decision D-4, approved).
-- Exactly nine canonical states. REMINDER_SENT, APPROACHING and WAITING are
-- deliberately absent: the first two are notification/derived facts and the
-- third is a presentation form of ARRIVED. They are surfaced to clients as a
-- derived displayStatus, not stored here.
CREATE DOMAIN booking_status_t AS text
    CONSTRAINT booking_status_t_allowed_values
    CHECK (VALUE IN (
        'CONFIRMED',
        'ARRIVED',
        'WEIGHING',
        'QUALITY_CHECK',
        'PROCUREMENT_RECORDED',
        'PAYMENT_PENDING',
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW'
    ));

-- Notification event keys.
CREATE DOMAIN notification_event_t AS text
    CONSTRAINT notification_event_t_allowed_values
    CHECK (VALUE IN (
        'BOOKING_CONFIRMED',
        'BOOKING_CANCELLED',
        'ONE_DAY_REMINDER',
        'QUEUE_APPROACHING',
        'TURN_APPROACHING',
        'PROCUREMENT_COMPLETED',
        'PAYMENT_UPDATED',
        'NO_SHOW_RECORDED'
    ));

-- -----------------------------------------------------------------------------
-- Shared trigger functions.
-- -----------------------------------------------------------------------------

-- Maintains updated_at on any table that has the column and attaches this trigger.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
    'BEFORE UPDATE trigger: stamps updated_at with the transaction timestamp.';

-- Blocks UPDATE, DELETE and TRUNCATE on append-only tables.
-- Attached FOR EACH STATEMENT so that a zero-row statement such as
-- "DELETE FROM audit_logs" is still refused.
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'table %.% is append-only: % is not permitted',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION forbid_mutation() IS
    'Statement-level trigger function used to make audit tables append-only.';

INSERT INTO schema_migrations (version, name) VALUES ('0001', 'bootstrap');

COMMIT;
