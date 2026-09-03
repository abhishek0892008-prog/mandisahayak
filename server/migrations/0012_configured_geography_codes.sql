-- =============================================================================
-- FarmQueue — 0012_configured_geography_codes
--
-- WHY THIS MIGRATION EXISTS
--   0003 declared districts.lgd_code NOT NULL, on the assumption that every
--   district would arrive from a Local Government Directory import. Phase 4
--   established that LGD district codes are not machine-retrievable: the bulk
--   download is CAPTCHA-protected and the data.gov.in API requires a registered
--   key. Neither control will be circumvented.
--
--   That leaves a modelling gap. A CONFIGURED demonstration district has no LGD
--   code — not "an unknown one", but none at all, because it was never an LGD
--   entity. The old schema forced a value to exist, and the only ways to satisfy
--   it were to invent a government identifier or to relax integrity. Both are
--   forbidden.
--
-- THIS IS NOT A WEAKENING.
--   For OFFICIAL rows the requirement is unchanged: an OFFICIAL district still
--   cannot exist without an LGD code. The NOT NULL is replaced by a conditional
--   CHECK that enforces exactly the same rule where it actually applies, and
--   correctly permits NULL where the concept does not apply. This mirrors the
--   data_type <> 'OFFICIAL' OR source_id IS NOT NULL pattern already used on
--   every provenanced table.
--
--   Verified by probe P4-1: an OFFICIAL district with a NULL lgd_code is refused.
--
-- STATES ARE DELIBERATELY UNCHANGED.
--   states.lgd_code remains NOT NULL. The Uttar Pradesh LGD state code (9) was
--   read directly from the official LGD portal, so no configured state is needed.
-- =============================================================================

BEGIN;

ALTER TABLE districts
    ALTER COLUMN lgd_code DROP NOT NULL;

ALTER TABLE districts
    ADD CONSTRAINT districts_official_requires_lgd_code
    CHECK (data_type <> 'OFFICIAL' OR lgd_code IS NOT NULL);

COMMENT ON COLUMN districts.lgd_code IS
    'Local Government Directory district code. Mandatory for OFFICIAL rows '
    '(districts_official_requires_lgd_code). NULL for CONFIGURED demonstration '
    'districts, which are not LGD entities and therefore have no code.';

-- The existing UNIQUE (state_id, lgd_code) still applies. In PostgreSQL a NULL
-- never equals another NULL, so several CONFIGURED districts in one state may
-- each carry a NULL code without colliding, while two OFFICIAL districts still
-- cannot share a code.
--
-- Configured districts need their own uniqueness, on name within a state, so a
-- demonstration geography cannot accumulate duplicates.
CREATE UNIQUE INDEX districts_configured_name_unique_per_state
    ON districts (state_id, lower(btrim(name)))
    WHERE data_type <> 'OFFICIAL';

INSERT INTO schema_migrations (version, name) VALUES ('0012', 'configured_geography_codes');

COMMIT;
