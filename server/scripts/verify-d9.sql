-- =============================================================================
-- FarmQueue — D-9 verification suite
--
-- Run AFTER migrations 0001-0013 and import 0001 (OFFICIAL MSP).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/verify-d9.sql
--
-- Probes that insert do so inside the transaction; the file ends with ROLLBACK.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _d9 (seq serial, name text, passed boolean, detail text) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp.d9(p_name text, p_passed boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN INSERT INTO _d9 (name, passed, detail) VALUES (p_name, p_passed, p_detail); END;
$fn$;


-- D9-1  No rate carries an effective period, because neither source publishes one.
DO $$
DECLARE total int; with_from int; with_to int;
BEGIN
    SELECT count(*) INTO total     FROM msp_rates;
    SELECT count(*) INTO with_from FROM msp_rates WHERE effective_from IS NOT NULL;
    SELECT count(*) INTO with_to   FROM msp_rates WHERE effective_to   IS NOT NULL;
    PERFORM pg_temp.d9('D9-1 effective_from is NULL where the source publishes no period',
        total = 23 AND with_from = 0 AND with_to = 0,
        format('%s rates, %s with effective_from, %s with effective_to', total, with_from, with_to));
END $$;

-- D9-2  No Cabinet approval date leaked into an effective period, and the
--       approval dates are still preserved as provenance.
DO $$
DECLARE leaked int; preserved int;
BEGIN
    SELECT count(*) INTO leaked
    FROM msp_rates m JOIN data_sources s ON s.id = m.source_id
    WHERE m.effective_from IS NOT NULL AND m.effective_from = s.reference_date;

    SELECT count(*) INTO preserved
    FROM data_sources
    WHERE reference_date IN (DATE '2025-10-01', DATE '2026-05-13');

    PERFORM pg_temp.d9('D9-2 approval dates are provenance only, and still present',
        leaked = 0 AND preserved = 2,
        format('rates using approval date as effective_from=%s; data_sources holding approval dates=%s',
               leaked, preserved));
END $$;

-- D9-3  Identity uniqueness: a duplicate ACTIVE rate for the same
--       crop+season+marketing_year+grade is refused (graded case).
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year, variety_or_grade,
            rate_per_quintal_paise, status, data_type, data_scope,
            source_id, source_reference, retrieved_at, import_batch_id)
        SELECT c.id, s.id, '2026-27', 'Common', 999900, 'ACTIVE', 'OFFICIAL', 'NATIONAL',
               '11111111-0000-4000-a000-000000000002', 'probe', now(),
               '22222222-0000-4000-a000-000000000002'
        FROM crops c, seasons s WHERE c.code = 'PADDY' AND s.code = 'KMS';
    EXCEPTION WHEN unique_violation THEN rejected := true;
    END;
    PERFORM pg_temp.d9('D9-3 duplicate graded rate refused', rejected,
        'Paddy / KMS / 2026-27 / Common already exists');
END $$;

-- D9-4  Identity uniqueness holds for the NULL-grade case too. Without the
--       COALESCE in the index, two NULL grades would never collide.
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year, variety_or_grade,
            rate_per_quintal_paise, status, data_type, data_scope,
            source_id, source_reference, retrieved_at, import_batch_id)
        SELECT c.id, s.id, '2026-27', NULL, 999900, 'ACTIVE', 'OFFICIAL', 'NATIONAL',
               '11111111-0000-4000-a000-000000000001', 'probe', now(),
               '22222222-0000-4000-a000-000000000001'
        FROM crops c, seasons s WHERE c.code = 'WHEAT' AND s.code = 'RMS';
    EXCEPTION WHEN unique_violation THEN rejected := true;
    END;
    PERFORM pg_temp.d9('D9-4 duplicate NULL-grade rate refused (COALESCE closes the gap)',
        rejected, 'Wheat / RMS / 2026-27 / no grade already exists');
END $$;

-- D9-5  A genuinely different grade is still accepted — identity, not a blanket lock.
DO $$
DECLARE accepted boolean := false;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year, variety_or_grade,
            rate_per_quintal_paise, status, data_type, data_scope,
            source_id, source_reference, retrieved_at, import_batch_id)
        SELECT c.id, s.id, '2026-27', 'Probe Grade', 100, 'ACTIVE', 'OFFICIAL', 'NATIONAL',
               '11111111-0000-4000-a000-000000000002', 'probe', now(),
               '22222222-0000-4000-a000-000000000002'
        FROM crops c, seasons s WHERE c.code = 'PADDY' AND s.code = 'KMS';
        accepted := true;
        RAISE EXCEPTION SQLSTATE '99999';   -- sentinel: undo this probe's row
    EXCEPTION
        WHEN SQLSTATE '99999' THEN NULL;    -- insert worked and has been undone
        WHEN others THEN accepted := false;
    END;
    PERFORM pg_temp.d9('D9-5 a distinct grade is still accepted', accepted,
        'probe row rolled back so later counts stay clean');
END $$;

-- D9-6  A different marketing year is a different identity and is accepted.
DO $$
DECLARE accepted boolean := false;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year, variety_or_grade,
            rate_per_quintal_paise, status, data_type, data_scope,
            source_id, source_reference, retrieved_at, import_batch_id)
        SELECT c.id, s.id, '2027-28', NULL, 100, 'ACTIVE', 'OFFICIAL', 'NATIONAL',
               '11111111-0000-4000-a000-000000000001', 'probe', now(),
               '22222222-0000-4000-a000-000000000001'
        FROM crops c, seasons s WHERE c.code = 'WHEAT' AND s.code = 'RMS';
        accepted := true;
        RAISE EXCEPTION SQLSTATE '99999';
    EXCEPTION
        WHEN SQLSTATE '99999' THEN NULL;
        WHEN others THEN accepted := false;
    END;
    PERFORM pg_temp.d9('D9-6 a different marketing year is a distinct identity', accepted,
        'probe row rolled back so later counts stay clean');
END $$;

-- D9-7  THE AMBIGUITY CASE, in real government data.
--       Paddy KMS 2026-27 is published as two graded rates with no ungraded
--       fallback. A grade-less lookup therefore CANNOT resolve to one row, and
--       the resolver must raise MSP_AMBIGUOUS rather than pick arbitrarily.
DO $$
DECLARE candidates int; fallback int;
BEGIN
    SELECT count(*) INTO candidates
    FROM msp_rates m JOIN crops c ON c.id = m.crop_id JOIN seasons s ON s.id = m.season_id
    WHERE c.code = 'PADDY' AND s.code = 'KMS' AND m.marketing_year = '2026-27'
      AND m.status = 'ACTIVE';

    SELECT count(*) INTO fallback
    FROM msp_rates m JOIN crops c ON c.id = m.crop_id JOIN seasons s ON s.id = m.season_id
    WHERE c.code = 'PADDY' AND s.code = 'KMS' AND m.marketing_year = '2026-27'
      AND m.status = 'ACTIVE' AND m.variety_or_grade IS NULL;

    PERFORM pg_temp.d9('D9-7 grade-less lookup is genuinely ambiguous, not silently resolvable',
        candidates = 2 AND fallback = 0,
        format('Paddy KMS 2026-27: %s graded candidates, %s ungraded fallback -> resolver must return MSP_AMBIGUOUS',
               candidates, fallback));
END $$;

-- D9-8  The unambiguous case still resolves to exactly one row.
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n
    FROM msp_rates m JOIN crops c ON c.id = m.crop_id JOIN seasons s ON s.id = m.season_id
    WHERE c.code = 'WHEAT' AND s.code = 'RMS' AND m.marketing_year = '2026-27'
      AND m.status = 'ACTIVE';
    PERFORM pg_temp.d9('D9-8 identity resolves to exactly one rate for an ungraded crop', n = 1,
        format('Wheat RMS 2026-27 -> %s row', n));
END $$;

-- D9-9  Provenance was not weakened: OFFICIAL still needs source, reference,
--       retrieval date and an import batch.
DO $$
DECLARE rejected boolean := false; intact int;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year,
            rate_per_quintal_paise, status, data_type, data_scope)
        SELECT c.id, s.id, '2099-00', 100, 'DRAFT', 'OFFICIAL', 'NATIONAL'
        FROM crops c, seasons s WHERE c.code = 'BARLEY' AND s.code = 'RMS';
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;

    SELECT count(*) INTO intact FROM msp_rates
    WHERE data_type = 'OFFICIAL' AND source_id IS NOT NULL
      AND source_reference IS NOT NULL AND retrieved_at IS NOT NULL
      AND import_batch_id IS NOT NULL;

    PERFORM pg_temp.d9('D9-9 provenance still mandatory and intact on all 23 rows',
        rejected AND intact = 23,
        format('unsourced OFFICIAL refused=%s, fully provenanced rows=%s', rejected, intact));
END $$;

-- D9-10  effective_to cannot exist without effective_from.
DO $$
DECLARE rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year, variety_or_grade,
            rate_per_quintal_paise, effective_from, effective_to, status,
            data_type, data_scope, source_id, source_reference, retrieved_at, import_batch_id)
        SELECT c.id, s.id, '2028-29', NULL, 100, NULL, DATE '2029-01-01', 'ACTIVE',
               'OFFICIAL', 'NATIONAL', '11111111-0000-4000-a000-000000000001',
               'probe', now(), '22222222-0000-4000-a000-000000000001'
        FROM crops c, seasons s WHERE c.code = 'GRAM' AND s.code = 'RMS';
    EXCEPTION WHEN check_violation THEN rejected := true;
    END;
    PERFORM pg_temp.d9('D9-10 dangling effective_to refused', rejected, NULL);
END $$;

-- D9-11  A source that DOES publish a period can still record one.
DO $$
DECLARE accepted boolean := false;
BEGIN
    BEGIN
        INSERT INTO msp_rates (crop_id, season_id, marketing_year, variety_or_grade,
            rate_per_quintal_paise, effective_from, effective_to, status,
            data_type, data_scope, source_id, source_reference, retrieved_at, import_batch_id)
        SELECT c.id, s.id, '2030-31', NULL, 100, DATE '2030-04-01', DATE '2031-04-01', 'ACTIVE',
               'OFFICIAL', 'NATIONAL', '11111111-0000-4000-a000-000000000001',
               'probe', now(), '22222222-0000-4000-a000-000000000001'
        FROM crops c, seasons s WHERE c.code = 'BARLEY' AND s.code = 'RMS';
        accepted := true;
        RAISE EXCEPTION SQLSTATE '99999';
    EXCEPTION
        WHEN SQLSTATE '99999' THEN NULL;
        WHEN others THEN accepted := false;
    END;
    PERFORM pg_temp.d9('D9-11 an explicitly published effective period is still storable',
        accepted, 'the column is optional metadata, not removed; probe row rolled back');
END $$;

-- D9-12  Rate values were not altered by the correction.
DO $$
DECLARE wheat int; paddy_common int; paddy_a int; cotton_long int;
BEGIN
    SELECT m.rate_per_quintal_paise INTO wheat FROM msp_rates m
      JOIN crops c ON c.id = m.crop_id JOIN seasons s ON s.id = m.season_id
      WHERE c.code='WHEAT' AND s.code='RMS' AND m.marketing_year='2026-27';
    SELECT m.rate_per_quintal_paise INTO paddy_common FROM msp_rates m
      JOIN crops c ON c.id = m.crop_id WHERE c.code='PADDY' AND m.variety_or_grade='Common';
    SELECT m.rate_per_quintal_paise INTO paddy_a FROM msp_rates m
      JOIN crops c ON c.id = m.crop_id WHERE c.code='PADDY' AND m.variety_or_grade='Grade A';
    SELECT m.rate_per_quintal_paise INTO cotton_long FROM msp_rates m
      JOIN crops c ON c.id = m.crop_id WHERE c.code='COTTON' AND m.variety_or_grade='Long Staple';

    PERFORM pg_temp.d9('D9-12 published rate values unchanged by the correction',
        wheat = 258500 AND paddy_common = 244100 AND paddy_a = 246100 AND cotton_long = 866700,
        format('wheat=%s paddy_common=%s paddy_gradeA=%s cotton_long=%s (paise/quintal)',
               wheat, paddy_common, paddy_a, cotton_long));
END $$;


SELECT CASE WHEN passed THEN 'PASS' ELSE 'FAIL' END AS result, name, detail
FROM _d9 ORDER BY seq;

DO $$
DECLARE failed int;
BEGIN
    SELECT count(*) INTO failed FROM _d9 WHERE NOT passed;
    IF failed > 0 THEN
        RAISE EXCEPTION 'D-9 verification FAILED: % check(s) did not pass', failed;
    END IF;
    RAISE NOTICE 'D-9 verification PASSED: % checks', (SELECT count(*) FROM _d9);
END $$;

ROLLBACK;
