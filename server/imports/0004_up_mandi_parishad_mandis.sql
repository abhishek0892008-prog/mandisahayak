-- =============================================================================
-- FarmQueue — OFFICIAL mandi import
--   Rajya Krishi Utpadan Mandi Parishad, Uttar Pradesh — agricultural markets
--   in the five demonstration districts. 17 markets.
--
-- THIS IS NOT A MIGRATION. It is a data import, run after the schema exists.
--
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
--   Phase 4 recorded: "No mandi rows. mandis.code is NOT NULL and no
--   authoritative machine-readable list of UP mandi codes was retrievable, so
--   creating one would mean inventing government identifiers."
--
--   The first half of that is now out of date. The Mandi Parishad publishes its
--   market list as static HTML, and it was read directly. The second half still
--   holds: the publication carries NO market code, so none is stored. Migration
--   0016 makes that recordable instead of forcing an invented value.
--
--   THE PROCUREMENT CENTRES REMAIN CONFIGURED. A mandi is an agricultural
--   market; a procurement centre is where MSP procurement happens. They are
--   different entities, 0003 says so in its own table comment, and this source
--   publishes only the former. Linking a centre to a real mandi does NOT make
--   the centre official, and nothing below sets data_type on a centre.
--
-- PROVENANCE
--   Source     Rajya Krishi Utpadan Mandi Parishad, Uttar Pradesh
--   URL        https://www.upmandiparishad.upsdc.gov.in/MandiDetails.aspx
--   Type       PORTAL
--   Scope      FACILITY — the page names individual markets, which is the
--              granularity a mandi row requires. Nothing here is derived from a
--              state- or district-level aggregate.
--   Retrieved  2026-09-03
--
--   Every name and grade below is reproduced EXACTLY as published. Nothing is
--   translated, title-cased, expanded, abbreviated or corrected. "Kosikalan" is
--   published as one word and is stored as one word.
--
-- WHAT IS DELIBERATELY NOT IMPORTED
--   * Secretary names and C.U.G. mobile numbers. The listing publishes both for
--     every market. They are personal data of identifiable officials, they are
--     irrelevant to booking a slot, and there is no column for them. Collecting
--     them because they happened to be on the page would be exactly the habit
--     this system's data rules exist to prevent.
--   * The serial number. It is a row position in a sorted table, not an
--     identity (migration 0016).
--   * Latitude and longitude. Not published here; plausible coordinates are
--     still invented ones.
--   * Bulandshahr. The listing contains no market in that district, so no row
--     is created for it and its centre keeps mandi_id NULL. An absence in the
--     source is recorded as an absence, never filled in.
--
-- VERIFICATION STATUS
--   retrieved_at is set. last_verified_at is deliberately left NULL: this is a
--   single official source, read once, and NOT cross-checked against a second
--   publication. Do not present these as verified until that check is recorded.
--   This matches how the MSP import (0001) treats the same question.
--
-- REQUIRED PARAMETER
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -v configured_by=<uuid-of-an-admin-user> \
--        -f server/imports/0004_up_mandi_parishad_mandis.sql
-- =============================================================================

BEGIN;

-- Resolve the accountable administrator outside any dollar-quoted block, since
-- psql does not substitute :variables inside $$ ... $$.
CREATE TEMP TABLE _mandi_ctx ON COMMIT DROP AS
SELECT NULLIF(:'configured_by', '')::uuid AS admin_id;

DO $$
DECLARE
    v_admin  uuid;
    v_source uuid;
    v_linked int;
BEGIN
    SELECT admin_id INTO v_admin FROM _mandi_ctx;

    IF v_admin IS NULL THEN
        RAISE EXCEPTION
            'configured_by is required: no government data enters this system '
            'without a named administrator accepting responsibility for it.';
    END IF;

    -- -------------------------------------------------------------------------
    -- The provenance row. Created before any data references it.
    -- -------------------------------------------------------------------------
    INSERT INTO data_sources (
        source_name, publisher, source_url, source_type, dataset_name,
        data_scope, reference_date, retrieved_at, retrieved_by_user_id,
        last_verified_at, status, notes
    )
    VALUES (
        'Mandi Details listing',
        'Rajya Krishi Utpadan Mandi Parishad, Uttar Pradesh',
        'https://www.upmandiparishad.upsdc.gov.in/MandiDetails.aspx',
        'PORTAL',
        'Mandi Details (region, district, market, grade)',
        'FACILITY',
        NULL,                 -- the page states no publication or revision date
        now(),
        v_admin,
        NULL,                 -- single-sourced; not independently cross-checked
        'ACTIVE',
        'Read as static HTML. The listing carries 251 markets state-wide; only '
        'those in the five demonstration districts are imported. Secretary '
        'names and mobile numbers on the same page are deliberately not stored.'
    )
    RETURNING id INTO v_source;

    -- -------------------------------------------------------------------------
    -- The markets. Name and grade exactly as published; code stays NULL because
    -- the publication states none.
    -- -------------------------------------------------------------------------
    INSERT INTO mandis (district_id, code, name, grade, data_type, source_id)
    SELECT d.district_id, NULL, d.name, d.grade, 'OFFICIAL', v_source
    FROM (VALUES
        ('44444444-0000-4000-a000-000000000011'::uuid, 'Aligarh',        'A+'),
        ('44444444-0000-4000-a000-000000000011'::uuid, 'Khair',          'A'),
        ('44444444-0000-4000-a000-000000000011'::uuid, 'Chharra',        'B'),
        ('44444444-0000-4000-a000-000000000011'::uuid, 'Atrauli',        'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Agra',           'A+'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Fatehabad',      'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Achhnera',       'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Khairagarh',     'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Jagner',         'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Fatehpur Sikri', 'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Jarar',          'C'),
        ('44444444-0000-4000-a000-000000000012'::uuid, 'Shamshabad',     'C'),
        ('44444444-0000-4000-a000-000000000013'::uuid, 'Hathras',        'A'),
        ('44444444-0000-4000-a000-000000000013'::uuid, 'Sadabad',        'B'),
        ('44444444-0000-4000-a000-000000000013'::uuid, 'Sikandra Rao',   'C'),
        ('44444444-0000-4000-a000-000000000014'::uuid, 'Mathura',        'A'),
        ('44444444-0000-4000-a000-000000000014'::uuid, 'Kosikalan',      'B')
    ) AS d(district_id, name, grade)
    WHERE NOT EXISTS (
        SELECT 1 FROM mandis m
        WHERE m.district_id = d.district_id AND m.name = d.name
    );

    -- -------------------------------------------------------------------------
    -- Seat each demonstration centre in the principal market of its district.
    --
    -- "Principal" means the highest published grade, tie-broken by the market
    -- whose name matches the district — which is how the Mandi Parishad names
    -- the main yard. This is a CONFIGURATION choice about where our
    -- demonstration centre sits, not a claim from the source, and it changes
    -- no centre's data_type.
    -- -------------------------------------------------------------------------
    WITH ranked AS (
        SELECT
            m.id,
            m.district_id,
            row_number() OVER (
                PARTITION BY m.district_id
                ORDER BY
                    CASE m.grade WHEN 'A+' THEN 1 WHEN 'A' THEN 2
                                 WHEN 'B'  THEN 3 ELSE 4 END,
                    (m.name <> (SELECT name FROM districts WHERE id = m.district_id)),
                    m.name
            ) AS rank
        FROM mandis m
        WHERE m.source_id = v_source
    )
    UPDATE procurement_centres c
       SET mandi_id = r.id,
           updated_at = now()
      FROM ranked r
     WHERE r.district_id = c.district_id
       AND r.rank = 1
       AND c.mandi_id IS NULL;

    GET DIAGNOSTICS v_linked = ROW_COUNT;

    RAISE NOTICE 'mandis: % OFFICIAL markets imported, % centre(s) seated. '
                 'Centres remain CONFIGURED.',
                 (SELECT count(*) FROM mandis WHERE source_id = v_source),
                 v_linked;
END $$;

-- -----------------------------------------------------------------------------
-- Guards. These fail the import rather than let a false claim commit.
-- -----------------------------------------------------------------------------

-- No centre may have been promoted to OFFICIAL by this file.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM procurement_centres WHERE data_type <> 'CONFIGURED') THEN
        RAISE EXCEPTION 'A procurement centre is no longer CONFIGURED. This import must never promote one.';
    END IF;
END $$;

-- Every OFFICIAL mandi must point at a source, and must carry no invented code.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM mandis WHERE data_type = 'OFFICIAL' AND source_id IS NULL) THEN
        RAISE EXCEPTION 'An OFFICIAL mandi has no source.';
    END IF;

    IF EXISTS (SELECT 1 FROM mandis WHERE code IS NOT NULL) THEN
        RAISE EXCEPTION 'A mandi carries a code. This source publishes none, so none may be stored.';
    END IF;
END $$;

COMMIT;
