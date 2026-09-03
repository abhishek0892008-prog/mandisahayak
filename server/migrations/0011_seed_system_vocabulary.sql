-- =============================================================================
-- FarmQueue — 0011_seed_system_vocabulary
--
-- THIS FILE SEEDS SYSTEM VOCABULARY ONLY.
--
-- It contains NO government data:
--   no MSP rate, no storage capacity, no procurement centre, no mandi,
--   no crop, no state, district or village, no data_sources row.
--
-- What it does contain is the controlled vocabulary this system defines for
-- itself: roles, permission codes, the role-to-permission grant matrix, the two
-- marketing-season codes, the booking state machine, and reference version
-- counters. None of these are values taken from any publication.
--
-- The final block of this file ASSERTS that no government-data table has been
-- populated by any migration, and aborts the whole migration run if one has.
--
-- STATUS: WRITTEN, NOT EXECUTED.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Roles.
-- SUPER_ADMIN is intentionally absent (per the project brief). Adding it later
-- means altering roles_code_allowed and inserting one row.
-- -----------------------------------------------------------------------------
INSERT INTO roles (code, name, description) VALUES
    ('FARMER',  'Farmer',  'Registers, books procurement slots, tracks queue, procurement and payment status.'),
    ('OFFICER', 'Officer', 'Operates a procurement centre: arrival, weighing, quality, procurement progression.'),
    ('ADMIN',   'Admin',   'Manages users, centres, storage, MSP imports, configuration and reporting.');


-- -----------------------------------------------------------------------------
-- Permissions.
-- Every API route declares one of these. A startup assertion refuses to boot the
-- server if any route declares none, which turns "I forgot to protect the
-- endpoint" into a build failure rather than a security incident.
-- -----------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
    -- Common to every authenticated actor.
    ('profile.read.own',            'Read own profile.'),
    ('profile.update.own',          'Update own permitted profile fields.'),
    ('reference.read',              'Read reference data: districts, villages, crops, centres, seasons.'),
    ('slot.query',                  'Query centre availability and candidate time windows.'),

    -- Farmer.
    ('booking.create.own',          'Create a booking for oneself.'),
    ('booking.read.own',            'Read own bookings, current and historical.'),
    ('booking.cancel.own',          'Cancel own booking within the configured policy.'),
    ('queue.read.own',              'Read own queue position and estimated time.'),
    ('procurement.read.own',        'Read the procurement record for own booking.'),
    ('payment.read.own',            'Read the payment record for own procurement.'),
    ('notification.read.own',       'Read own notifications.'),
    ('notification.update.own',     'Mark own notifications as read.'),

    -- Officer (scoped to assigned centres).
    ('booking.read.centre',         'Read bookings at an assigned centre.'),
    ('booking.search.centre',       'Search bookings at an assigned centre by token, code or phone.'),
    ('booking.advance_state',       'Advance a booking through the procurement lifecycle.'),
    ('booking.mark_no_show',        'Record a no-show for a booking at an assigned centre.'),
    ('queue.read.centre',           'Read the live queue for an assigned centre.'),
    ('procurement.record_weight',   'Record gross, accepted and rejected quantities.'),
    ('procurement.record_quality',  'Record grade and quality outcome.'),
    ('procurement.complete',        'Complete a procurement record.'),
    ('payment.update_status',       'Update the status of a payment record.'),
    ('report.read.centre',          'Read reports scoped to an assigned centre.'),

    -- Admin.
    ('farmer.read',                 'Read farmer records for administration.'),
    ('officer.create',              'Create officer accounts.'),
    ('officer.deactivate',          'Deactivate an officer and revoke their sessions.'),
    ('officer.assign_centre',       'Assign or revoke an officer''s centre assignment.'),
    ('centre.create',               'Create a procurement centre.'),
    ('centre.update',               'Update procurement centre details.'),
    ('centre.configure',            'Change operating hours, holidays, crops, lanes and slot configuration.'),
    ('storage.configure',           'Create storage facilities and record capacity or inventory.'),
    ('crop.manage',                 'Create and update crop master records.'),
    ('msp.import',                  'Stage and validate an MSP import batch.'),
    ('msp.activate',                'Activate a validated MSP import batch.'),
    ('data_source.manage',          'Register and verify external data sources.'),
    ('notification_template.manage','Create and update notification templates.'),
    ('report.read',                 'Read system-wide reports.'),
    ('audit.read',                  'Read the audit log.');


-- -----------------------------------------------------------------------------
-- Grant matrix.
-- -----------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY (ARRAY[
    'profile.read.own',
    'profile.update.own',
    'reference.read',
    'slot.query',
    'booking.create.own',
    'booking.read.own',
    'booking.cancel.own',
    'queue.read.own',
    'procurement.read.own',
    'payment.read.own',
    'notification.read.own',
    'notification.update.own'
])
WHERE r.code = 'FARMER';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY (ARRAY[
    'profile.read.own',
    'profile.update.own',
    'reference.read',
    'slot.query',
    'booking.read.centre',
    'booking.search.centre',
    'booking.advance_state',
    'booking.mark_no_show',
    'queue.read.centre',
    'procurement.record_weight',
    'procurement.record_quality',
    'procurement.complete',
    'payment.update_status',
    'report.read.centre'
])
WHERE r.code = 'OFFICER';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = ANY (ARRAY[
    'profile.read.own',
    'profile.update.own',
    'reference.read',
    'slot.query',
    'booking.read.centre',
    'booking.search.centre',
    'queue.read.centre',
    'payment.update_status',
    'farmer.read',
    'officer.create',
    'officer.deactivate',
    'officer.assign_centre',
    'centre.create',
    'centre.update',
    'centre.configure',
    'storage.configure',
    'crop.manage',
    'msp.import',
    'msp.activate',
    'data_source.manage',
    'notification_template.manage',
    'report.read',
    'audit.read'
])
WHERE r.code = 'ADMIN';

-- Deliberate non-grants, asserted here so a future edit that widens them is a
-- visible change rather than an accident:
--   OFFICER has no msp.*, storage.*, centre.*, officer.*, crop.*, audit.read.
--   FARMER  has nothing beyond its own resources.
--   ADMIN   has no booking.advance_state and no procurement.record_* — recording
--           a weight is an act performed at a centre by the officer who performed it.


-- -----------------------------------------------------------------------------
-- Marketing seasons — vocabulary, not sourced data.
-- Which season an individual MSP rate belongs to always comes from the source
-- publication (Phase 3). Nothing here asserts that any crop belongs to either.
-- -----------------------------------------------------------------------------
INSERT INTO seasons (code, name) VALUES
    ('RMS', 'Rabi Marketing Season'),
    ('KMS', 'Kharif Marketing Season');


-- -----------------------------------------------------------------------------
-- Booking state machine (Decision D-4).
-- Terminal states: COMPLETED, CANCELLED, NO_SHOW — they appear only as
-- to_status, never as from_status, which is what makes COMPLETED -> ARRIVED
-- impossible.
-- -----------------------------------------------------------------------------
INSERT INTO booking_status_transitions (from_status, to_status, description) VALUES
    ('CONFIRMED',            'ARRIVED',              'Officer records the farmer arriving at the centre.'),
    ('CONFIRMED',            'CANCELLED',            'Farmer cancels before the configured cutoff.'),
    ('CONFIRMED',            'NO_SHOW',              'Farmer did not arrive; recorded by an officer or the sweep job.'),
    ('ARRIVED',              'WEIGHING',             'Weighing begins.'),
    ('ARRIVED',              'CANCELLED',            'Cancelled at the centre before weighing began.'),
    ('WEIGHING',             'QUALITY_CHECK',        'Gross weight recorded; quality assessment begins.'),
    ('WEIGHING',             'CANCELLED',            'Cancelled at the centre during weighing.'),
    ('QUALITY_CHECK',        'PROCUREMENT_RECORDED', 'Accepted and rejected quantities recorded.'),
    ('QUALITY_CHECK',        'CANCELLED',            'Cancelled at the centre during quality assessment.'),
    ('PROCUREMENT_RECORDED', 'PAYMENT_PENDING',      'Procurement complete; payment entitlement computed or blocked.'),
    ('PAYMENT_PENDING',      'COMPLETED',            'Payment status resolved; booking closed.');


-- -----------------------------------------------------------------------------
-- Reference dataset version counters.
-- -----------------------------------------------------------------------------
INSERT INTO reference_versions (resource) VALUES
    ('states'),
    ('districts'),
    ('villages'),
    ('mandis'),
    ('crops'),
    ('seasons'),
    ('procurement_centres'),
    ('notification_templates');


-- =============================================================================
-- NO-GOVERNMENT-DATA ASSERTION.
--
-- This is a real check, executed by PostgreSQL when the migrations are applied.
-- If any migration in this repository ever populates a table that is supposed to
-- hold sourced government data, the entire migration run aborts and rolls back.
-- =============================================================================
DO $$
DECLARE
    offending text;
BEGIN
    SELECT string_agg(table_name, ', ' ORDER BY table_name)
    INTO offending
    FROM (
        SELECT 'data_sources'        AS table_name WHERE EXISTS (SELECT 1 FROM data_sources)
        UNION ALL SELECT 'states'                  WHERE EXISTS (SELECT 1 FROM states)
        UNION ALL SELECT 'districts'               WHERE EXISTS (SELECT 1 FROM districts)
        UNION ALL SELECT 'villages'                WHERE EXISTS (SELECT 1 FROM villages)
        UNION ALL SELECT 'mandis'                  WHERE EXISTS (SELECT 1 FROM mandis)
        UNION ALL SELECT 'crops'                   WHERE EXISTS (SELECT 1 FROM crops)
        UNION ALL SELECT 'crop_aliases'            WHERE EXISTS (SELECT 1 FROM crop_aliases)
        UNION ALL SELECT 'procurement_centres'     WHERE EXISTS (SELECT 1 FROM procurement_centres)
        UNION ALL SELECT 'storage_facilities'      WHERE EXISTS (SELECT 1 FROM storage_facilities)
        UNION ALL SELECT 'storage_capacity'        WHERE EXISTS (SELECT 1 FROM storage_capacity)
        UNION ALL SELECT 'storage_inventory'       WHERE EXISTS (SELECT 1 FROM storage_inventory)
        UNION ALL SELECT 'msp_rates'               WHERE EXISTS (SELECT 1 FROM msp_rates)
        UNION ALL SELECT 'msp_import_batches'      WHERE EXISTS (SELECT 1 FROM msp_import_batches)
    ) AS populated;

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'Migration integrity failure: government-data tables were populated by a migration (%). '
            'Sourced data may only enter through the Phase 3/4 import pipeline, with provenance.',
            offending;
    END IF;

    RAISE NOTICE 'Verified: no government data was inserted by any migration.';
END
$$;

INSERT INTO schema_migrations (version, name) VALUES ('0011', 'seed_system_vocabulary');

COMMIT;
