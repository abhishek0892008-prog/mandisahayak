-- =============================================================================
-- FarmQueue — 0003_reference
-- Geographic and agricultural master data.
--
-- IMPORTANT: every table in this file is created EMPTY.
-- States, districts, villages and mandis are Local Government Directory data;
-- crops are derived from the official MSP publication. Both are imported in
-- Phase 3/4 with provenance. No migration inserts a single row of them.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- seasons — system vocabulary, not sourced data.
-- RMS (Rabi Marketing Season) and KMS (Kharif Marketing Season) are structural
-- classifications used to key MSP records. They carry no data_type because they
-- are a controlled vocabulary this system defines, not values taken from a
-- publication. Which season a given MSP rate belongs to always comes from the
-- source document (Phase 3), never from an assumption in code.
-- Seeded in 0011_seed_system_vocabulary.sql.
-- -----------------------------------------------------------------------------
CREATE TABLE seasons (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text        NOT NULL UNIQUE,
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT seasons_code_allowed
        CHECK (code IN ('RMS', 'KMS'))
);

COMMENT ON TABLE seasons IS
    'Marketing season vocabulary. RMS = Rabi Marketing Season, '
    'KMS = Kharif Marketing Season. Season assignment for any MSP rate is taken '
    'from the source publication, never inferred from the crop.';

-- data_sources.season_id could not be given its foreign key in 0002 because
-- seasons did not exist yet.
ALTER TABLE data_sources
    ADD CONSTRAINT data_sources_season_id_fkey
    FOREIGN KEY (season_id) REFERENCES seasons (id) ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- states / districts / villages — Local Government Directory hierarchy.
-- -----------------------------------------------------------------------------
CREATE TABLE states (
    id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    lgd_code    text         NOT NULL UNIQUE,
    name        text         NOT NULL,
    data_type   data_type_t  NOT NULL,
    source_id   uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT states_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT states_name_not_blank
        CHECK (btrim(name) <> '')
);

COMMENT ON TABLE states IS 'Empty until Phase 4 imports Local Government Directory data.';

CREATE INDEX states_source_id_idx ON states (source_id);

CREATE TRIGGER states_set_updated_at
    BEFORE UPDATE ON states
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE districts (
    id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    state_id    uuid         NOT NULL REFERENCES states (id) ON DELETE RESTRICT,
    lgd_code    text         NOT NULL,
    name        text         NOT NULL,
    data_type   data_type_t  NOT NULL,
    source_id   uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT districts_lgd_code_unique_per_state UNIQUE (state_id, lgd_code),

    CONSTRAINT districts_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT districts_name_not_blank
        CHECK (btrim(name) <> '')
);

CREATE INDEX districts_state_id_idx  ON districts (state_id);
CREATE INDEX districts_source_id_idx ON districts (source_id);

CREATE TRIGGER districts_set_updated_at
    BEFORE UPDATE ON districts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE villages (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id  uuid         NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
    lgd_code     text         NOT NULL,
    name         text         NOT NULL,
    data_type    data_type_t  NOT NULL,
    source_id    uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT villages_lgd_code_unique_per_district UNIQUE (district_id, lgd_code),

    CONSTRAINT villages_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT villages_name_not_blank
        CHECK (btrim(name) <> '')
);

COMMENT ON TABLE villages IS
    'Empty until Phase 4. The village lists hardcoded in the existing frontend '
    'prototype are unverified and must NOT be loaded here.';

CREATE INDEX villages_district_id_idx ON villages (district_id);
CREATE INDEX villages_source_id_idx   ON villages (source_id);

CREATE TRIGGER villages_set_updated_at
    BEFORE UPDATE ON villages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- mandis — agricultural markets.
-- A mandi is NOT a procurement centre and NOT a storage facility. It is a
-- separate entity that a procurement centre may optionally sit inside.
-- -----------------------------------------------------------------------------
CREATE TABLE mandis (
    id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    district_id  uuid         NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
    code         text         NOT NULL,
    name         text         NOT NULL,
    data_type    data_type_t  NOT NULL,
    source_id    uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT mandis_code_unique_per_district UNIQUE (district_id, code),

    CONSTRAINT mandis_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT mandis_name_not_blank
        CHECK (btrim(name) <> '')
);

COMMENT ON TABLE mandis IS
    'Agricultural market. Deliberately separate from procurement_centres and '
    'storage_facilities; a mandi is never automatically either of those.';

CREATE INDEX mandis_district_id_idx ON mandis (district_id);
CREATE INDEX mandis_source_id_idx   ON mandis (source_id);

CREATE TRIGGER mandis_set_updated_at
    BEFORE UPDATE ON mandis
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- crops and their import-time aliases.
-- -----------------------------------------------------------------------------
CREATE TABLE crops (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text         NOT NULL UNIQUE,
    canonical_name  text         NOT NULL,
    is_active       boolean      NOT NULL DEFAULT true,
    data_type       data_type_t  NOT NULL,
    source_id       uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT crops_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT crops_code_format
        CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),

    CONSTRAINT crops_canonical_name_not_blank
        CHECK (btrim(canonical_name) <> '')
);

COMMENT ON TABLE crops IS
    'Empty until Phase 3. Crop rows are derived from the official MSP '
    'publication so that crop and season classification share one provenance. '
    'The prototype''s "Other" option has no row here and never will: it cannot '
    'carry an MSP or a centre eligibility rule.';

CREATE INDEX crops_source_id_idx ON crops (source_id);
CREATE INDEX crops_is_active_idx ON crops (is_active);

CREATE TRIGGER crops_set_updated_at
    BEFORE UPDATE ON crops
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE crop_aliases (
    id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    crop_id           uuid         NOT NULL REFERENCES crops (id) ON DELETE CASCADE,
    alias             text         NOT NULL,
    -- lower() and btrim() are immutable, so this may be a STORED generated
    -- column and may carry a unique index.
    normalized_alias  text         GENERATED ALWAYS AS (lower(btrim(alias))) STORED,
    source_id         uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at        timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT crop_aliases_alias_not_blank
        CHECK (btrim(alias) <> '')
);

COMMENT ON TABLE crop_aliases IS
    'Maps the spellings used by source publications onto canonical crops during '
    'MSP import. Prevents crop-name normalisation logic from being duplicated.';

CREATE UNIQUE INDEX crop_aliases_normalized_alias_key ON crop_aliases (normalized_alias);
CREATE INDEX crop_aliases_crop_id_idx   ON crop_aliases (crop_id);
CREATE INDEX crop_aliases_source_id_idx ON crop_aliases (source_id);

INSERT INTO schema_migrations (version, name) VALUES ('0003', 'reference');

COMMIT;
