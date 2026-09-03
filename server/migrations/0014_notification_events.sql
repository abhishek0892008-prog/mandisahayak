-- =============================================================================
-- FarmQueue — 0014_notification_events   (Phase 10)
--
-- PROBLEM
--   notification_event_t (migration 0001) allows eight event keys. Two events
--   Phase 10 must record are absent:
--     * BOOKING_ARRIVED  — the officer recorded the farmer arriving
--     * PAYMENT_BLOCKED  — completion could not resolve an MSP rate, so the
--                          payment carries a reason instead of an amount
--
--   Both are farmer-visible facts the system already produces; neither could be
--   written to the outbox without widening the domain.
--
-- WHAT THIS MIGRATION DOES
--   Widens the allowed set from 8 to 10 values. Nothing else.
--
-- WHAT IT DOES NOT DO
--   * It does not weaken an invariant. Widening a permitted set is additive;
--     every value that was legal before is still legal, and every value that is
--     legal now is still explicitly enumerated.
--   * It does not drop, rewrite or touch migrations 0001-0013.
--   * It does not add a column, table, index or trigger.
--   * It does not insert any data, government or otherwise.
--   * It does not add a threshold. QUEUE_APPROACHING remains unfireable because
--     approaching_position_threshold still does not exist anywhere, and no
--     value for it has been approved. Phase 10 does not invent one.
--
-- NAMING
--   The brief named an event "PAYMENT_STATUS_UPDATED". This repository already
--   established "PAYMENT_UPDATED" (architecture §16.4 and the 0001 domain), so
--   the existing convention is kept rather than a second name introduced for
--   the same fact.
--
-- FORWARD-ONLY.
-- =============================================================================

BEGIN;

ALTER DOMAIN notification_event_t
    DROP CONSTRAINT notification_event_t_allowed_values;

ALTER DOMAIN notification_event_t
    ADD CONSTRAINT notification_event_t_allowed_values
    CHECK (VALUE IN (
        'BOOKING_CONFIRMED',
        'BOOKING_CANCELLED',
        'BOOKING_ARRIVED',
        'ONE_DAY_REMINDER',
        'QUEUE_APPROACHING',
        'TURN_APPROACHING',
        'PROCUREMENT_COMPLETED',
        'PAYMENT_UPDATED',
        'PAYMENT_BLOCKED',
        'NO_SHOW_RECORDED'
    ));

COMMENT ON DOMAIN notification_event_t IS
    'Notification event keys. BOOKING_ARRIVED and PAYMENT_BLOCKED added in 0014 '
    '(Phase 10). QUEUE_APPROACHING and TURN_APPROACHING are permitted but are '
    'never enqueued: they require configured thresholds that do not exist.';

-- Assert the widening actually took effect, rather than assuming it did.
DO $$
DECLARE def text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'notification_event_t_allowed_values';

    IF def IS NULL THEN
        RAISE EXCEPTION '0014: notification_event_t_allowed_values is missing after the rewrite';
    END IF;
    IF position('BOOKING_ARRIVED' in def) = 0 OR position('PAYMENT_BLOCKED' in def) = 0 THEN
        RAISE EXCEPTION '0014: new event keys absent from the constraint: %', def;
    END IF;
    -- Every original value must survive. A widening that dropped one would be a
    -- silent narrowing for existing rows.
    IF position('BOOKING_CONFIRMED' in def) = 0
       OR position('BOOKING_CANCELLED' in def) = 0
       OR position('ONE_DAY_REMINDER' in def) = 0
       OR position('QUEUE_APPROACHING' in def) = 0
       OR position('TURN_APPROACHING' in def) = 0
       OR position('PROCUREMENT_COMPLETED' in def) = 0
       OR position('PAYMENT_UPDATED' in def) = 0
       OR position('NO_SHOW_RECORDED' in def) = 0
    THEN
        RAISE EXCEPTION '0014: an original event key was lost: %', def;
    END IF;

    RAISE NOTICE '0014: notification_event_t widened to 10 keys.';
END
$$;

INSERT INTO schema_migrations (version, name) VALUES ('0014', 'notification_events');

COMMIT;
