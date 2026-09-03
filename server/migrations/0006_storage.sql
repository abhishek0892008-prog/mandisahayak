-- =============================================================================
-- FarmQueue — 0006_storage
-- Storage facilities, published capacity (scope-preserving), live inventory,
-- and the centre-to-facility link.
--
-- PRINCIPLE P-4 IS ENFORCED BY THE SCHEMA HERE.
-- storage_capacity carries a data_scope together with mutually exclusive
-- target columns. A row whose source published a STATE-level figure physically
-- cannot reference a facility: the CHECK constraint rejects it. There is no
-- code path, admin screen or import script that can turn a state total into a
-- warehouse's capacity.
--
-- No capacity figure is seeded by any migration. All tables start empty.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

CREATE TABLE storage_facilities (
    id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text         NOT NULL,
    facility_type  text         NOT NULL,
    owner_agency   text,
    state_id       uuid         REFERENCES states (id)    ON DELETE RESTRICT,
    district_id    uuid         REFERENCES districts (id) ON DELETE RESTRICT,
    address        text,
    latitude       numeric(9,6),
    longitude      numeric(9,6),
    status         text         NOT NULL DEFAULT 'ACTIVE',
    data_type      data_type_t  NOT NULL,
    source_id      uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at     timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT storage_facilities_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT storage_facilities_type_allowed
        CHECK (facility_type IN ('WAREHOUSE', 'SILO', 'GODOWN', 'OPEN_PLINTH', 'OTHER')),

    CONSTRAINT storage_facilities_status_allowed
        CHECK (status IN ('ACTIVE', 'INACTIVE')),

    CONSTRAINT storage_facilities_name_not_blank
        CHECK (btrim(name) <> ''),

    CONSTRAINT storage_facilities_latitude_range
        CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),

    CONSTRAINT storage_facilities_longitude_range
        CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

COMMENT ON TABLE storage_facilities IS
    'A storage facility is not a procurement centre and not a mandi. '
    'Empty until Phase 4.';

CREATE INDEX storage_facilities_state_id_idx    ON storage_facilities (state_id);
CREATE INDEX storage_facilities_district_id_idx ON storage_facilities (district_id);
CREATE INDEX storage_facilities_source_id_idx   ON storage_facilities (source_id);
CREATE INDEX storage_facilities_status_idx      ON storage_facilities (status);

CREATE TRIGGER storage_facilities_set_updated_at
    BEFORE UPDATE ON storage_facilities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- storage_capacity — published capacity, recorded at the scope the publication
-- actually used.
-- -----------------------------------------------------------------------------
CREATE TABLE storage_capacity (
    id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The scope the SOURCE published at. Determines which target column may be
    -- populated (see storage_capacity_scope_target below).
    data_scope             data_scope_t  NOT NULL,
    facility_id            uuid          REFERENCES storage_facilities (id) ON DELETE RESTRICT,
    district_id            uuid          REFERENCES districts (id)          ON DELETE RESTRICT,
    state_id               uuid          REFERENCES states (id)             ON DELETE RESTRICT,

    capacity_kg            numeric(14,3) NOT NULL,
    capacity_type          text          NOT NULL DEFAULT 'TOTAL',

    effective_from         date          NOT NULL,
    effective_to           date,

    data_type              data_type_t   NOT NULL,
    source_id              uuid          REFERENCES data_sources (id) ON DELETE RESTRICT,
    source_reference       text,
    retrieved_at           timestamptz,
    verified_at            timestamptz,
    configured_by_user_id  uuid          REFERENCES users (id) ON DELETE RESTRICT,
    configuration_note     text,
    created_at             timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT storage_capacity_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    -- An OFFICIAL capacity claim must be traceable to a specific place in a
    -- specific document, retrieved on a specific date.
    CONSTRAINT storage_capacity_official_requires_provenance
        CHECK (
            data_type <> 'OFFICIAL'
            OR (source_reference IS NOT NULL AND retrieved_at IS NOT NULL)
        ),

    -- A CONFIGURED capacity must name the operator who entered it.
    CONSTRAINT storage_capacity_configured_requires_operator
        CHECK (data_type <> 'CONFIGURED' OR configured_by_user_id IS NOT NULL),

    -- THE SCOPE GUARD (P-4). Exactly one target column may be set, and which
    -- one is dictated by data_scope. A STATE-scoped figure cannot be attached
    -- to a facility; a NATIONAL figure cannot be attached to anything.
    CONSTRAINT storage_capacity_scope_target
        CHECK (
            (data_scope = 'FACILITY'
                AND facility_id IS NOT NULL
                AND district_id IS NULL
                AND state_id    IS NULL)
            OR (data_scope = 'DISTRICT'
                AND facility_id IS NULL
                AND district_id IS NOT NULL
                AND state_id    IS NULL)
            OR (data_scope = 'STATE'
                AND facility_id IS NULL
                AND district_id IS NULL
                AND state_id    IS NOT NULL)
            OR (data_scope = 'NATIONAL'
                AND facility_id IS NULL
                AND district_id IS NULL
                AND state_id    IS NULL)
        ),

    CONSTRAINT storage_capacity_capacity_positive
        CHECK (capacity_kg > 0),

    CONSTRAINT storage_capacity_type_allowed
        CHECK (capacity_type IN ('COVERED', 'OPEN', 'TOTAL')),

    CONSTRAINT storage_capacity_effective_range
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE storage_capacity IS
    'Published storage capacity, held at the granularity the source actually '
    'stated. The storage_capacity_scope_target constraint makes it impossible '
    'to record a state or district aggregate as a facility capacity.';
COMMENT ON COLUMN storage_capacity.data_scope IS
    'Copied from data_sources.data_scope at import. Never widened or narrowed.';

-- One facility-scoped capacity of a given type is in force at a time.
ALTER TABLE storage_capacity
    ADD CONSTRAINT storage_capacity_facility_no_overlap
    EXCLUDE USING gist (
        facility_id   WITH =,
        capacity_type WITH =,
        (daterange(effective_from, effective_to)) WITH &&
    )
    WHERE (data_scope = 'FACILITY');

CREATE INDEX storage_capacity_facility_id_idx   ON storage_capacity (facility_id);
CREATE INDEX storage_capacity_district_id_idx   ON storage_capacity (district_id);
CREATE INDEX storage_capacity_state_id_idx      ON storage_capacity (state_id);
CREATE INDEX storage_capacity_source_id_idx     ON storage_capacity (source_id);
CREATE INDEX storage_capacity_configured_by_idx ON storage_capacity (configured_by_user_id);
CREATE INDEX storage_capacity_data_scope_idx    ON storage_capacity (data_scope);


-- -----------------------------------------------------------------------------
-- storage_inventory — live operational state, one row per facility.
-- This is the row the booking transaction takes FOR UPDATE when a centre is in
-- ENFORCED storage mode. available_kg is deliberately NOT stored: it is derived
-- as (capacity - occupied - reserved) so it cannot drift from its inputs.
-- -----------------------------------------------------------------------------
CREATE TABLE storage_inventory (
    facility_id          uuid          PRIMARY KEY REFERENCES storage_facilities (id) ON DELETE RESTRICT,
    occupied_kg          numeric(14,3) NOT NULL DEFAULT 0,
    reserved_kg          numeric(14,3) NOT NULL DEFAULT 0,
    as_of                timestamptz   NOT NULL DEFAULT now(),
    data_type            data_type_t   NOT NULL DEFAULT 'CONFIGURED',
    source_id            uuid          REFERENCES data_sources (id) ON DELETE RESTRICT,
    updated_by_user_id   uuid          REFERENCES users (id) ON DELETE RESTRICT,
    note                 text,
    updated_at           timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT storage_inventory_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT storage_inventory_occupied_nonnegative
        CHECK (occupied_kg >= 0),

    CONSTRAINT storage_inventory_reserved_nonnegative
        CHECK (reserved_kg >= 0)
);

COMMENT ON TABLE storage_inventory IS
    'Current occupancy and booking reservations per facility. Live occupancy is '
    'expected to be operational (CONFIGURED) data, not published government data.';

CREATE INDEX storage_inventory_source_id_idx  ON storage_inventory (source_id);
CREATE INDEX storage_inventory_updated_by_idx ON storage_inventory (updated_by_user_id);

CREATE TRIGGER storage_inventory_set_updated_at
    BEFORE UPDATE ON storage_inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- centre_storage_links — a centre may draw on zero or more facilities.
-- Zero links is a normal, expected state and is exactly what makes a centre
-- report NO_CAPACITY_DATA_FOR_CENTRE under ADVISORY mode (Decision D-8).
-- -----------------------------------------------------------------------------
CREATE TABLE centre_storage_links (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id    uuid        NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    facility_id  uuid        NOT NULL REFERENCES storage_facilities (id)  ON DELETE RESTRICT,
    priority     smallint    NOT NULL DEFAULT 1,
    is_active    boolean     NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT centre_storage_links_priority_positive
        CHECK (priority > 0),

    CONSTRAINT centre_storage_links_unique_pair
        UNIQUE (centre_id, facility_id)
);

CREATE INDEX centre_storage_links_centre_id_idx   ON centre_storage_links (centre_id);
CREATE INDEX centre_storage_links_facility_id_idx ON centre_storage_links (facility_id);

INSERT INTO schema_migrations (version, name) VALUES ('0006', 'storage');

COMMIT;
