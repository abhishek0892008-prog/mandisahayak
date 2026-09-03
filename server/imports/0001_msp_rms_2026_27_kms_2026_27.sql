-- =============================================================================
-- FarmQueue — OFFICIAL MSP import
--   Rabi Marketing Season 2026-27  (6 crops,  6 rate rows)
--   Kharif Marketing Season 2026-27 (14 crops, 17 rate rows)
--
-- THIS IS NOT A MIGRATION. It is a data import, run after the schema exists.
--
-- PROVENANCE
--   Every rate below was read from the Government of India press release named
--   in the data_sources row it references. No value has been rounded, adjusted,
--   interpolated or inferred. Rates are reproduced exactly as published, in
--   rupees per quintal, and stored as integer paise (published value x 100).
--
-- SEASON HANDLING
--   Season is taken from the publication itself — the Rabi release supplies RMS
--   rows and the Kharif release supplies KMS rows. No crop's season is inferred.
--
-- GRADE HANDLING
--   Where the source publishes a single rate for a crop, variety_or_grade is
--   NULL. Where it publishes rates per variety (Paddy Common / Grade A, Jowar
--   Hybrid / Maldandi, Cotton Medium / Long Staple), each is a separate row
--   carrying the variety exactly as the source names it.
--
-- EFFECTIVE PERIOD — D-9 COMPLIANT (migration 0013)
--   Neither release states an effective_from / effective_to date, so this import
--   sets NEITHER. NULL here means "the publication stated no effective period",
--   not "unknown". The Cabinet approval date is preserved where it belongs, in
--   data_sources.reference_date (2025-10-01 for RMS, 2026-05-13 for KMS), and is
--   never presented as a policy effective date.
--
--   The authoritative identity of each rate is
--       crop + season + marketing_year + grade
--   enforced by the partial unique index msp_rates_one_active_per_identity.
--
-- VERIFICATION STATUS
--   retrieved_at is set. verified_at is deliberately left NULL on every row:
--   the values were read from the official release but have NOT yet been
--   independently cross-checked against a second official publication.
--   Do not present these as verified until that second check is recorded.
--
-- REQUIRED PARAMETER
--   An MSP batch may only be ACTIVATED by an accountable administrator: the
--   constraint msp_import_batches_activation_consistent refuses an ACTIVATED
--   batch whose activated_by_user_id is NULL. Supply the activating admin:
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -v activating_admin=<uuid-of-an-admin-user> \
--          -f server/imports/0001_msp_rms_2026_27_kms_2026_27.sql
--
--   psql fails with an unbound-variable error if it is omitted, which is the
--   intended outcome: no MSP rate enters the system without a named human
--   accepting responsibility for it.
-- =============================================================================

BEGIN;

-- Capture the activating administrator.
-- psql does NOT substitute :variables inside a dollar-quoted block, so the
-- parameter is resolved here, outside $$, and the guard below reads it back.
CREATE TEMP TABLE _import_ctx ON COMMIT DROP AS
SELECT NULLIF(:'activating_admin', '')::uuid AS admin_id;

-- Fail early and legibly if the administrator is missing or not an ADMIN.
DO $$
DECLARE admin_id uuid;
BEGIN
    SELECT c.admin_id INTO admin_id FROM _import_ctx c;

    IF admin_id IS NULL THEN
        RAISE EXCEPTION
            'activating_admin must be supplied: psql -v activating_admin=<uuid> ...';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = admin_id AND r.code = 'ADMIN'
    ) THEN
        RAISE EXCEPTION
            'user % is not an ADMIN; MSP activation requires the ADMIN role', admin_id;
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Sources
-- -----------------------------------------------------------------------------
INSERT INTO data_sources (
    id, source_name, publisher, source_url, source_type, dataset_name,
    document_reference, data_scope, season_id, marketing_year,
    reference_date, retrieved_at, notes
) VALUES
(
    '11111111-0000-4000-a000-000000000001',
    'Cabinet approves Minimum Support Prices (MSP) for Rabi Crops for Marketing Season 2026-27',
    'Press Information Bureau, Ministry of Agriculture & Farmers Welfare, Government of India',
    'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2173567',
    'DOCUMENT',
    'MSP for all Rabi crops, Marketing Season 2026-27',
    'PIB press release PRID 2173567, posted 01 OCT 2025 3:31PM by PIB Delhi; table "Minimum Support Prices for all Rabi crops for Marketing Season 2026-27 (Rs. per quintal)"',
    'NATIONAL',
    (SELECT id FROM seasons WHERE code = 'RMS'),
    '2026-27',
    DATE '2025-10-01',
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    'Rates reproduced exactly as published. Release states no effective date range. Not yet independently cross-checked against a second official source.'
),
(
    '11111111-0000-4000-a000-000000000002',
    'Cabinet approves Minimum Support Prices (MSP) for Kharif Crops for Marketing Season 2026-27',
    'Press Information Bureau, Ministry of Agriculture & Farmers Welfare, Government of India',
    'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2260618',
    'DOCUMENT',
    'MSP for all Kharif crops, Marketing Season 2026-27',
    'PIB press release PRID 2260618, posted 13 MAY 2026 3:25PM by PIB Delhi; MSP table for Kharif crops, Marketing Season 2026-27 (Rs. per quintal)',
    'NATIONAL',
    (SELECT id FROM seasons WHERE code = 'KMS'),
    '2026-27',
    DATE '2026-05-13',
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    'Rates reproduced exactly as published, including per-variety rates for Paddy, Jowar and Cotton. Release states no effective date range. Not yet independently cross-checked.'
)
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- Crops.
-- The crop LIST is taken from the two official releases, so each crop carries
-- the source it was named in. The `code` is an internal identifier, not a
-- government value. canonical_name reproduces the source's own crop name.
-- -----------------------------------------------------------------------------
INSERT INTO crops (code, canonical_name, data_type, source_id) VALUES
    ('WHEAT',              'Wheat',              'OFFICIAL', '11111111-0000-4000-a000-000000000001'),
    ('BARLEY',             'Barley',             'OFFICIAL', '11111111-0000-4000-a000-000000000001'),
    ('GRAM',               'Gram',               'OFFICIAL', '11111111-0000-4000-a000-000000000001'),
    ('LENTIL_MASUR',       'Lentil (Masur)',     'OFFICIAL', '11111111-0000-4000-a000-000000000001'),
    ('RAPESEED_MUSTARD',   'Rapeseed & Mustard', 'OFFICIAL', '11111111-0000-4000-a000-000000000001'),
    ('SAFFLOWER',          'Safflower',          'OFFICIAL', '11111111-0000-4000-a000-000000000001'),
    ('PADDY',              'Paddy',              'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('JOWAR',              'Jowar',              'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('BAJRA',              'Bajra',              'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('RAGI',               'Ragi',               'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('MAIZE',              'Maize',              'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('TUR_ARHAR',          'Tur (Arhar)',        'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('MOONG',              'Moong',              'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('URAD',               'Urad',               'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('GROUNDNUT',          'Groundnut',          'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('SUNFLOWER_SEED',     'Sunflower Seed',     'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('SOYBEAN_YELLOW',     'Soybean (Yellow)',   'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('SESAMUM',            'Sesamum',            'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('NIGERSEED',          'Nigerseed',          'OFFICIAL', '11111111-0000-4000-a000-000000000002'),
    ('COTTON',             'Cotton',             'OFFICIAL', '11111111-0000-4000-a000-000000000002')
ON CONFLICT (code) DO NOTHING;


-- -----------------------------------------------------------------------------
-- Import batches. msp_rates_official_requires_import_batch means an OFFICIAL
-- rate cannot exist without one, so a hand-inserted rate is impossible.
-- -----------------------------------------------------------------------------
INSERT INTO msp_import_batches (
    id, source_id, file_name, status, row_count, valid_row_count,
    failed_row_count, activated_at, activated_by_user_id, notes
) VALUES
(
    '22222222-0000-4000-a000-000000000001',
    '11111111-0000-4000-a000-000000000001',
    'PIB PRID 2173567 (Rabi MSP RMS 2026-27)',
    'ACTIVATED', 6, 6, 0,
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    (SELECT admin_id FROM _import_ctx),
    'Transcribed from the published HTML table by the named activating administrator.'
),
(
    '22222222-0000-4000-a000-000000000002',
    '11111111-0000-4000-a000-000000000002',
    'PIB PRID 2260618 (Kharif MSP KMS 2026-27)',
    'ACTIVATED', 17, 17, 0,
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    (SELECT admin_id FROM _import_ctx),
    'Transcribed from the published HTML table, including per-variety rows.'
)
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- RABI — RMS 2026-27. Source table columns used: "Crops", "MSP RMS 2026-27".
-- Rs/quintal as published, stored as paise.
-- -----------------------------------------------------------------------------
INSERT INTO msp_rates (
    crop_id, season_id, marketing_year, variety_or_grade,
    rate_per_quintal_paise, status,
    data_type, data_scope, source_id, source_reference, retrieved_at,
    verified_at, import_batch_id
)
SELECT
    c.id,
    (SELECT id FROM seasons WHERE code = 'RMS'),
    '2026-27',
    NULL,                                  -- source publishes one rate per crop
    v.rupees_per_quintal * 100,
    'ACTIVE',
    'OFFICIAL',
    'NATIONAL',
    '11111111-0000-4000-a000-000000000001',
    'PIB PRID 2173567, table "Minimum Support Prices for all Rabi crops for Marketing Season 2026-27", column "MSP RMS 2026-27"',
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    NULL,                                  -- not independently cross-checked
    '22222222-0000-4000-a000-000000000001'
FROM (VALUES
    ('WHEAT',            2585),
    ('BARLEY',           2150),
    ('GRAM',             5875),
    ('LENTIL_MASUR',     7000),
    ('RAPESEED_MUSTARD', 6200),
    ('SAFFLOWER',        6540)
) AS v(crop_code, rupees_per_quintal)
JOIN crops c ON c.code = v.crop_code;


-- -----------------------------------------------------------------------------
-- KHARIF — KMS 2026-27. Source table column used: "MSP 2026-27".
-- Paddy, Jowar and Cotton are published per variety and are stored as separate
-- rows carrying the variety name exactly as the source gives it.
-- -----------------------------------------------------------------------------
INSERT INTO msp_rates (
    crop_id, season_id, marketing_year, variety_or_grade,
    rate_per_quintal_paise, status,
    data_type, data_scope, source_id, source_reference, retrieved_at,
    verified_at, import_batch_id
)
SELECT
    c.id,
    (SELECT id FROM seasons WHERE code = 'KMS'),
    '2026-27',
    v.variety,
    v.rupees_per_quintal * 100,
    'ACTIVE',
    'OFFICIAL',
    'NATIONAL',
    '11111111-0000-4000-a000-000000000002',
    'PIB PRID 2260618, MSP table for Kharif crops Marketing Season 2026-27, column "MSP 2026-27"',
    TIMESTAMPTZ '2026-09-02 00:00:00+05:30',
    NULL,
    '22222222-0000-4000-a000-000000000002'
FROM (VALUES
    ('PADDY',          'Common',          2441),
    ('PADDY',          'Grade A',         2461),
    ('JOWAR',          'Hybrid',          4023),
    ('JOWAR',          'Maldandi',        4073),
    ('BAJRA',          NULL,              2900),
    ('RAGI',           NULL,              5205),
    ('MAIZE',          NULL,              2410),
    ('TUR_ARHAR',      NULL,              8450),
    ('MOONG',          NULL,              8780),
    ('URAD',           NULL,              8200),
    ('GROUNDNUT',      NULL,              7517),
    ('SUNFLOWER_SEED', NULL,              8343),
    ('SOYBEAN_YELLOW', NULL,              5708),
    ('SESAMUM',        NULL,             10346),
    ('NIGERSEED',      NULL,             10052),
    ('COTTON',         'Medium Staple',   8267),
    ('COTTON',         'Long Staple',     8667)
) AS v(crop_code, variety, rupees_per_quintal)
JOIN crops c ON c.code = v.crop_code;


-- Bump the reference version so clients know the crop/MSP master changed.
UPDATE reference_versions SET version = version + 1, updated_at = now()
WHERE resource IN ('crops', 'seasons');

COMMIT;
