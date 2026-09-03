-- =============================================================================
-- FarmQueue — Phase 4 verification suite
--
-- Run AFTER migrations 0001-0012 and imports 0001 (MSP) and 0002 (geography).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-phase4.sql
--
-- Probes that insert anything do so inside the transaction; the file ends with
-- ROLLBACK, so it never alters the database it inspects.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _p4 (seq serial, name text, passed boolean, detail text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.p4(p_name text, p_passed boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN INSERT INTO _p4 (name, passed, detail) VALUES (p_name, p_passed, p_detail); END;
$fn$;


-- P4-1  Migration 0012 did NOT weaken the OFFICIAL path.
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO districts (state_id, lgd_code, name, data_type, source_id)
        SELECT id, NULL, 'Probe Official District', 'OFFICIAL',
               '11111111-0000-4000-a000-000000000003'
        FROM states WHERE lgd_code = '9';
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;
    PERFORM pg_temp.p4('P4-1 OFFICIAL district without lgd_code still refused', rejected,
        'proves 0012 replaced NOT NULL with an equally strict conditional CHECK');
END $$;

-- P4-2  A CONFIGURED district may legitimately have no LGD code.
DO $$
DECLARE accepted boolean := true;
BEGIN
    BEGIN
        INSERT INTO districts (state_id, lgd_code, name, data_type)
        SELECT id, NULL, 'Probe Configured District', 'CONFIGURED' FROM states WHERE lgd_code = '9';
    EXCEPTION WHEN others THEN accepted := false;
    END;
    PERFORM pg_temp.p4('P4-2 CONFIGURED district with NULL lgd_code accepted', accepted, NULL);
END $$;

-- P4-3  Exactly one OFFICIAL state, sourced, carrying LGD code 9.
DO $$
DECLARE n int; code text; has_src boolean;
BEGIN
    SELECT count(*) INTO n FROM states WHERE data_type = 'OFFICIAL';
    SELECT lgd_code, source_id IS NOT NULL INTO code, has_src
    FROM states WHERE data_type = 'OFFICIAL' LIMIT 1;
    PERFORM pg_temp.p4('P4-3 Uttar Pradesh is OFFICIAL, LGD code 9, with a source',
        n = 1 AND code = '9' AND has_src, format('official states=%s code=%s sourced=%s', n, code, has_src));
END $$;

-- P4-4  No demonstration row is mislabelled OFFICIAL.
DO $$
DECLARE bad int;
BEGIN
    SELECT (SELECT count(*) FROM districts            WHERE data_type = 'OFFICIAL')
         + (SELECT count(*) FROM procurement_centres  WHERE data_type = 'OFFICIAL')
         + (SELECT count(*) FROM centre_operating_hours     WHERE data_type = 'OFFICIAL')
         + (SELECT count(*) FROM centre_slot_configurations WHERE data_type = 'OFFICIAL')
         + (SELECT count(*) FROM centre_crop_configurations WHERE data_type = 'OFFICIAL')
    INTO bad;
    PERFORM pg_temp.p4('P4-4 no demonstration geography claims OFFICIAL status', bad = 0,
        format('%s mislabelled rows', bad));
END $$;

-- P4-5  No fabricated government data: mandis and all storage tables are empty.
DO $$
DECLARE m int; f int; c int; i int;
BEGIN
    SELECT count(*) INTO m FROM mandis;
    SELECT count(*) INTO f FROM storage_facilities;
    SELECT count(*) INTO c FROM storage_capacity;
    SELECT count(*) INTO i FROM storage_inventory;
    PERFORM pg_temp.p4('P4-5 no fabricated mandi or storage data', m = 0 AND f = 0 AND c = 0 AND i = 0,
        format('mandis=%s facilities=%s capacity=%s inventory=%s', m, f, c, i));
END $$;

-- P4-6  No centre carries a government-looking identifier or invented coordinates.
DO $$
DECLARE not_demo int; with_coords int;
BEGIN
    SELECT count(*) INTO not_demo    FROM procurement_centres WHERE code NOT LIKE 'DEMO-%';
    SELECT count(*) INTO with_coords FROM procurement_centres
        WHERE latitude IS NOT NULL OR longitude IS NOT NULL;
    PERFORM pg_temp.p4('P4-6 centre codes are DEMO-prefixed and coordinates are absent',
        not_demo = 0 AND with_coords = 0,
        format('non-DEMO codes=%s, rows with coordinates=%s', not_demo, with_coords));
END $$;

-- P4-7  D-10 / D-8: every centre yields NO_CAPACITY_DATA_FOR_CENTRE under ADVISORY.
DO $$
DECLARE not_advisory int; linked int;
BEGIN
    SELECT count(*) INTO not_advisory FROM procurement_centres WHERE storage_check_mode <> 'ADVISORY';
    SELECT count(*) INTO linked FROM centre_storage_links;
    PERFORM pg_temp.p4('P4-7 all centres ADVISORY with no storage linked', not_advisory = 0 AND linked = 0,
        format('non-ADVISORY=%s, storage links=%s -> NO_CAPACITY_DATA_FOR_CENTRE', not_advisory, linked));
END $$;

-- P4-8  Centres are heterogeneous: the architecture is not one hardcoded shape.
DO $$
DECLARE lane_variants int; hour_variants int; rate_variants int;
BEGIN
    SELECT count(DISTINCT n) INTO lane_variants
      FROM (SELECT centre_id, count(*) AS n FROM centre_service_lanes GROUP BY centre_id) x;
    SELECT count(DISTINCT (opens_at, closes_at)) INTO hour_variants FROM centre_operating_hours;
    SELECT count(DISTINCT reference_processing_minutes) INTO rate_variants FROM centre_slot_configurations;
    PERFORM pg_temp.p4('P4-8 centres differ in lanes, hours and processing rate',
        lane_variants > 1 AND hour_variants > 1 AND rate_variants > 1,
        format('distinct lane counts=%s, hour patterns=%s, reference rates=%s',
               lane_variants, hour_variants, rate_variants));
END $$;

-- P4-9  Referential integrity: each centre's district really sits in its state.
DO $$
DECLARE mismatched int;
BEGIN
    SELECT count(*) INTO mismatched
    FROM procurement_centres pc JOIN districts d ON d.id = pc.district_id
    WHERE d.state_id <> pc.state_id;
    PERFORM pg_temp.p4('P4-9 centre state matches its district''s state', mismatched = 0,
        format('%s mismatches', mismatched));
END $$;

-- P4-10  Temporal configuration cannot overlap (operating hours).
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO centre_operating_hours (
            centre_id, day_of_week, opens_at, closes_at, effective_from,
            data_type, configured_by_user_id, configuration_note)
        VALUES ('55555555-0000-4000-a000-000000000001', 1, TIME '10:00', TIME '12:00',
                DATE '2026-10-01', 'CONFIGURED',
                (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                 WHERE r.code = 'ADMIN' LIMIT 1),
                'overlap probe');
    EXCEPTION WHEN exclusion_violation THEN rejected := true;
    END;
    PERFORM pg_temp.p4('P4-10 overlapping operating-hours config refused', rejected,
        'an open-ended range already covers 2026-10-01 for that centre and weekday');
END $$;

-- P4-11  Every CONFIGURED operational row names the administrator who set it.
DO $$
DECLARE anon int;
BEGIN
    SELECT (SELECT count(*) FROM centre_operating_hours     WHERE configured_by_user_id IS NULL)
         + (SELECT count(*) FROM centre_slot_configurations WHERE configured_by_user_id IS NULL)
         + (SELECT count(*) FROM centre_crop_configurations WHERE configured_by_user_id IS NULL)
    INTO anon;
    PERFORM pg_temp.p4('P4-11 configured operational rows are attributable', anon = 0,
        format('%s rows with no configuring admin', anon));
END $$;

-- P4-12  Crop eligibility points at OFFICIAL crops from the MSP import.
DO $$
DECLARE total int; official int;
BEGIN
    SELECT count(*) INTO total FROM centre_crop_configurations;
    SELECT count(*) INTO official FROM centre_crop_configurations ccc
      JOIN crops c ON c.id = ccc.crop_id WHERE c.data_type = 'OFFICIAL';
    PERFORM pg_temp.p4('P4-12 configured crop eligibility references OFFICIAL crops',
        total > 0 AND total = official, format('%s of %s reference OFFICIAL crops', official, total));
END $$;

-- P4-13  Slot parameters are sane and complete for every active centre.
DO $$
DECLARE missing int; bad int;
BEGIN
    SELECT count(*) INTO missing FROM procurement_centres pc
      WHERE pc.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM centre_slot_configurations s WHERE s.centre_id = pc.id);
    SELECT count(*) INTO bad FROM centre_slot_configurations
      WHERE reference_quantity_kg <> 2500
         OR minimum_processing_minutes > maximum_processing_minutes;
    PERFORM pg_temp.p4('P4-13 every active centre has coherent slot configuration',
        missing = 0 AND bad = 0, format('centres without config=%s, incoherent=%s', missing, bad));
END $$;

-- P4-14  Sunday is closed everywhere (absence of a row is how closure is expressed).
DO $$
DECLARE sundays int; centres int; days int;
BEGIN
    SELECT count(*) INTO sundays FROM centre_operating_hours WHERE day_of_week = 0;
    SELECT count(*) INTO centres FROM procurement_centres;
    SELECT count(*) INTO days    FROM centre_operating_hours;
    PERFORM pg_temp.p4('P4-14 Mon-Sat configured, Sunday closed', sundays = 0 AND days = centres * 6,
        format('sunday rows=%s, total day rows=%s for %s centres', sundays, days, centres));
END $$;

-- P4-15  The MSP data from Phase 3 is still intact and still OFFICIAL.
DO $$
DECLARE rates int; unsourced int; verified int;
BEGIN
    SELECT count(*) INTO rates FROM msp_rates WHERE data_type = 'OFFICIAL';
    SELECT count(*) INTO unsourced FROM msp_rates WHERE data_type = 'OFFICIAL' AND source_id IS NULL;
    SELECT count(*) INTO verified FROM msp_rates WHERE verified_at IS NOT NULL;
    PERFORM pg_temp.p4('P4-15 MSP data intact, sourced, and still not over-claimed',
        rates = 23 AND unsourced = 0 AND verified = 0,
        format('official rates=%s unsourced=%s marked-verified=%s', rates, unsourced, verified));
END $$;


SELECT CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result, name, detail
FROM _p4 ORDER BY seq;

DO $$
DECLARE failed int;
BEGIN
    SELECT count(*) INTO failed FROM _p4 WHERE NOT passed;
    IF failed > 0 THEN
        RAISE EXCEPTION 'Phase 4 verification FAILED: % check(s) did not pass', failed;
    END IF;
    RAISE NOTICE 'Phase 4 verification PASSED: % checks', (SELECT count(*) FROM _p4);
END $$;

ROLLBACK;
