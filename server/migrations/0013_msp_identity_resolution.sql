-- =============================================================================
-- FarmQueue — 0013_msp_identity_resolution   (Decision D-9)
--
-- PROBLEM
--   0007 declared msp_rates.effective_from NOT NULL and enforced uniqueness with
--   a date-range exclusion constraint. Neither Cabinet release publishes an
--   effective period, so the import had to write *something* into that column
--   and used the Cabinet approval date. That silently converts a provenance
--   fact ("when the rate was decided") into a policy claim the source never made
--   ("when the rate applies").
--
-- DECISION D-9
--   The authoritative identity of an MSP rate is
--       crop + season + marketing_year + grade
--   The publication date is provenance metadata, not effective_from.
--
-- WHAT THIS MIGRATION DOES
--   1. Permits NULL effective_from, for sources that publish no period.
--   2. Prevents a dangling effective_to with no effective_from.
--   3. Replaces the date-range exclusion constraint with a partial unique index
--      expressing the D-9 identity directly.
--   4. Clears approval dates that were written into effective_from, and ONLY
--      those — matched precisely against the source's own reference_date.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It does not alter a single rate value.
--   * It does not create or delete any MSP record.
--   * It does not touch source_id, source_reference, retrieved_at, verified_at
--     or import_batch_id. Provenance is untouched and remains mandatory.
--   * It does not add a new date column: the Cabinet approval date is already
--     preserved in data_sources.reference_date, which exists for exactly this
--     purpose, so duplicating it here would be redundant.
--   * It does not rewrite or remove any earlier migration.
--
-- FORWARD-ONLY. On a clean database steps 1-3 apply to an empty table and step 4
-- is a no-op; on a database that already ran the Phase 3 import, step 4 performs
-- the correction.
-- =============================================================================

BEGIN;

-- 1. The source may legitimately publish no effective period.
ALTER TABLE msp_rates
    ALTER COLUMN effective_from DROP NOT NULL;

-- 2. An end date without a start date would be meaningless.
--    (The pre-existing msp_rates_effective_range CHECK evaluates to NULL, and so
--    passes, when effective_from IS NULL — this closes that gap.)
ALTER TABLE msp_rates
    ADD CONSTRAINT msp_rates_effective_to_requires_from
    CHECK (effective_to IS NULL OR effective_from IS NOT NULL);

-- 3. Identity uniqueness replaces date-range overlap.
--    The old constraint cannot express identity once the dates are NULL: two
--    rows with NULL ranges would never overlap and would both be permitted.
ALTER TABLE msp_rates
    DROP CONSTRAINT msp_rates_no_active_overlap;

--    COALESCE is retained for the reason Phase 3 probe C1 demonstrated: two NULL
--    grades would otherwise never collide, leaving exactly the duplicate this
--    index exists to prevent.
CREATE UNIQUE INDEX msp_rates_one_active_per_identity
    ON msp_rates (crop_id, season_id, marketing_year, COALESCE(variety_or_grade, ''))
    WHERE status = 'ACTIVE';

COMMENT ON COLUMN msp_rates.effective_from IS
    'Effective period start, ONLY when the source publishes one explicitly. '
    'NULL means the publication stated no effective period — it does not mean '
    'unknown. Never populate this with a Cabinet approval or publication date '
    '(D-9); that belongs in data_sources.reference_date.';

COMMENT ON INDEX msp_rates_one_active_per_identity IS
    'D-9 identity: at most one ACTIVE rate per crop, season, marketing year and '
    'grade. Replaces the former date-range exclusion constraint.';

-- 4. Data correction, precisely targeted.
--    Only rows whose effective_from exactly equals their own source''s published
--    reference_date are corrected — that is the signature of an approval date
--    having been written into the effective-period column. A rate carrying a
--    genuinely published effective period would not match and is left alone.
UPDATE msp_rates m
SET    effective_from = NULL,
       effective_to   = NULL
FROM   data_sources s
WHERE  m.source_id = s.id
  AND  m.effective_from IS NOT NULL
  AND  m.effective_from = s.reference_date
  AND  m.effective_to IS NULL;

-- Report what was corrected, and assert the outcome.
DO $$
DECLARE remaining int;
BEGIN
    SELECT count(*) INTO remaining
    FROM msp_rates m JOIN data_sources s ON s.id = m.source_id
    WHERE m.effective_from IS NOT NULL AND m.effective_from = s.reference_date;

    IF remaining > 0 THEN
        RAISE EXCEPTION
            'D-9 correction incomplete: % rate(s) still carry their source''s reference_date as effective_from',
            remaining;
    END IF;

    RAISE NOTICE 'D-9: msp_rates identity is now crop+season+marketing_year+grade; % rate(s) present.',
        (SELECT count(*) FROM msp_rates);
END
$$;

INSERT INTO schema_migrations (version, name) VALUES ('0013', 'msp_identity_resolution');

COMMIT;
