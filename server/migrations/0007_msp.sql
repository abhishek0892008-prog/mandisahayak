-- =============================================================================
-- FarmQueue — 0007_msp
-- Minimum Support Price rates and the staged import pipeline that is the only
-- way a rate may enter the system.
--
-- NO MSP VALUE APPEARS IN THIS FILE OR IN ANY MIGRATION. msp_rates is created
-- empty. Rates are imported in Phase 3 from an official publication registered
-- in data_sources, and the CHECK constraints below make an unsourced OFFICIAL
-- rate impossible to insert.
--
-- Rates are stored PER QUINTAL exactly as published (Decision D-9). The per-kg
-- figure is derived at calculation time and never stored, so no rounding is
-- baked into the stored value.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- msp_import_batches — one row per import attempt. Nothing is ever overwritten:
-- activating a batch supersedes previous rates, it does not update them.
-- -----------------------------------------------------------------------------
CREATE TABLE msp_import_batches (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id              uuid        NOT NULL REFERENCES data_sources (id) ON DELETE RESTRICT,
    initiated_by_user_id   uuid        REFERENCES users (id) ON DELETE RESTRICT,
    file_name              text,
    file_checksum          bytea,
    status                 text        NOT NULL DEFAULT 'STAGED',
    row_count              integer     NOT NULL DEFAULT 0,
    valid_row_count        integer     NOT NULL DEFAULT 0,
    failed_row_count       integer     NOT NULL DEFAULT 0,
    activated_at           timestamptz,
    activated_by_user_id   uuid        REFERENCES users (id) ON DELETE RESTRICT,
    rejected_at            timestamptz,
    notes                  text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT msp_import_batches_status_allowed
        CHECK (status IN ('STAGED', 'VALIDATED', 'ACTIVATED', 'REJECTED')),

    CONSTRAINT msp_import_batches_counts_nonnegative
        CHECK (row_count >= 0 AND valid_row_count >= 0 AND failed_row_count >= 0),

    CONSTRAINT msp_import_batches_counts_consistent
        CHECK (valid_row_count + failed_row_count <= row_count),

    CONSTRAINT msp_import_batches_activation_consistent
        CHECK (
            (status = 'ACTIVATED')
            = (activated_at IS NOT NULL AND activated_by_user_id IS NOT NULL)
        ),

    CONSTRAINT msp_import_batches_rejection_consistent
        CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL))
);

COMMENT ON TABLE msp_import_batches IS
    'Reproducible MSP import. A batch is staged, validated, reviewed by an '
    'administrator, then activated in a single transaction. Re-running an '
    'identical file is a no-op by checksum.';

CREATE INDEX msp_import_batches_source_id_idx    ON msp_import_batches (source_id);
CREATE INDEX msp_import_batches_status_idx       ON msp_import_batches (status);
CREATE INDEX msp_import_batches_initiated_by_idx ON msp_import_batches (initiated_by_user_id);
CREATE INDEX msp_import_batches_activated_by_idx ON msp_import_batches (activated_by_user_id);

CREATE TRIGGER msp_import_batches_set_updated_at
    BEFORE UPDATE ON msp_import_batches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- msp_rates.
-- Season and marketing year are taken from the source publication. The schema
-- never infers a season from a crop: there is no default, and both columns are
-- NOT NULL, so an import that cannot determine the season fails rather than
-- guessing.
-- -----------------------------------------------------------------------------
CREATE TABLE msp_rates (
    id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    crop_id                   uuid          NOT NULL REFERENCES crops (id)   ON DELETE RESTRICT,
    season_id                 uuid          NOT NULL REFERENCES seasons (id) ON DELETE RESTRICT,
    marketing_year            text          NOT NULL,
    -- NULL means the source published a single rate for this crop, not that the
    -- grade is unknown.
    variety_or_grade          text,

    rate_per_quintal_paise    bigint        NOT NULL,

    effective_from            date          NOT NULL,
    effective_to              date,

    status                    text          NOT NULL DEFAULT 'DRAFT',

    data_type                 data_type_t   NOT NULL,
    data_scope                data_scope_t  NOT NULL,
    source_id                 uuid          REFERENCES data_sources (id) ON DELETE RESTRICT,
    source_reference          text,
    retrieved_at              timestamptz,
    verified_at               timestamptz,
    verified_by_user_id       uuid          REFERENCES users (id) ON DELETE RESTRICT,
    import_batch_id           uuid          REFERENCES msp_import_batches (id) ON DELETE RESTRICT,
    superseded_by_id          uuid          REFERENCES msp_rates (id) ON DELETE RESTRICT,
    created_at                timestamptz   NOT NULL DEFAULT now(),
    updated_at                timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT msp_rates_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    -- An OFFICIAL rate must be traceable to a place in a document and a date.
    CONSTRAINT msp_rates_official_requires_provenance
        CHECK (
            data_type <> 'OFFICIAL'
            OR (source_reference IS NOT NULL AND retrieved_at IS NOT NULL)
        ),

    -- Only the import pipeline creates OFFICIAL rates, and it always records a
    -- batch. This makes a hand-inserted OFFICIAL rate impossible.
    CONSTRAINT msp_rates_official_requires_import_batch
        CHECK (data_type <> 'OFFICIAL' OR import_batch_id IS NOT NULL),

    CONSTRAINT msp_rates_status_allowed
        CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETRACTED')),

    CONSTRAINT msp_rates_rate_positive
        CHECK (rate_per_quintal_paise > 0),

    CONSTRAINT msp_rates_marketing_year_format
        CHECK (marketing_year ~ '^[0-9]{4}(-[0-9]{2})?$'),

    CONSTRAINT msp_rates_effective_range
        CHECK (effective_to IS NULL OR effective_to > effective_from),

    CONSTRAINT msp_rates_superseded_consistent
        CHECK (superseded_by_id IS NULL OR status = 'SUPERSEDED'),

    CONSTRAINT msp_rates_no_self_supersede
        CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

COMMENT ON TABLE msp_rates IS
    'Empty until Phase 3. Rates are stored per quintal exactly as published; '
    'the per-kilogram figure is derived at payment-calculation time.';
COMMENT ON COLUMN msp_rates.rate_per_quintal_paise IS
    'Integer paise per quintal, as published. Never a floating point value.';

-- Resolution must be unambiguous: at most one ACTIVE rate may exist for a given
-- crop, season, marketing year and grade over any date. COALESCE is used because
-- NULL grades would otherwise never conflict with each other, leaving a gap.
ALTER TABLE msp_rates
    ADD CONSTRAINT msp_rates_no_active_overlap
    EXCLUDE USING gist (
        crop_id        WITH =,
        season_id      WITH =,
        marketing_year WITH =,
        (COALESCE(variety_or_grade, '')) WITH =,
        (daterange(effective_from, effective_to)) WITH &&
    )
    WHERE (status = 'ACTIVE');

CREATE INDEX msp_rates_crop_id_idx          ON msp_rates (crop_id);
CREATE INDEX msp_rates_season_id_idx        ON msp_rates (season_id);
CREATE INDEX msp_rates_source_id_idx        ON msp_rates (source_id);
CREATE INDEX msp_rates_import_batch_id_idx  ON msp_rates (import_batch_id);
CREATE INDEX msp_rates_superseded_by_id_idx ON msp_rates (superseded_by_id);
CREATE INDEX msp_rates_verified_by_idx      ON msp_rates (verified_by_user_id);
CREATE INDEX msp_rates_lookup_idx
    ON msp_rates (crop_id, season_id, marketing_year, effective_from)
    WHERE status = 'ACTIVE';

CREATE TRIGGER msp_rates_set_updated_at
    BEFORE UPDATE ON msp_rates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- msp_import_rows — the staging area. raw_payload is kept verbatim so that an
-- import can always be re-examined against what the source actually said.
-- -----------------------------------------------------------------------------
CREATE TABLE msp_import_rows (
    id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id              uuid        NOT NULL REFERENCES msp_import_batches (id) ON DELETE CASCADE,
    row_number            integer     NOT NULL,
    raw_payload           jsonb       NOT NULL,
    normalized_payload    jsonb,
    validation_status     text        NOT NULL DEFAULT 'PENDING',
    validation_errors     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_msp_rate_id   uuid        REFERENCES msp_rates (id) ON DELETE RESTRICT,
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT msp_import_rows_validation_status_allowed
        CHECK (validation_status IN ('PENDING', 'VALID', 'INVALID')),

    CONSTRAINT msp_import_rows_row_number_positive
        CHECK (row_number > 0),

    CONSTRAINT msp_import_rows_unique_per_batch
        UNIQUE (batch_id, row_number),

    CONSTRAINT msp_import_rows_validation_errors_is_array
        CHECK (jsonb_typeof(validation_errors) = 'array'),

    -- A row that failed validation must say why, and must not have produced a rate.
    -- CASE is used rather than AND because PostgreSQL does not guarantee
    -- left-to-right evaluation of boolean operands: calling jsonb_array_length()
    -- on a non-array would raise a confusing type error instead of a clean
    -- constraint violation. CASE does guarantee that unselected branches are
    -- not evaluated.
    CONSTRAINT msp_import_rows_invalid_has_errors
        CHECK (
            validation_status <> 'INVALID'
            OR (
                CASE
                    WHEN jsonb_typeof(validation_errors) = 'array'
                        THEN jsonb_array_length(validation_errors) > 0
                    ELSE false
                END
                AND created_msp_rate_id IS NULL
            )
        )
);

CREATE INDEX msp_import_rows_batch_id_idx          ON msp_import_rows (batch_id);
CREATE INDEX msp_import_rows_validation_status_idx ON msp_import_rows (validation_status);
CREATE INDEX msp_import_rows_created_rate_idx      ON msp_import_rows (created_msp_rate_id);

INSERT INTO schema_migrations (version, name) VALUES ('0007', 'msp');

COMMIT;
