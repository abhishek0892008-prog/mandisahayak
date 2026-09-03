-- =============================================================================
-- FarmQueue — 0008_operations
-- Bookings, the booking state machine, procurement records, payments,
-- idempotency keys and the (empty) booking policy table.
--
-- THIS FILE CONTAINS THE OVERBOOKING-PREVENTION STRUCTURES.
-- Application scheduling and booking logic is Phase 7/8 and is NOT implemented
-- here; what is implemented is the set of database structures that make an
-- overbooked lane impossible regardless of what the application does.
--
-- DECISION D-4 (approved): nine canonical lifecycle states.
-- DECISION D-7 (approved): payments track STATUS only. There is deliberately no
--                          bank account number and no IFSC column.
-- A-3 (revised by you): no permanent "one active booking per farmer per crop"
--                       rule. See the two constraints under "duplicate and
--                       conflict prevention" below for what replaced it.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- booking_status_transitions — the state machine as data.
-- Seeded in 0011. The trigger below reads it, so the machine is defined in one
-- place and is queryable rather than buried in application code.
-- -----------------------------------------------------------------------------
CREATE TABLE booking_status_transitions (
    from_status  booking_status_t NOT NULL,
    to_status    booking_status_t NOT NULL,
    description  text,

    PRIMARY KEY (from_status, to_status),

    CONSTRAINT booking_status_transitions_no_self_loop
        CHECK (from_status <> to_status)
);

COMMENT ON TABLE booking_status_transitions IS
    'Allowed booking lifecycle transitions. Enforced by a BEFORE UPDATE trigger '
    'on bookings, so an illegal transition such as COMPLETED -> ARRIVED is '
    'rejected by the database and not only by the service layer.';


-- -----------------------------------------------------------------------------
-- bookings.
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
    id                            uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_code                  text              NOT NULL UNIQUE,

    farmer_id                     uuid              NOT NULL REFERENCES farmers (id)             ON DELETE RESTRICT,
    centre_id                     uuid              NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    crop_id                       uuid              NOT NULL REFERENCES crops (id)               ON DELETE RESTRICT,
    season_id                     uuid              NOT NULL REFERENCES seasons (id)             ON DELETE RESTRICT,
    marketing_year                text              NOT NULL,

    lane_no                       smallint          NOT NULL,

    -- THE 25-50 QUINTAL RULE, IN THE COLUMN ITSELF.
    -- Canonical unit is kilograms. 25 quintal = 2500 kg, 50 quintal = 5000 kg.
    -- No application code path, admin script or manual query can bypass this.
    requested_quantity_kg         integer           NOT NULL,

    service_date                  date              NOT NULL,
    scheduled_start_at            timestamptz       NOT NULL,
    scheduled_end_at              timestamptz       NOT NULL,

    -- The half-open interval this booking occupies on its lane. Generated, so
    -- it can never disagree with the two timestamps it is built from.
    -- tstzrange(a, b) defaults to '[)': start inclusive, end exclusive, which is
    -- what makes back-to-back bookings legal and overlapping ones not.
    service_window                tstzrange
        GENERATED ALWAYS AS (tstzrange(scheduled_start_at, scheduled_end_at)) STORED,

    estimated_processing_minutes  integer           NOT NULL,
    occupancy_minutes             integer           NOT NULL,

    token_number                  integer           NOT NULL,

    status                        booking_status_t  NOT NULL DEFAULT 'CONFIRMED',

    -- Which slot configuration produced this booking's timings. Retained so a
    -- past booking stays explainable after the configuration changes (P-10).
    slot_config_id                uuid              REFERENCES centre_slot_configurations (id) ON DELETE RESTRICT,

    cancelled_at                  timestamptz,
    cancellation_reason           text,
    cancelled_by_user_id          uuid              REFERENCES users (id) ON DELETE RESTRICT,
    no_show_at                    timestamptz,
    no_show_by_user_id            uuid              REFERENCES users (id) ON DELETE RESTRICT,

    created_at                    timestamptz       NOT NULL DEFAULT now(),
    updated_at                    timestamptz       NOT NULL DEFAULT now(),

    CONSTRAINT bookings_quantity_within_business_rule
        CHECK (requested_quantity_kg BETWEEN 2500 AND 5000),

    CONSTRAINT bookings_booking_code_format
        CHECK (booking_code ~ '^FQ-[0-9]{4}-[0-9]{7}$'),

    CONSTRAINT bookings_window_ordered
        CHECK (scheduled_end_at > scheduled_start_at),

    CONSTRAINT bookings_processing_minutes_positive
        CHECK (estimated_processing_minutes > 0),

    CONSTRAINT bookings_occupancy_not_below_processing
        CHECK (occupancy_minutes >= estimated_processing_minutes),

    CONSTRAINT bookings_token_number_positive
        CHECK (token_number > 0),

    CONSTRAINT bookings_marketing_year_format
        CHECK (marketing_year ~ '^[0-9]{4}(-[0-9]{2})?$'),

    CONSTRAINT bookings_cancellation_consistent
        CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),

    CONSTRAINT bookings_no_show_consistent
        CHECK ((status = 'NO_SHOW') = (no_show_at IS NOT NULL)),

    -- A booking's lane must exist at its centre.
    CONSTRAINT bookings_lane_fkey
        FOREIGN KEY (centre_id, lane_no)
        REFERENCES centre_service_lanes (centre_id, lane_no) ON DELETE RESTRICT,

    -- Tokens are unique where they are spoken aloud: at a centre, on a day.
    CONSTRAINT bookings_token_unique_per_centre_date
        UNIQUE (centre_id, service_date, token_number)
);

COMMENT ON TABLE bookings IS
    'Booking codes, tokens, intervals and lane assignment are all server-owned. '
    'Nothing here may originate from a client.';
COMMENT ON COLUMN bookings.requested_quantity_kg IS
    'Farmer-declared whole kilograms, constrained to 2500-5000 (25-50 quintal) '
    'by bookings_quantity_within_business_rule.';
COMMENT ON COLUMN bookings.service_window IS
    'Generated half-open [start, end) interval. Backing column for the two '
    'exclusion constraints below.';

-- ---------------------------------------------------------------------------
-- OVERBOOKING PREVENTION, LAYER 1.
-- Two active bookings can never occupy the same lane at the same centre at
-- overlapping times. This is a structural guarantee: it holds even if every
-- line of application code is wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_lane_overlap
    EXCLUDE USING gist (
        centre_id      WITH =,
        lane_no        WITH =,
        service_window WITH &&
    )
    WHERE (status IN (
        'CONFIRMED',
        'ARRIVED',
        'WEIGHING',
        'QUALITY_CHECK',
        'PROCUREMENT_RECORDED',
        'PAYMENT_PENDING'
    ));

-- ---------------------------------------------------------------------------
-- CONFLICT PREVENTION (replaces the withdrawn A-3 rule).
-- A farmer cannot hold two active bookings that overlap in time, because a
-- farmer cannot be in two places at once. This blocks nothing legitimate: a
-- farmer may still hold several future bookings, at different centres, for
-- different crops, on different dates, or even on the same date at
-- non-overlapping times.
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_farmer_overlap
    EXCLUDE USING gist (
        farmer_id      WITH =,
        service_window WITH &&
    )
    WHERE (status IN (
        'CONFIRMED',
        'ARRIVED',
        'WEIGHING',
        'QUALITY_CHECK',
        'PROCUREMENT_RECORDED',
        'PAYMENT_PENDING'
    ));

-- ---------------------------------------------------------------------------
-- DUPLICATE PREVENTION (replaces the withdrawn A-3 rule).
-- The same farmer cannot hold two active bookings for the same crop at the same
-- centre on the same day, which is what an accidental double submission looks
-- like. Different dates, centres and crops remain freely bookable, so future
-- legitimate bookings are not blocked.
-- Volume limits (how many active bookings a farmer may hold, seasonal caps) are
-- deliberately NOT hardcoded here; they live in booking_policies below and are
-- applied by the booking engine once you confirm the policy.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX bookings_no_duplicate_active_per_farmer_centre_crop_date
    ON bookings (farmer_id, centre_id, crop_id, service_date)
    WHERE status IN (
        'CONFIRMED',
        'ARRIVED',
        'WEIGHING',
        'QUALITY_CHECK',
        'PROCUREMENT_RECORDED',
        'PAYMENT_PENDING'
    );

CREATE INDEX bookings_farmer_id_idx        ON bookings (farmer_id);
CREATE INDEX bookings_centre_id_idx        ON bookings (centre_id);
CREATE INDEX bookings_crop_id_idx          ON bookings (crop_id);
CREATE INDEX bookings_season_id_idx        ON bookings (season_id);
CREATE INDEX bookings_slot_config_id_idx   ON bookings (slot_config_id);
CREATE INDEX bookings_cancelled_by_idx     ON bookings (cancelled_by_user_id);
CREATE INDEX bookings_no_show_by_idx       ON bookings (no_show_by_user_id);
CREATE INDEX bookings_status_idx           ON bookings (status);

-- The queue projection reads one centre's one day, ordered by start time.
CREATE INDEX bookings_centre_date_start_idx
    ON bookings (centre_id, service_date, scheduled_start_at);

-- The farmer's "current booking" and history reads.
CREATE INDEX bookings_farmer_status_start_idx
    ON bookings (farmer_id, status, scheduled_start_at DESC);

-- The one-day reminder job scans tomorrow's active bookings.
CREATE INDEX bookings_service_date_active_idx
    ON bookings (service_date)
    WHERE status = 'CONFIRMED';

CREATE TRIGGER bookings_set_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------------
-- State machine enforcement.
-- Fires only when status actually changes, and rejects any pair absent from
-- booking_status_transitions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bookings_enforce_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM booking_status_transitions t
        WHERE t.from_status = OLD.status
          AND t.to_status   = NEW.status
    ) THEN
        RAISE EXCEPTION
            'invalid booking status transition: % -> % (booking %)',
            OLD.status, NEW.status, OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_status_transition_guard
    BEFORE UPDATE OF status ON bookings
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION bookings_enforce_status_transition();


-- -----------------------------------------------------------------------------
-- booking_status_history — every transition, retained.
-- -----------------------------------------------------------------------------
CREATE TABLE booking_status_history (
    id                  uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          uuid              NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
    from_status         booking_status_t,
    to_status           booking_status_t  NOT NULL,
    changed_by_user_id  uuid              REFERENCES users (id) ON DELETE RESTRICT,
    changed_at          timestamptz       NOT NULL DEFAULT now(),
    reason              text,
    metadata            jsonb             NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON COLUMN booking_status_history.from_status IS
    'NULL for the row written when the booking is first created.';

CREATE INDEX booking_status_history_booking_id_idx ON booking_status_history (booking_id, changed_at);
CREATE INDEX booking_status_history_changed_by_idx ON booking_status_history (changed_by_user_id);


-- -----------------------------------------------------------------------------
-- booking_policies — configurable volume limits. Created EMPTY on purpose.
-- A-3 was withdrawn, so no limit is asserted by this migration. Phase 8
-- populates this table once the policy is confirmed, and the booking engine
-- reads it. Making the limits data rather than a constraint means changing the
-- policy later is an UPDATE, not a migration against live bookings.
-- -----------------------------------------------------------------------------
CREATE TABLE booking_policies (
    id                                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    scope                                     text          NOT NULL,
    centre_id                                 uuid          REFERENCES procurement_centres (id) ON DELETE RESTRICT,

    max_active_bookings_per_farmer            integer,
    max_active_bookings_per_farmer_per_centre integer,
    max_seasonal_quantity_kg                  numeric(14,3),

    effective_from                            date          NOT NULL,
    effective_to                              date,
    data_type                                 data_type_t   NOT NULL DEFAULT 'CONFIGURED',
    -- A booking limit is normally operator configuration, but a state may
    -- notify one officially (for example a per-farmer seasonal cap), so the
    -- provenance columns exist and the OFFICIAL rule applies here too.
    source_id                                 uuid          REFERENCES data_sources (id) ON DELETE RESTRICT,
    configured_by_user_id                     uuid          REFERENCES users (id) ON DELETE RESTRICT,
    configuration_note                        text,
    created_at                                timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT booking_policies_official_requires_source
        CHECK (data_type <> 'OFFICIAL' OR source_id IS NOT NULL),

    CONSTRAINT booking_policies_scope_allowed
        CHECK (scope IN ('GLOBAL', 'CENTRE')),

    CONSTRAINT booking_policies_centre_matches_scope
        CHECK ((scope = 'CENTRE') = (centre_id IS NOT NULL)),

    CONSTRAINT booking_policies_limits_positive
        CHECK (
            (max_active_bookings_per_farmer IS NULL
                OR max_active_bookings_per_farmer > 0)
            AND (max_active_bookings_per_farmer_per_centre IS NULL
                OR max_active_bookings_per_farmer_per_centre > 0)
            AND (max_seasonal_quantity_kg IS NULL
                OR max_seasonal_quantity_kg > 0)
        ),

    CONSTRAINT booking_policies_effective_range
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE booking_policies IS
    'Empty. Booking volume limits are deferred to Phase 8 pending confirmation '
    'of the policy; NULL means "no limit configured".';

CREATE INDEX booking_policies_centre_id_idx     ON booking_policies (centre_id);
CREATE INDEX booking_policies_source_id_idx     ON booking_policies (source_id);
CREATE INDEX booking_policies_configured_by_idx ON booking_policies (configured_by_user_id);


-- -----------------------------------------------------------------------------
-- procurements — what actually happened at the centre.
-- Measured weights are NUMERIC(12,3): a weighbridge reading is fractional and
-- must not be rounded on the way in.
-- -----------------------------------------------------------------------------
CREATE TABLE procurements (
    id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id            uuid          NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE RESTRICT,
    centre_id             uuid          NOT NULL REFERENCES procurement_centres (id) ON DELETE RESTRICT,
    officer_user_id       uuid          REFERENCES users (id) ON DELETE RESTRICT,

    arrived_at            timestamptz,
    service_started_at    timestamptz,
    service_ended_at      timestamptz,

    gross_quantity_kg     numeric(12,3),
    accepted_quantity_kg  numeric(12,3),
    rejected_quantity_kg  numeric(12,3),

    grade                 text,
    moisture_percent      numeric(5,2),
    quality_status        text          NOT NULL DEFAULT 'PENDING',
    rejection_reason      text,

    status                text          NOT NULL DEFAULT 'IN_PROGRESS',
    completed_at          timestamptz,

    created_at            timestamptz   NOT NULL DEFAULT now(),
    updated_at            timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT procurements_quality_status_allowed
        CHECK (quality_status IN ('PENDING', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED')),

    CONSTRAINT procurements_status_allowed
        CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED')),

    CONSTRAINT procurements_gross_positive
        CHECK (gross_quantity_kg IS NULL OR gross_quantity_kg > 0),

    CONSTRAINT procurements_accepted_nonnegative
        CHECK (accepted_quantity_kg IS NULL OR accepted_quantity_kg >= 0),

    CONSTRAINT procurements_rejected_nonnegative
        CHECK (rejected_quantity_kg IS NULL OR rejected_quantity_kg >= 0),

    -- Physical impossibility, refused by the storage layer.
    CONSTRAINT procurements_quantity_balance
        CHECK (
            gross_quantity_kg    IS NULL
            OR accepted_quantity_kg IS NULL
            OR rejected_quantity_kg IS NULL
            OR (accepted_quantity_kg + rejected_quantity_kg) <= gross_quantity_kg
        ),

    CONSTRAINT procurements_moisture_range
        CHECK (moisture_percent IS NULL OR (moisture_percent >= 0 AND moisture_percent <= 100)),

    CONSTRAINT procurements_arrival_before_service
        CHECK (
            service_started_at IS NULL
            OR arrived_at IS NULL
            OR service_started_at >= arrived_at
        ),

    CONSTRAINT procurements_service_ends_after_start
        CHECK (
            service_ended_at IS NULL
            OR service_started_at IS NULL
            OR service_ended_at >= service_started_at
        ),

    CONSTRAINT procurements_completion_consistent
        CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),

    -- A completed procurement must have been weighed and adjudicated.
    CONSTRAINT procurements_completed_requires_measurements
        CHECK (
            status <> 'COMPLETED'
            OR (
                gross_quantity_kg    IS NOT NULL
                AND accepted_quantity_kg IS NOT NULL
                AND rejected_quantity_kg IS NOT NULL
                AND quality_status <> 'PENDING'
            )
        )
);

CREATE INDEX procurements_centre_id_idx      ON procurements (centre_id);
CREATE INDEX procurements_officer_user_idx   ON procurements (officer_user_id);
CREATE INDEX procurements_status_idx         ON procurements (status);

CREATE TRIGGER procurements_set_updated_at
    BEFORE UPDATE ON procurements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- payments — STATUS TRACKING ONLY (Decision D-7).
-- FarmQueue does not disburse money. There is deliberately no account number,
-- no account holder name and no IFSC column. payment_reference is an opaque
-- string supplied by whichever system actually paid.
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
    id                               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    procurement_id                   uuid        NOT NULL UNIQUE REFERENCES procurements (id) ON DELETE RESTRICT,

    msp_rate_id                      uuid        REFERENCES msp_rates (id) ON DELETE RESTRICT,
    rate_per_quintal_paise_snapshot  bigint,

    base_amount_paise                bigint,
    deductions_paise                 bigint      NOT NULL DEFAULT 0,
    deduction_breakdown              jsonb       NOT NULL DEFAULT '[]'::jsonb,
    amount_paise                     bigint,
    currency                         text        NOT NULL DEFAULT 'INR',

    status                           text        NOT NULL DEFAULT 'BLOCKED',
    blocked_reason                   text,

    payment_reference                text,
    paid_at                          timestamptz,

    updated_by_user_id               uuid        REFERENCES users (id) ON DELETE RESTRICT,
    created_at                       timestamptz NOT NULL DEFAULT now(),
    updated_at                       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT payments_status_allowed
        CHECK (status IN ('BLOCKED', 'PENDING', 'INITIATED', 'PAID', 'FAILED', 'ON_HOLD')),

    CONSTRAINT payments_currency_allowed
        CHECK (currency = 'INR'),

    CONSTRAINT payments_blocked_reason_allowed
        CHECK (
            blocked_reason IS NULL
            OR blocked_reason IN ('NO_ACTIVE_MSP', 'MSP_AMBIGUOUS', 'AWAITING_QUALITY', 'POLICY_HOLD')
        ),

    -- A blocked payment must say why it is blocked, and must not assert an amount.
    CONSTRAINT payments_blocked_requires_reason
        CHECK (status <> 'BLOCKED' OR blocked_reason IS NOT NULL),

    CONSTRAINT payments_blocked_has_no_amount
        CHECK (status <> 'BLOCKED' OR amount_paise IS NULL),

    -- Any non-blocked payment must carry a computed amount and the rate it used,
    -- so the figure is always explainable.
    CONSTRAINT payments_unblocked_requires_amount
        CHECK (
            status = 'BLOCKED'
            OR (amount_paise IS NOT NULL
                AND base_amount_paise IS NOT NULL
                AND msp_rate_id IS NOT NULL
                AND rate_per_quintal_paise_snapshot IS NOT NULL)
        ),

    CONSTRAINT payments_amounts_nonnegative
        CHECK (
            (base_amount_paise IS NULL OR base_amount_paise >= 0)
            AND deductions_paise >= 0
            AND (amount_paise IS NULL OR amount_paise >= 0)
        ),

    CONSTRAINT payments_rate_snapshot_positive
        CHECK (rate_per_quintal_paise_snapshot IS NULL OR rate_per_quintal_paise_snapshot > 0),

    -- The arithmetic itself is enforced: amount = max(base - deductions, 0).
    CONSTRAINT payments_amount_arithmetic
        CHECK (
            amount_paise IS NULL
            OR base_amount_paise IS NULL
            OR amount_paise = GREATEST(base_amount_paise - deductions_paise, 0)
        ),

    CONSTRAINT payments_deduction_breakdown_is_array
        CHECK (jsonb_typeof(deduction_breakdown) = 'array'),

    CONSTRAINT payments_paid_requires_reference
        CHECK (
            status <> 'PAID'
            OR (payment_reference IS NOT NULL AND paid_at IS NOT NULL)
        )
);

COMMENT ON TABLE payments IS
    'Payment status tracking. FarmQueue does not disburse funds (Decision D-7); '
    'no bank account details are stored. amount_paise is computed server-side '
    'from accepted quantity and the applicable MSP, never supplied by a client.';
COMMENT ON COLUMN payments.blocked_reason IS
    'Why no amount could be computed. NO_ACTIVE_MSP is the honest answer when no '
    'MSP has been imported for the crop, season and year — no figure is estimated.';

CREATE INDEX payments_msp_rate_id_idx   ON payments (msp_rate_id);
CREATE INDEX payments_status_idx        ON payments (status);
CREATE INDEX payments_updated_by_idx    ON payments (updated_by_user_id);

CREATE TRIGGER payments_set_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- idempotency_keys — OVERBOOKING PREVENTION, LAYER 5.
-- A retried or double-clicked POST /bookings returns the first result instead
-- of creating a second booking.
-- -----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    key              text        PRIMARY KEY,
    user_id          uuid        REFERENCES users (id) ON DELETE CASCADE,
    endpoint         text        NOT NULL,
    request_hash     bytea       NOT NULL,
    response_status  smallint,
    response_body    jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,

    CONSTRAINT idempotency_keys_expiry_after_creation
        CHECK (expires_at > created_at),

    CONSTRAINT idempotency_keys_response_status_range
        CHECK (response_status IS NULL OR (response_status >= 100 AND response_status <= 599))
);

CREATE INDEX idempotency_keys_user_id_idx    ON idempotency_keys (user_id);
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

INSERT INTO schema_migrations (version, name) VALUES ('0008', 'operations');

COMMIT;
