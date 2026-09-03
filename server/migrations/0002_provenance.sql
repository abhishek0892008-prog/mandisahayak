-- =============================================================================
-- FarmQueue — 0002_provenance
-- data_sources: the provenance registry every OFFICIAL record must point at.
--
-- Created before every table that references it. The two user columns are
-- created WITHOUT foreign keys here (users does not exist yet) and are given
-- their foreign keys in 0004_identity.sql.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

CREATE TABLE data_sources (
    id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

    source_name             text         NOT NULL,
    publisher               text         NOT NULL,
    source_url              text,
    source_type             text         NOT NULL,
    dataset_name            text,
    document_reference      text,

    -- The granularity at which this publication actually states its values.
    -- Copied onto every record imported from it (Phase 1, P-4).
    data_scope              data_scope_t NOT NULL,

    -- Season / marketing year are meaningful for MSP publications and are left
    -- NULL for sources where they do not apply (e.g. a village directory).
    season_id               uuid,
    marketing_year          text,

    reference_date          date,
    retrieved_at            timestamptz  NOT NULL,
    retrieved_by_user_id    uuid,
    last_verified_at        timestamptz,
    last_verified_by_user_id uuid,

    version                 text,
    checksum                bytea,
    status                  text         NOT NULL DEFAULT 'ACTIVE',
    notes                   text,

    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT data_sources_source_type_allowed
        CHECK (source_type IN ('PORTAL', 'DOCUMENT', 'DATASET', 'API', 'MANUAL')),

    CONSTRAINT data_sources_status_allowed
        CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'RETRACTED')),

    CONSTRAINT data_sources_name_not_blank
        CHECK (btrim(source_name) <> ''),

    CONSTRAINT data_sources_publisher_not_blank
        CHECK (btrim(publisher) <> ''),

    -- A source that is not a manual entry must say where it came from.
    CONSTRAINT data_sources_url_or_document_required
        CHECK (
            source_type = 'MANUAL'
            OR source_url IS NOT NULL
            OR document_reference IS NOT NULL
        ),

    CONSTRAINT data_sources_verification_order
        CHECK (last_verified_at IS NULL OR last_verified_at >= retrieved_at)
);

COMMENT ON TABLE data_sources IS
    'Provenance registry. Every record classified OFFICIAL must reference a row '
    'here. Rows are created by an administrator or importer BEFORE any data is '
    'imported from the source. No row is seeded by any migration.';

COMMENT ON COLUMN data_sources.data_scope IS
    'The granularity the publication actually states. A STATE-scoped source can '
    'never be used to populate a FACILITY-scoped record.';

CREATE INDEX data_sources_status_idx           ON data_sources (status);
CREATE INDEX data_sources_season_id_idx        ON data_sources (season_id);
CREATE INDEX data_sources_retrieved_by_idx     ON data_sources (retrieved_by_user_id);
CREATE INDEX data_sources_verified_by_idx      ON data_sources (last_verified_by_user_id);

CREATE TRIGGER data_sources_set_updated_at
    BEFORE UPDATE ON data_sources
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

INSERT INTO schema_migrations (version, name) VALUES ('0002', 'provenance');

COMMIT;
