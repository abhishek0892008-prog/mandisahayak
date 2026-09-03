-- =============================================================================
-- FarmQueue — 0005_centres
-- Procurement centres, service lanes, temporal operating configuration,
-- per-day capacity counters, officer assignments.
--
-- A procurement centre is NOT a mandi and NOT a storage facility. It may
-- optionally sit inside a mandi and may draw on storage facilities (0006).
--
-- DECISION D-8 (approved): storage_check_mode defaults to ADVISORY, because
-- centre-level official storage capacity is expected to be unavailable. The
-- system reports NO_CAPACITY_DATA_FOR_CENTRE rather than inventing headroom.
--
-- All operating configuration in this file is CONFIGURED data by default: no
-- government source is expected to publish a centre's transition buffer or
-- processing rate. Nothing here is seeded by any migration.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

CREATE TABLE procurement_centres (
    id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    code                text         NOT NULL UNIQUE,
    name                text         NOT NULL,
    state_id            uuid         NOT NULL REFERENCES states (id)    ON DELETE RESTRICT,
    district_id         uuid         NOT NULL REFERENCES districts (id) ON DELETE RESTRICT,
    mandi_id            uuid         REFERENCES mandis (id) ON DELETE RESTRICT,
    address             text,
    latitude            numeric(9,6),
    longitude           numeric(9,6),
    -- IANA timezone name. Wall-clock operating hours are stored as TIME and are
    -- interpreted in this zone. PostgreSQL cannot validate the name in a CHECK
    -- (pg_timezone_names is a set-returning function and subqueries are not
    -- permitted in CHECK), so the application validates it on write.
    timezone            text         NOT NULL DEFAULT 'Asia/Kolkata',
    status              text         NOT NULL DEFAULT 'ACTIVE',
    storage_check_mode  text         NOT NULL DEFAULT 'ADVISORY',
    data_type           data_type_t  NOT NULL,
    source_id           uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    created_at          timestamptz  NOT NULL DEFAULT now(),
    updated_at          timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT procurement_centres_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT procurement_centres_status_allowed
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),

    CONSTRAINT procurement_centres_storage_check_mode_allowed
        CHECK (storage_check_mode IN ('DISABLED', 'ADVISORY', 'ENFORCED')),

    CONSTRAINT procurement_centres_name_not_blank
        CHECK (btrim(name) <> ''),

    CONSTRAINT procurement_centres_timezone_not_blank
        CHECK (btrim(timezone) <> ''),

    CONSTRAINT procurement_centres_latitude_range
        CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),

    CONSTRAINT procurement_centres_longitude_range
        CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

COMMENT ON TABLE procurement_centres IS
    'Empty until Phase 4. Distinct from mandis and storage_facilities.';
COMMENT ON COLUMN procurement_centres.storage_check_mode IS
    'ENFORCED = refuse bookings without storage headroom. ADVISORY (default) = '
    'book anyway and report the absence of capacity data. DISABLED = do not evaluate.';

CREATE INDEX procurement_centres_district_id_idx ON procurement_centres (district_id);
CREATE INDEX procurement_centres_state_id_idx    ON procurement_centres (state_id);
CREATE INDEX procurement_centres_mandi_id_idx    ON procurement_centres (mandi_id);
CREATE INDEX procurement_centres_source_id_idx   ON procurement_centres (source_id);
CREATE INDEX procurement_centres_status_idx      ON procurement_centres (status);

CREATE TRIGGER procurement_centres_set_updated_at
    BEFORE UPDATE ON procurement_centres
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- centre_service_lanes — parallel service points (weighbridges/counters).
-- A centre with three lanes can serve three farmers concurrently. The UNIQUE
-- (centre_id, lane_no) below is what allows bookings to carry a composite
-- foreign key onto a lane, and is what makes the exclusion constraint in 0008
-- correct rather than artificially serialising a busy centre.
-- -----------------------------------------------------------------------------
CREATE TABLE centre_service_lanes (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id   uuid        NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    lane_no     smallint    NOT NULL,
    name        text,
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT centre_service_lanes_lane_no_positive
        CHECK (lane_no > 0),

    CONSTRAINT centre_service_lanes_centre_lane_unique
        UNIQUE (centre_id, lane_no)
);

CREATE INDEX centre_service_lanes_centre_id_idx ON centre_service_lanes (centre_id);

CREATE TRIGGER centre_service_lanes_set_updated_at
    BEFORE UPDATE ON centre_service_lanes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- centre_operating_hours — temporal (Phase 1, P-10).
-- Never updated in place: a change closes the current validity range and opens
-- a new one, so "which hours applied on 12 March" always has one answer.
-- -----------------------------------------------------------------------------
CREATE TABLE centre_operating_hours (
    id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id              uuid         NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    day_of_week            smallint     NOT NULL,
    opens_at               time         NOT NULL,
    closes_at              time         NOT NULL,
    effective_from         date         NOT NULL,
    effective_to           date,
    data_type              data_type_t  NOT NULL DEFAULT 'CONFIGURED',
    source_id              uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    configured_by_user_id  uuid         REFERENCES users (id) ON DELETE RESTRICT,
    configuration_note     text,
    created_at             timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT centre_operating_hours_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    -- 0 = Sunday .. 6 = Saturday, matching PostgreSQL's EXTRACT(DOW FROM ...).
    CONSTRAINT centre_operating_hours_day_of_week_range
        CHECK (day_of_week >= 0 AND day_of_week <= 6),

    CONSTRAINT centre_operating_hours_closes_after_opens
        CHECK (closes_at > opens_at),

    CONSTRAINT centre_operating_hours_effective_range
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- No two operating-hour rows for the same centre and weekday may cover
-- overlapping dates. daterange(from, to) defaults to '[)' — inclusive lower,
-- exclusive upper — and a NULL upper bound means unbounded.
ALTER TABLE centre_operating_hours
    ADD CONSTRAINT centre_operating_hours_no_overlap
    EXCLUDE USING gist (
        centre_id   WITH =,
        day_of_week WITH =,
        (daterange(effective_from, effective_to)) WITH &&
    );

CREATE INDEX centre_operating_hours_centre_id_idx    ON centre_operating_hours (centre_id);
CREATE INDEX centre_operating_hours_source_id_idx    ON centre_operating_hours (source_id);
CREATE INDEX centre_operating_hours_configured_by_idx ON centre_operating_hours (configured_by_user_id);


CREATE TABLE centre_holidays (
    id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id              uuid         NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    holiday_date           date         NOT NULL,
    reason                 text,
    data_type              data_type_t  NOT NULL DEFAULT 'CONFIGURED',
    source_id              uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    configured_by_user_id  uuid         REFERENCES users (id) ON DELETE RESTRICT,
    created_at             timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT centre_holidays_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT centre_holidays_unique_per_centre_date
        UNIQUE (centre_id, holiday_date)
);

CREATE INDEX centre_holidays_centre_id_idx     ON centre_holidays (centre_id);
CREATE INDEX centre_holidays_source_id_idx     ON centre_holidays (source_id);
CREATE INDEX centre_holidays_configured_by_idx ON centre_holidays (configured_by_user_id);


-- -----------------------------------------------------------------------------
-- centre_crop_configurations — which crops a centre accepts, for which season
-- and marketing year, over which dates.
-- -----------------------------------------------------------------------------
CREATE TABLE centre_crop_configurations (
    id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id              uuid         NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    crop_id                uuid         NOT NULL REFERENCES crops (id)   ON DELETE RESTRICT,
    season_id              uuid         NOT NULL REFERENCES seasons (id) ON DELETE RESTRICT,
    marketing_year         text         NOT NULL,
    is_active              boolean      NOT NULL DEFAULT true,
    effective_from         date         NOT NULL,
    effective_to           date,
    data_type              data_type_t  NOT NULL DEFAULT 'CONFIGURED',
    source_id              uuid         REFERENCES data_sources (id) ON DELETE RESTRICT,
    configured_by_user_id  uuid         REFERENCES users (id) ON DELETE RESTRICT,
    configuration_note     text,
    created_at             timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT centre_crop_configurations_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT centre_crop_configurations_marketing_year_format
        CHECK (marketing_year ~ '^[0-9]{4}(-[0-9]{2})?$'),

    CONSTRAINT centre_crop_configurations_effective_range
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

ALTER TABLE centre_crop_configurations
    ADD CONSTRAINT centre_crop_configurations_no_overlap
    EXCLUDE USING gist (
        centre_id      WITH =,
        crop_id        WITH =,
        season_id      WITH =,
        marketing_year WITH =,
        (daterange(effective_from, effective_to)) WITH &&
    );

CREATE INDEX centre_crop_configurations_centre_id_idx ON centre_crop_configurations (centre_id);
CREATE INDEX centre_crop_configurations_crop_id_idx   ON centre_crop_configurations (crop_id);
CREATE INDEX centre_crop_configurations_season_id_idx ON centre_crop_configurations (season_id);
CREATE INDEX centre_crop_configurations_source_id_idx ON centre_crop_configurations (source_id);
CREATE INDEX centre_crop_configurations_configured_by_idx
    ON centre_crop_configurations (configured_by_user_id);


-- -----------------------------------------------------------------------------
-- centre_slot_configurations — every parameter the scheduling engine reads.
-- The engine has no constants of its own; if a value is not here, it does not
-- exist. Temporal, so a past booking stays explainable by the configuration in
-- force when it was made.
-- -----------------------------------------------------------------------------
CREATE TABLE centre_slot_configurations (
    id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    centre_id                     uuid          NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,

    reference_quantity_kg         integer       NOT NULL,
    reference_processing_minutes  integer       NOT NULL,
    minimum_processing_minutes    integer       NOT NULL,
    maximum_processing_minutes    integer       NOT NULL,
    transition_buffer_minutes     integer       NOT NULL DEFAULT 0,
    slot_granularity_minutes      integer       NOT NULL,
    booking_horizon_days          integer       NOT NULL,
    cancellation_cutoff_hours     integer       NOT NULL,
    -- NULL means "no configured daily ceiling", not "zero".
    max_daily_processing_kg       numeric(14,3),

    effective_from                date          NOT NULL,
    effective_to                  date,
    data_type                     data_type_t   NOT NULL DEFAULT 'CONFIGURED',
    source_id                     uuid          REFERENCES data_sources (id) ON DELETE RESTRICT,
    configured_by_user_id         uuid          REFERENCES users (id) ON DELETE RESTRICT,
    configuration_note            text,
    created_at                    timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT centre_slot_configurations_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT centre_slot_configurations_reference_quantity_positive
        CHECK (reference_quantity_kg > 0),

    CONSTRAINT centre_slot_configurations_reference_minutes_positive
        CHECK (reference_processing_minutes > 0),

    CONSTRAINT centre_slot_configurations_minimum_minutes_positive
        CHECK (minimum_processing_minutes > 0),

    CONSTRAINT centre_slot_configurations_maximum_not_below_minimum
        CHECK (maximum_processing_minutes >= minimum_processing_minutes),

    CONSTRAINT centre_slot_configurations_buffer_nonnegative
        CHECK (transition_buffer_minutes >= 0),

    CONSTRAINT centre_slot_configurations_granularity_positive
        CHECK (slot_granularity_minutes > 0),

    CONSTRAINT centre_slot_configurations_horizon_positive
        CHECK (booking_horizon_days > 0),

    CONSTRAINT centre_slot_configurations_cutoff_nonnegative
        CHECK (cancellation_cutoff_hours >= 0),

    CONSTRAINT centre_slot_configurations_daily_cap_positive
        CHECK (max_daily_processing_kg IS NULL OR max_daily_processing_kg > 0),

    CONSTRAINT centre_slot_configurations_effective_range
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Exactly one slot configuration is in force for a centre on any given date.
ALTER TABLE centre_slot_configurations
    ADD CONSTRAINT centre_slot_configurations_no_overlap
    EXCLUDE USING gist (
        centre_id WITH =,
        (daterange(effective_from, effective_to)) WITH &&
    );

CREATE INDEX centre_slot_configurations_centre_id_idx ON centre_slot_configurations (centre_id);
CREATE INDEX centre_slot_configurations_source_id_idx ON centre_slot_configurations (source_id);
CREATE INDEX centre_slot_configurations_configured_by_idx
    ON centre_slot_configurations (configured_by_user_id);


-- -----------------------------------------------------------------------------
-- centre_daily_capacity — the row the booking transaction takes FOR UPDATE.
-- Serialises daily kilogram and minute accounting across concurrent bookings.
-- Counters are maintained by the booking engine in Phase 8.
-- -----------------------------------------------------------------------------
CREATE TABLE centre_daily_capacity (
    centre_id           uuid          NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    service_date        date          NOT NULL,
    booked_quantity_kg  numeric(14,3) NOT NULL DEFAULT 0,
    booked_minutes      integer       NOT NULL DEFAULT 0,
    booking_count       integer       NOT NULL DEFAULT 0,
    updated_at          timestamptz   NOT NULL DEFAULT now(),

    PRIMARY KEY (centre_id, service_date),

    CONSTRAINT centre_daily_capacity_quantity_nonnegative
        CHECK (booked_quantity_kg >= 0),

    CONSTRAINT centre_daily_capacity_minutes_nonnegative
        CHECK (booked_minutes >= 0),

    CONSTRAINT centre_daily_capacity_count_nonnegative
        CHECK (booking_count >= 0)
);

COMMENT ON TABLE centre_daily_capacity IS
    'Per-centre per-day counters. Locked with SELECT ... FOR UPDATE as the '
    'first lock of every booking transaction (fixed lock order: '
    'centre_daily_capacity, then storage_inventory, then bookings).';


-- -----------------------------------------------------------------------------
-- officer_centre_assignments — the resource scope for officer authorisation.
-- -----------------------------------------------------------------------------
CREATE TABLE officer_centre_assignments (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    officer_id           uuid        NOT NULL REFERENCES officers (id) ON DELETE RESTRICT,
    centre_id            uuid        NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    assigned_by_user_id  uuid        REFERENCES users (id) ON DELETE RESTRICT,
    assigned_at          timestamptz NOT NULL DEFAULT now(),
    revoked_at           timestamptz,
    revoked_by_user_id   uuid        REFERENCES users (id) ON DELETE RESTRICT,

    CONSTRAINT officer_centre_assignments_revocation_after_assignment
        CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);

-- An officer may hold only one live assignment to a given centre, but may be
-- reassigned after revocation, so the uniqueness is partial.
CREATE UNIQUE INDEX officer_centre_assignments_one_live_per_officer_centre
    ON officer_centre_assignments (officer_id, centre_id)
    WHERE revoked_at IS NULL;

CREATE INDEX officer_centre_assignments_centre_id_idx   ON officer_centre_assignments (centre_id);
CREATE INDEX officer_centre_assignments_officer_id_idx  ON officer_centre_assignments (officer_id);
CREATE INDEX officer_centre_assignments_assigned_by_idx ON officer_centre_assignments (assigned_by_user_id);
CREATE INDEX officer_centre_assignments_revoked_by_idx  ON officer_centre_assignments (revoked_by_user_id);

INSERT INTO schema_migrations (version, name) VALUES ('0005', 'centres');

COMMIT;
