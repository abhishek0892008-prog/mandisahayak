-- =============================================================================
-- FarmQueue — schema verification suite
--
-- STATUS: WRITTEN, NEVER EXECUTED. No PostgreSQL server was available in the
--         environment where the Phase 2 migrations were authored. Running this
--         file is what turns Phase 2 from "written" into "verified".
--
-- WHAT IT DOES
--   Part A — structural assertions read from the system catalogs.
--   Part B — behavioural probes: it inserts TEST-classified fixtures, attempts
--            operations that MUST be rejected, and checks that they were.
--
-- SAFETY
--   The entire file runs inside one transaction and ends with ROLLBACK.
--   Nothing it inserts is ever committed, so no TEST row and no fixture can
--   leak into a real database. Run it against a database that already has the
--   migrations applied.
--
-- USAGE
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-schema.sql
--
-- EXIT BEHAVIOUR
--   Prints one line per check. Raises at the end if any check failed, so
--   ON_ERROR_STOP=1 gives a non-zero exit status for CI.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _verify_results (
    seq        serial,
    check_name text    NOT NULL,
    passed     boolean NOT NULL,
    detail     text
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.note_result(p_check text, p_passed boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
    INSERT INTO _verify_results (check_name, passed, detail)
    VALUES (p_check, p_passed, p_detail);
END;
$fn$;


-- =============================================================================
-- PART A — STRUCTURAL ASSERTIONS
-- =============================================================================

-- A1. Required extension.
DO $$
BEGIN
    PERFORM pg_temp.note_result(
        'A1 btree_gist installed',
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'),
        'Required so EXCLUDE USING gist can mix "WITH =" and "WITH &&"'
    );
END $$;

-- A2. Server version.
DO $$
DECLARE v int := current_setting('server_version_num')::int;
BEGIN
    PERFORM pg_temp.note_result('A2 server version >= 13', v >= 130000, current_setting('server_version'));
END $$;

-- A3. Domains.
DO $$
DECLARE expected text[] := ARRAY[
    'data_type_t','data_scope_t','locale_t','e164_t','booking_status_t','notification_event_t'];
    missing text[];
BEGIN
    SELECT array_agg(d) INTO missing
    FROM unnest(expected) AS d
    WHERE NOT EXISTS (SELECT 1 FROM pg_type t WHERE t.typname = d AND t.typtype = 'd');

    PERFORM pg_temp.note_result('A3 all domains exist', missing IS NULL, coalesce('missing: ' || array_to_string(missing, ', '), 'all 6 present'));
END $$;

-- A4. Every table carrying data_type also enforces OFFICIAL -> source_id.
DO $$
DECLARE offending text;
BEGIN
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offending
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'data_type' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind = 'r'
      AND n.nspname = 'public'
      AND NOT EXISTS (
          SELECT 1 FROM pg_constraint k
          WHERE k.conrelid = c.oid
            AND k.contype = 'c'
            AND pg_get_constraintdef(k.oid) ILIKE '%OFFICIAL%source_id IS NOT NULL%'
      );

    PERFORM pg_temp.note_result(
        'A4 OFFICIAL requires source_id on every classified table',
        offending IS NULL,
        coalesce('missing on: ' || offending, 'enforced everywhere')
    );
END $$;

-- A5. Exclusion constraints present.
DO $$
-- msp_rates_no_active_overlap was intentionally removed by migration 0013:
-- under D-9 the MSP identity is crop+season+marketing_year+grade, and a
-- date-range exclusion cannot express that once effective_from may be NULL.
-- Its replacement, msp_rates_one_active_per_identity, is asserted in A5b.
DECLARE expected text[] := ARRAY[
    'bookings_no_lane_overlap',
    'bookings_no_farmer_overlap',
    'centre_operating_hours_no_overlap',
    'centre_slot_configurations_no_overlap',
    'centre_crop_configurations_no_overlap',
    'storage_capacity_facility_no_overlap'];
    missing text[];
BEGIN
    SELECT array_agg(e) INTO missing
    FROM unnest(expected) AS e
    WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = e AND contype = 'x'
    );

    PERFORM pg_temp.note_result('A5 all 6 exclusion constraints exist', missing IS NULL,
        coalesce('missing: ' || array_to_string(missing, ', '), 'all present'));
END $$;

-- A5b. The D-9 replacement for the removed MSP exclusion constraint.
DO $$
DECLARE has_index boolean; old_gone boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_indexes
                   WHERE schemaname = 'public'
                     AND indexname = 'msp_rates_one_active_per_identity')
    INTO has_index;
    SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'msp_rates_no_active_overlap')
    INTO old_gone;

    PERFORM pg_temp.note_result('A5b MSP identity index replaced the date-range constraint',
        has_index AND old_gone,
        format('identity index present=%s, old exclusion removed=%s', has_index, old_gone));
END $$;

-- A6. Every foreign key has an index leading on its first column.
DO $$
DECLARE offending text;
BEGIN
    SELECT string_agg(format('%s(%s)', tbl, col), ', ') INTO offending
    FROM (
        SELECT c.conrelid::regclass::text AS tbl,
               a.attname                  AS col
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f'
          AND NOT EXISTS (
              SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid
                AND i.indkey[0] = c.conkey[1]
          )
    ) AS unindexed;

    PERFORM pg_temp.note_result('A6 every foreign key is indexed', offending IS NULL,
        coalesce('unindexed: ' || offending, 'all foreign keys covered'));
END $$;

-- A7. Audit immutability triggers.
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n
    FROM pg_trigger
    WHERE tgrelid = 'audit_logs'::regclass
      AND NOT tgisinternal
      AND tgname IN ('audit_logs_forbid_update','audit_logs_forbid_delete','audit_logs_forbid_truncate');

    PERFORM pg_temp.note_result('A7 audit_logs has 3 immutability triggers', n = 3, format('found %s', n));
END $$;

-- A8. Government-data integrity.
--
--   HISTORY: this probe originally asserted that these tables were EMPTY, which
--   was the right check while only migrations had run. Once the Phase 3/4
--   imports legitimately populate them it can no longer distinguish "a migration
--   smuggled in fake data" from "an authorised import ran", so it asserted the
--   wrong thing.
--
--   The guarantee that migrations insert no government data is unchanged and is
--   enforced where it belongs: the DO block at the end of
--   0011_seed_system_vocabulary.sql aborts the entire migration run if any of
--   these tables is populated at migration time.
--
--   What this probe now asserts is the invariant that holds at every point in
--   the system's life: everything in a government-data table is correctly
--   classified, and nothing claims OFFICIAL status without provenance.
DO $$
DECLARE offending text;
BEGIN
    SELECT string_agg(msg, '; ' ORDER BY msg) INTO offending
    FROM (
        SELECT 'states: OFFICIAL without source' AS msg
            WHERE EXISTS (SELECT 1 FROM states WHERE data_type = 'OFFICIAL' AND source_id IS NULL)
        UNION ALL SELECT 'districts: OFFICIAL without source'
            WHERE EXISTS (SELECT 1 FROM districts WHERE data_type = 'OFFICIAL' AND source_id IS NULL)
        UNION ALL SELECT 'districts: OFFICIAL without lgd_code'
            WHERE EXISTS (SELECT 1 FROM districts WHERE data_type = 'OFFICIAL' AND lgd_code IS NULL)
        UNION ALL SELECT 'crops: OFFICIAL without source'
            WHERE EXISTS (SELECT 1 FROM crops WHERE data_type = 'OFFICIAL' AND source_id IS NULL)
        UNION ALL SELECT 'procurement_centres: OFFICIAL without source'
            WHERE EXISTS (SELECT 1 FROM procurement_centres WHERE data_type = 'OFFICIAL' AND source_id IS NULL)
        UNION ALL SELECT 'storage_capacity: OFFICIAL without source'
            WHERE EXISTS (SELECT 1 FROM storage_capacity WHERE data_type = 'OFFICIAL' AND source_id IS NULL)
        UNION ALL SELECT 'msp_rates: OFFICIAL without source or import batch'
            WHERE EXISTS (SELECT 1 FROM msp_rates
                          WHERE data_type = 'OFFICIAL'
                            AND (source_id IS NULL OR import_batch_id IS NULL))
        UNION ALL SELECT 'TEST data present outside fixtures'
            WHERE EXISTS (SELECT 1 FROM msp_rates WHERE data_type = 'TEST')
               OR EXISTS (SELECT 1 FROM procurement_centres WHERE data_type = 'TEST')
               OR EXISTS (SELECT 1 FROM storage_capacity WHERE data_type = 'TEST')
    ) AS problems;

    PERFORM pg_temp.note_result('A8 government data is classified and provenanced',
        offending IS NULL,
        coalesce(offending, 'every OFFICIAL row carries provenance; no stray TEST data'));
END $$;

-- A9. System vocabulary seeded.
DO $$
DECLARE r int; p int; rp int; s int; t int;
BEGIN
    SELECT count(*) INTO r  FROM roles;
    SELECT count(*) INTO p  FROM permissions;
    SELECT count(*) INTO rp FROM role_permissions;
    SELECT count(*) INTO s  FROM seasons;
    SELECT count(*) INTO t  FROM booking_status_transitions;

    PERFORM pg_temp.note_result('A9 system vocabulary seeded',
        r = 3 AND p > 30 AND rp > 40 AND s = 2 AND t = 11,
        format('roles=%s permissions=%s grants=%s seasons=%s transitions=%s', r, p, rp, s, t));
END $$;

-- A10. Officers hold no administrative permissions.
DO $$
DECLARE leaked text;
BEGIN
    SELECT string_agg(p.code, ', ') INTO leaked
    FROM role_permissions rp
    JOIN roles r       ON r.id = rp.role_id AND r.code = 'OFFICER'
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.code LIKE 'msp.%'
       OR p.code LIKE 'storage.%'
       OR p.code LIKE 'centre.%'
       OR p.code LIKE 'officer.%'
       OR p.code LIKE 'crop.%'
       OR p.code = 'audit.read';

    PERFORM pg_temp.note_result('A10 OFFICER has no admin permissions', leaked IS NULL,
        coalesce('leaked: ' || leaked, 'correctly withheld'));
END $$;


-- =============================================================================
-- PART B — BEHAVIOURAL PROBES
-- Fixtures are classified TEST and are rolled back with everything else.
-- =============================================================================

-- Fixture chain.
INSERT INTO data_sources (id, source_name, publisher, source_type, data_scope, retrieved_at, notes)
VALUES ('00000000-0000-0000-0000-0000000000f0', 'VERIFY FIXTURE', 'VERIFY FIXTURE',
        'MANUAL', 'STATE', now(), 'Rolled back by verify-schema.sql');

INSERT INTO states (id, lgd_code, name, data_type)
VALUES ('00000000-0000-0000-0000-000000000001', 'TESTST', 'Test State', 'TEST');

INSERT INTO districts (id, state_id, lgd_code, name, data_type)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
        'TESTDT', 'Test District', 'TEST');

INSERT INTO villages (id, district_id, lgd_code, name, data_type)
VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002',
        'TESTVL', 'Test Village', 'TEST');

INSERT INTO crops (id, code, canonical_name, data_type)
VALUES ('00000000-0000-0000-0000-000000000004', 'TEST_CROP', 'Test Crop', 'TEST');

INSERT INTO users (id, full_name, phone_e164)
VALUES ('00000000-0000-0000-0000-000000000005', 'Test Farmer One',   '+919000000001'),
       ('00000000-0000-0000-0000-000000000006', 'Test Farmer Two',   '+919000000002'),
       ('00000000-0000-0000-0000-00000000000c', 'Test Farmer Three', '+919000000003');

-- Three farmers, because several probes below must isolate one constraint at a
-- time: reusing a farmer would trip the farmer-overlap or duplicate-booking rule
-- and mask the constraint actually under test.
INSERT INTO farmers (id, user_id, district_id, village_id)
VALUES ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000005',
        '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'),
       ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000006',
        '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003'),
       ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000c',
        '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');

INSERT INTO procurement_centres (id, code, name, state_id, district_id, data_type)
VALUES ('00000000-0000-0000-0000-000000000009', 'TESTC1', 'Test Centre 1',
        '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'TEST'),
       ('00000000-0000-0000-0000-00000000000a', 'TESTC2', 'Test Centre 2',
        '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'TEST');

INSERT INTO centre_service_lanes (centre_id, lane_no) VALUES
    ('00000000-0000-0000-0000-000000000009', 1),
    ('00000000-0000-0000-0000-000000000009', 2),
    ('00000000-0000-0000-0000-00000000000a', 1);

-- B1. Quantity rule: the two valid boundaries are accepted.
DO $$
DECLARE ok boolean := true; msg text := '2500 and 5000 both accepted';
BEGIN
    BEGIN
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000001', '00000000-0000-0000-0000-000000000007',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                1, 2500, DATE '2026-03-12',
                TIMESTAMPTZ '2026-03-12 08:00:00+05:30', TIMESTAMPTZ '2026-03-12 09:00:00+05:30',
                60, 60, 1);

        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000002', '00000000-0000-0000-0000-000000000008',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                1, 5000, DATE '2026-03-12',
                TIMESTAMPTZ '2026-03-12 09:00:00+05:30', TIMESTAMPTZ '2026-03-12 11:00:00+05:30',
                120, 120, 2);
    EXCEPTION WHEN others THEN
        ok := false; msg := 'rejected a valid quantity: ' || SQLERRM;
    END;
    PERFORM pg_temp.note_result('B1 quantity 2500 and 5000 accepted', ok, msg);
END $$;

-- B2. Quantity rule: 2499 and 5001 are rejected by the database.
DO $$
DECLARE low_rejected boolean := false; high_rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000003', '00000000-0000-0000-0000-000000000007',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                2, 2499, DATE '2026-03-13',
                TIMESTAMPTZ '2026-03-13 08:00:00+05:30', TIMESTAMPTZ '2026-03-13 09:00:00+05:30',
                60, 60, 3);
    EXCEPTION WHEN check_violation THEN low_rejected := true;
    END;

    BEGIN
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000004', '00000000-0000-0000-0000-000000000007',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                2, 5001, DATE '2026-03-14',
                TIMESTAMPTZ '2026-03-14 08:00:00+05:30', TIMESTAMPTZ '2026-03-14 09:00:00+05:30',
                60, 60, 4);
    EXCEPTION WHEN check_violation THEN high_rejected := true;
    END;

    PERFORM pg_temp.note_result('B2 quantity 2499 and 5001 rejected', low_rejected AND high_rejected,
        format('2499 rejected=%s, 5001 rejected=%s', low_rejected, high_rejected));
END $$;

-- B3. Overbooking: an overlapping booking on the same lane is refused,
--     while a back-to-back booking on the same lane is allowed.
DO $$
DECLARE overlap_rejected boolean := false; adjacent_ok boolean := true;
BEGIN
    BEGIN
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000005', '00000000-0000-0000-0000-00000000000d',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                1, 2500, DATE '2026-03-12',
                TIMESTAMPTZ '2026-03-12 08:30:00+05:30', TIMESTAMPTZ '2026-03-12 09:30:00+05:30',
                60, 60, 5);
    EXCEPTION WHEN exclusion_violation THEN overlap_rejected := true;
    END;

    BEGIN
        -- 11:00 starts exactly where booking 2 ended; '[)' makes this legal.
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000006', '00000000-0000-0000-0000-00000000000d',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                1, 2500, DATE '2026-03-12',
                TIMESTAMPTZ '2026-03-12 11:00:00+05:30', TIMESTAMPTZ '2026-03-12 12:00:00+05:30',
                60, 60, 6);
    EXCEPTION WHEN others THEN adjacent_ok := false;
    END;

    PERFORM pg_temp.note_result('B3 lane overlap refused, back-to-back allowed',
        overlap_rejected AND adjacent_ok,
        format('overlap rejected=%s, adjacent accepted=%s', overlap_rejected, adjacent_ok));
END $$;

-- B4. A farmer cannot be in two places at once, even at different centres.
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000007', '00000000-0000-0000-0000-000000000007',
                '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                1, 2500, DATE '2026-03-12',
                TIMESTAMPTZ '2026-03-12 08:15:00+05:30', TIMESTAMPTZ '2026-03-12 09:15:00+05:30',
                60, 60, 1);
    EXCEPTION WHEN exclusion_violation THEN rejected := true;
    END;

    PERFORM pg_temp.note_result('B4 farmer time-conflict across centres refused', rejected,
        'farmer 1 already occupies 08:00-09:00 at centre 1');
END $$;

-- B5. Illegal state transitions are refused; legal ones are allowed.
DO $$
DECLARE illegal_rejected boolean := false; legal_ok boolean := true;
BEGIN
    UPDATE bookings SET status = 'ARRIVED' WHERE booking_code = 'FQ-2026-0000001';

    BEGIN
        UPDATE bookings SET status = 'COMPLETED' WHERE booking_code = 'FQ-2026-0000001';
        -- CONFIRMED -> ARRIVED -> COMPLETED skips the lifecycle and must fail.
    EXCEPTION WHEN check_violation THEN illegal_rejected := true;
    END;

    BEGIN
        UPDATE bookings SET status = 'WEIGHING' WHERE booking_code = 'FQ-2026-0000001';
    EXCEPTION WHEN others THEN legal_ok := false;
    END;

    PERFORM pg_temp.note_result('B5 state machine enforced by trigger',
        illegal_rejected AND legal_ok,
        format('ARRIVED->COMPLETED rejected=%s, ARRIVED->WEIGHING accepted=%s', illegal_rejected, legal_ok));
END $$;

-- B6. OFFICIAL data without a source is impossible.
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO states (lgd_code, name, data_type)
        VALUES ('BADOFF', 'Unsourced Official', 'OFFICIAL');
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;

    PERFORM pg_temp.note_result('B6 OFFICIAL without source_id refused', rejected, NULL);
END $$;

-- B7. Data scope cannot be laundered: a STATE-scoped capacity cannot be
--     attached to a facility, and a FACILITY-scoped one cannot float free.
DO $$
DECLARE state_to_facility_rejected boolean := false; facility_without_target_rejected boolean := false;
BEGIN
    INSERT INTO storage_facilities (id, name, facility_type, state_id, district_id, data_type)
    VALUES ('00000000-0000-0000-0000-0000000000b1', 'Test Facility', 'WAREHOUSE',
            '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'TEST');

    BEGIN
        INSERT INTO storage_capacity (data_scope, facility_id, capacity_kg, effective_from,
                                      data_type, configured_by_user_id)
        VALUES ('STATE', '00000000-0000-0000-0000-0000000000b1', 1, DATE '2026-01-01',
                'CONFIGURED', '00000000-0000-0000-0000-000000000005');
    EXCEPTION WHEN check_violation THEN state_to_facility_rejected := true;
    END;

    BEGIN
        INSERT INTO storage_capacity (data_scope, capacity_kg, effective_from,
                                      data_type, configured_by_user_id)
        VALUES ('FACILITY', 1, DATE '2026-01-01', 'CONFIGURED',
                '00000000-0000-0000-0000-000000000005');
    EXCEPTION WHEN check_violation THEN facility_without_target_rejected := true;
    END;

    PERFORM pg_temp.note_result('B7 data scope cannot be re-labelled',
        state_to_facility_rejected AND facility_without_target_rejected,
        format('STATE->facility rejected=%s, FACILITY without facility rejected=%s',
               state_to_facility_rejected, facility_without_target_rejected));
END $$;

-- B8. Procurement arithmetic.
DO $$
DECLARE rejected boolean := false;
BEGIN
    INSERT INTO procurements (booking_id, centre_id)
    SELECT id, centre_id FROM bookings WHERE booking_code = 'FQ-2026-0000002';

    BEGIN
        UPDATE procurements
        SET gross_quantity_kg = 5000.000,
            accepted_quantity_kg = 4000.000,
            rejected_quantity_kg = 1500.000
        WHERE booking_id = (SELECT id FROM bookings WHERE booking_code = 'FQ-2026-0000002');
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;

    PERFORM pg_temp.note_result('B8 accepted + rejected > gross refused', rejected,
        '4000 + 1500 > 5000');
END $$;

-- B9. Payment integrity: a blocked payment may not assert an amount, and a
--     computed amount must equal base - deductions.
--
--     The TEST rate below is a 1-paise sentinel, deliberately not a plausible
--     figure. It exists only so that payments_unblocked_requires_amount is
--     satisfied and the arithmetic constraint is the one actually under test.
--     It is TEST-classified and rolled back with everything else.
INSERT INTO msp_rates (id, crop_id, season_id, marketing_year, rate_per_quintal_paise,
                       effective_from, status, data_type, data_scope)
VALUES ('00000000-0000-0000-0000-0000000000e1',
        '00000000-0000-0000-0000-000000000004',
        (SELECT id FROM seasons WHERE code = 'RMS'),
        '2026-27', 1, DATE '2026-01-01', 'DRAFT', 'TEST', 'NATIONAL');

DO $$
DECLARE blocked_amount_rejected boolean := false; bad_arithmetic_rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO payments (procurement_id, status, blocked_reason, amount_paise)
        SELECT id, 'BLOCKED', 'NO_ACTIVE_MSP', 100000 FROM procurements LIMIT 1;
    EXCEPTION WHEN check_violation THEN blocked_amount_rejected := true;
    END;

    BEGIN
        -- 100000 - 5000 = 95000, so 99999 must be refused.
        INSERT INTO payments (procurement_id, status, base_amount_paise, deductions_paise,
                              amount_paise, msp_rate_id, rate_per_quintal_paise_snapshot)
        SELECT id, 'PENDING', 100000, 5000, 99999,
               '00000000-0000-0000-0000-0000000000e1', 1
        FROM procurements LIMIT 1;
    EXCEPTION WHEN check_violation THEN bad_arithmetic_rejected := true;
    END;

    PERFORM pg_temp.note_result('B9 payment integrity enforced',
        blocked_amount_rejected AND bad_arithmetic_rejected,
        format('blocked-with-amount rejected=%s, bad arithmetic rejected=%s',
               blocked_amount_rejected, bad_arithmetic_rejected));
END $$;

-- B10. Notification deduplication is a database constraint.
DO $$
DECLARE rejected boolean := false;
BEGIN
    INSERT INTO notifications (user_id, event_key, channel, locale, dedupe_key, rendered_body, to_phone_e164)
    VALUES ('00000000-0000-0000-0000-000000000005', 'ONE_DAY_REMINDER', 'SMS', 'en',
            'verify:dedupe:1', 'body', '+919000000001');

    BEGIN
        INSERT INTO notifications (user_id, event_key, channel, locale, dedupe_key, rendered_body, to_phone_e164)
        VALUES ('00000000-0000-0000-0000-000000000005', 'ONE_DAY_REMINDER', 'SMS', 'en',
                'verify:dedupe:1', 'body', '+919000000001');
    EXCEPTION WHEN unique_violation THEN rejected := true;
    END;

    PERFORM pg_temp.note_result('B10 duplicate notification refused by unique dedupe_key', rejected,
        'a scheduler running twice cannot double-send');
END $$;

-- B11. Audit log is append-only.
DO $$
DECLARE upd_rejected boolean := false; del_rejected boolean := false; trunc_rejected boolean := false;
BEGIN
    INSERT INTO audit_logs (action, entity_type, actor_role)
    VALUES ('verify.probe', 'verification', 'SYSTEM');

    BEGIN
        UPDATE audit_logs SET action = 'tampered' WHERE action = 'verify.probe';
    EXCEPTION WHEN insufficient_privilege THEN upd_rejected := true;
    END;

    BEGIN
        DELETE FROM audit_logs WHERE action = 'verify.probe';
    EXCEPTION WHEN insufficient_privilege THEN del_rejected := true;
    END;

    BEGIN
        TRUNCATE audit_logs;
    EXCEPTION WHEN insufficient_privilege THEN trunc_rejected := true;
    END;

    PERFORM pg_temp.note_result('B11 audit_logs is append-only',
        upd_rejected AND del_rejected AND trunc_rejected,
        format('update=%s delete=%s truncate=%s', upd_rejected, del_rejected, trunc_rejected));
END $$;

-- B12. Duplicate active booking for the same farmer, centre, crop and date.
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO bookings (booking_code, farmer_id, centre_id, crop_id, season_id, marketing_year,
                              lane_no, requested_quantity_kg, service_date,
                              scheduled_start_at, scheduled_end_at,
                              estimated_processing_minutes, occupancy_minutes, token_number)
        VALUES ('FQ-2026-0000008', '00000000-0000-0000-0000-00000000000d',
                '00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000004',
                (SELECT id FROM seasons WHERE code = 'RMS'), '2026-27',
                2, 2500, DATE '2026-03-12',
                TIMESTAMPTZ '2026-03-12 15:00:00+05:30', TIMESTAMPTZ '2026-03-12 16:00:00+05:30',
                60, 60, 8);
    EXCEPTION WHEN unique_violation THEN rejected := true;
    END;

    PERFORM pg_temp.note_result('B12 duplicate active booking (same farmer/centre/crop/date) refused',
        rejected, 'different dates, centres and crops remain bookable');
END $$;


-- =============================================================================
-- SUMMARY
-- =============================================================================
SELECT
    CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result,
    check_name,
    detail
FROM _verify_results
ORDER BY seq;

DO $$
DECLARE failed int;
BEGIN
    SELECT count(*) INTO failed FROM _verify_results WHERE NOT passed;
    IF failed > 0 THEN
        RAISE EXCEPTION 'Schema verification FAILED: % check(s) did not pass', failed;
    END IF;
    RAISE NOTICE 'Schema verification PASSED: % checks', (SELECT count(*) FROM _verify_results);
END $$;

-- Nothing this file inserted is kept.
ROLLBACK;
