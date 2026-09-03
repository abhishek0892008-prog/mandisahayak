-- =============================================================================
-- FarmQueue — Phase 4: Uttar Pradesh demonstration geography and centres
--
-- CLASSIFICATION SUMMARY — read this before citing anything below.
--
--   OFFICIAL   : exactly one row — the state of Uttar Pradesh, carrying LGD
--                state code 9, read directly from the official Local Government
--                Directory portal on 2026-09-02.
--
--   CONFIGURED : the five demonstration districts, the five demonstration
--                procurement centres, their lanes, working hours, crop
--                eligibility and slot parameters. These exist so the SIH
--                demonstration has something to book against. They are NOT
--                government records.
--
--   TEST       : nothing in this file.
--
-- WHAT IS DELIBERATELY ABSENT
--   * No mandi rows. mandis.code is NOT NULL and no authoritative machine-
--     readable list of UP mandi codes was retrievable, so creating one would
--     mean inventing government identifiers. procurement_centres.mandi_id is
--     nullable by design, so centres simply have no mandi linked.
--   * No storage facilities, no storage capacity, no storage inventory.
--     Official storage capacity is published at national and state level only
--     (Phase 3, decision D-10). Nothing is converted down to centre level, so
--     every centre reports NO_CAPACITY_DATA_FOR_CENTRE under ADVISORY mode.
--   * No latitude or longitude. Real coordinates for these centres were not
--     verified, and plausible-looking coordinates are still invented data.
--   * No district LGD codes. The LGD bulk download is CAPTCHA-protected and the
--     data.gov.in API requires a registered key; neither was circumvented.
--     Migration 0012 makes lgd_code NULL-able for non-OFFICIAL rows precisely so
--     this absence can be recorded honestly instead of papered over.
--
-- CENTRE IDENTIFIERS ARE NOT GOVERNMENT IDS
--   Centre codes use the form DEMO-UP-<DISTRICT>-01. The DEMO- prefix is
--   deliberate: no reader, and no future importer, should mistake these for
--   official procurement centre identifiers.
--
-- PROBLEM STATEMENT
--   PS 26032 specifies no state, district, mandi or centre. This geography is a
--   demonstration choice recorded in docs/phase-4-report.md, not a requirement
--   of the problem statement.
--
-- REQUIRED PARAMETER
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -v configured_by=<uuid-of-an-admin-user> \
--        -f server/imports/0002_up_demonstration_geography.sql
-- =============================================================================

BEGIN;

-- Resolve the configuring administrator outside any dollar-quoted block, since
-- psql does not substitute :variables inside $$ ... $$.
CREATE TEMP TABLE _cfg_ctx ON COMMIT DROP AS
SELECT NULLIF(:'configured_by', '')::uuid AS admin_id;

DO $$
DECLARE admin_id uuid;
BEGIN
    SELECT c.admin_id INTO admin_id FROM _cfg_ctx c;
    IF admin_id IS NULL THEN
        RAISE EXCEPTION
            'configured_by must be supplied: psql -v configured_by=<uuid> ...';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = admin_id AND r.code = 'ADMIN'
    ) THEN
        RAISE EXCEPTION
            'user % is not an ADMIN; configuring centres requires the ADMIN role', admin_id;
    END IF;
END
$$;


-- -----------------------------------------------------------------------------
-- OFFICIAL source: the Local Government Directory.
-- -----------------------------------------------------------------------------
INSERT INTO data_sources (
    id, source_name, publisher, source_url, source_type, dataset_name,
    document_reference, data_scope, reference_date, retrieved_at,
    retrieved_by_user_id, notes
)
SELECT
    '11111111-0000-4000-a000-000000000003',
    'Local Government Directory (LGD)',
    'Ministry of Panchayati Raj, Government of India',
    'https://lgdirectory.gov.in/downloadDirectory.do',
    'PORTAL',
    'LGD state directory',
    'State selector on the LGD "Download Directory" page; the option for Uttar Pradesh carries value 9. Retrieved 2026-09-02.',
    'NATIONAL',
    DATE '2026-09-02',
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    (SELECT admin_id FROM _cfg_ctx),
    'Only the STATE code was obtainable. District-level codes require solving a CAPTCHA (bulk download) or a registered API key (data.gov.in); neither was circumvented, so district LGD codes are recorded as unavailable.'
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- OFFICIAL: Uttar Pradesh, LGD state code 9.
-- -----------------------------------------------------------------------------
INSERT INTO states (id, lgd_code, name, data_type, source_id)
VALUES (
    '44444444-0000-4000-a000-000000000001',
    '9',
    'Uttar Pradesh',
    'OFFICIAL',
    '11111111-0000-4000-a000-000000000003'
)
ON CONFLICT (lgd_code) DO NOTHING;


-- -----------------------------------------------------------------------------
-- CONFIGURED: five demonstration districts.
-- lgd_code is NULL because no LGD code was obtainable — not because one was
-- withheld. Permitted for non-OFFICIAL rows by migration 0012.
-- -----------------------------------------------------------------------------
INSERT INTO districts (id, state_id, lgd_code, name, data_type, source_id)
VALUES
    ('44444444-0000-4000-a000-000000000011', '44444444-0000-4000-a000-000000000001', NULL, 'Aligarh',      'CONFIGURED', NULL),
    ('44444444-0000-4000-a000-000000000012', '44444444-0000-4000-a000-000000000001', NULL, 'Agra',         'CONFIGURED', NULL),
    ('44444444-0000-4000-a000-000000000013', '44444444-0000-4000-a000-000000000001', NULL, 'Hathras',      'CONFIGURED', NULL),
    ('44444444-0000-4000-a000-000000000014', '44444444-0000-4000-a000-000000000001', NULL, 'Mathura',      'CONFIGURED', NULL),
    ('44444444-0000-4000-a000-000000000015', '44444444-0000-4000-a000-000000000001', NULL, 'Bulandshahr',  'CONFIGURED', NULL)
ON CONFLICT DO NOTHING;


-- -----------------------------------------------------------------------------
-- CONFIGURED: five demonstration procurement centres, one per district.
-- No mandi_id, no coordinates, no government identifier.
-- storage_check_mode is left at the ADVISORY default (decision D-8 / D-10).
-- -----------------------------------------------------------------------------
INSERT INTO procurement_centres (
    id, code, name, state_id, district_id, mandi_id,
    latitude, longitude, timezone, status, storage_check_mode, data_type, source_id
)
VALUES
    ('55555555-0000-4000-a000-000000000001', 'DEMO-UP-ALIGARH-01',     'Aligarh Demonstration Procurement Centre',     '44444444-0000-4000-a000-000000000001', '44444444-0000-4000-a000-000000000011', NULL, NULL, NULL, 'Asia/Kolkata', 'ACTIVE', 'ADVISORY', 'CONFIGURED', NULL),
    ('55555555-0000-4000-a000-000000000002', 'DEMO-UP-AGRA-01',        'Agra Demonstration Procurement Centre',        '44444444-0000-4000-a000-000000000001', '44444444-0000-4000-a000-000000000012', NULL, NULL, NULL, 'Asia/Kolkata', 'ACTIVE', 'ADVISORY', 'CONFIGURED', NULL),
    ('55555555-0000-4000-a000-000000000003', 'DEMO-UP-HATHRAS-01',     'Hathras Demonstration Procurement Centre',     '44444444-0000-4000-a000-000000000001', '44444444-0000-4000-a000-000000000013', NULL, NULL, NULL, 'Asia/Kolkata', 'ACTIVE', 'ADVISORY', 'CONFIGURED', NULL),
    ('55555555-0000-4000-a000-000000000004', 'DEMO-UP-MATHURA-01',     'Mathura Demonstration Procurement Centre',     '44444444-0000-4000-a000-000000000001', '44444444-0000-4000-a000-000000000014', NULL, NULL, NULL, 'Asia/Kolkata', 'ACTIVE', 'ADVISORY', 'CONFIGURED', NULL),
    ('55555555-0000-4000-a000-000000000005', 'DEMO-UP-BULANDSHAHR-01', 'Bulandshahr Demonstration Procurement Centre', '44444444-0000-4000-a000-000000000001', '44444444-0000-4000-a000-000000000015', NULL, NULL, NULL, 'Asia/Kolkata', 'ACTIVE', 'ADVISORY', 'CONFIGURED', NULL)
ON CONFLICT (code) DO NOTHING;


-- -----------------------------------------------------------------------------
-- CONFIGURED: service lanes. Counts deliberately differ per centre to prove the
-- architecture supports heterogeneous centres rather than one hardcoded shape.
-- -----------------------------------------------------------------------------
INSERT INTO centre_service_lanes (centre_id, lane_no, name, is_active)
VALUES
    ('55555555-0000-4000-a000-000000000001', 1, 'Lane 1', true),
    ('55555555-0000-4000-a000-000000000001', 2, 'Lane 2', true),
    ('55555555-0000-4000-a000-000000000001', 3, 'Lane 3', true),
    ('55555555-0000-4000-a000-000000000002', 1, 'Lane 1', true),
    ('55555555-0000-4000-a000-000000000002', 2, 'Lane 2', true),
    ('55555555-0000-4000-a000-000000000003', 1, 'Lane 1', true),
    ('55555555-0000-4000-a000-000000000004', 1, 'Lane 1', true),
    ('55555555-0000-4000-a000-000000000004', 2, 'Lane 2', true),
    ('55555555-0000-4000-a000-000000000005', 1, 'Lane 1', true)
ON CONFLICT (centre_id, lane_no) DO NOTHING;


-- -----------------------------------------------------------------------------
-- CONFIGURED: working hours, Monday-Saturday. Sunday (day_of_week 0) is simply
-- absent, which is how the scheduling engine will read "closed".
-- Hathras runs shorter hours, again to prove per-centre configurability.
-- -----------------------------------------------------------------------------
INSERT INTO centre_operating_hours (
    centre_id, day_of_week, opens_at, closes_at, effective_from, effective_to,
    data_type, configured_by_user_id, configuration_note
)
SELECT
    c.centre_id, d.dow,
    CASE WHEN c.centre_id = '55555555-0000-4000-a000-000000000003' THEN TIME '09:00' ELSE TIME '08:00' END,
    CASE WHEN c.centre_id = '55555555-0000-4000-a000-000000000003' THEN TIME '17:00' ELSE TIME '18:00' END,
    DATE '2026-09-01', NULL,
    'CONFIGURED',
    (SELECT admin_id FROM _cfg_ctx),
    'Demonstration working hours for SIH. Not published by any government source.'
FROM (VALUES
    ('55555555-0000-4000-a000-000000000001'::uuid),
    ('55555555-0000-4000-a000-000000000002'::uuid),
    ('55555555-0000-4000-a000-000000000003'::uuid),
    ('55555555-0000-4000-a000-000000000004'::uuid),
    ('55555555-0000-4000-a000-000000000005'::uuid)
) AS c(centre_id)
CROSS JOIN (VALUES (1),(2),(3),(4),(5),(6)) AS d(dow);


-- -----------------------------------------------------------------------------
-- CONFIGURED: slot / processing-time parameters.
-- These are the operational figures implied by the project brief (25 quintal is
-- about an hour, 50 quintal about two). They are OPERATIONAL CONFIGURATION, not
-- government policy, and the scheduling engine reads them from here rather than
-- holding any constant of its own.
-- Aligarh is given a slower reference rate so that two centres demonstrably
-- produce different schedules for the same quantity.
-- -----------------------------------------------------------------------------
INSERT INTO centre_slot_configurations (
    centre_id, reference_quantity_kg, reference_processing_minutes,
    minimum_processing_minutes, maximum_processing_minutes,
    transition_buffer_minutes, slot_granularity_minutes,
    booking_horizon_days, cancellation_cutoff_hours, max_daily_processing_kg,
    effective_from, effective_to, data_type, configured_by_user_id, configuration_note
)
SELECT
    v.centre_id, 2500, v.ref_minutes, 30, 180, 15, 15, 7, 24, NULL,
    DATE '2026-09-01', NULL, 'CONFIGURED',
    (SELECT admin_id FROM _cfg_ctx),
    'Demonstration scheduling parameters. 2500 kg reference = 25 quintal. max_daily_processing_kg is NULL, meaning no configured daily ceiling rather than zero.'
FROM (VALUES
    ('55555555-0000-4000-a000-000000000001'::uuid, 75),
    ('55555555-0000-4000-a000-000000000002'::uuid, 60),
    ('55555555-0000-4000-a000-000000000003'::uuid, 60),
    ('55555555-0000-4000-a000-000000000004'::uuid, 60),
    ('55555555-0000-4000-a000-000000000005'::uuid, 60)
) AS v(centre_id, ref_minutes);


-- -----------------------------------------------------------------------------
-- CONFIGURED: which crops each centre accepts.
-- Crops and seasons come from the OFFICIAL Phase 3 MSP import; only the
-- centre-to-crop assignment is configured.
-- effective_from is the demonstration configuration date, NOT a claim about when
-- a marketing season begins — no source publishes those boundaries.
-- -----------------------------------------------------------------------------
INSERT INTO centre_crop_configurations (
    centre_id, crop_id, season_id, marketing_year, is_active,
    effective_from, effective_to, data_type, configured_by_user_id, configuration_note
)
SELECT
    v.centre_id, cr.id, se.id, '2026-27', true,
    DATE '2026-09-01', NULL, 'CONFIGURED',
    (SELECT admin_id FROM _cfg_ctx),
    'Demonstration crop eligibility. effective_from is the configuration date, not a season boundary.'
FROM (VALUES
    ('55555555-0000-4000-a000-000000000001'::uuid, 'WHEAT', 'RMS'),
    ('55555555-0000-4000-a000-000000000002'::uuid, 'WHEAT', 'RMS'),
    ('55555555-0000-4000-a000-000000000003'::uuid, 'WHEAT', 'RMS'),
    ('55555555-0000-4000-a000-000000000004'::uuid, 'WHEAT', 'RMS'),
    ('55555555-0000-4000-a000-000000000005'::uuid, 'WHEAT', 'RMS'),
    ('55555555-0000-4000-a000-000000000001'::uuid, 'PADDY', 'KMS'),
    ('55555555-0000-4000-a000-000000000004'::uuid, 'PADDY', 'KMS')
) AS v(centre_id, crop_code, season_code)
JOIN crops cr   ON cr.code = v.crop_code
JOIN seasons se ON se.code = v.season_code;


UPDATE reference_versions SET version = version + 1, updated_at = now()
WHERE resource IN ('states', 'districts', 'procurement_centres');

COMMIT;
