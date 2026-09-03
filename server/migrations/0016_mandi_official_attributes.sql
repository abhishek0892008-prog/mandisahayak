-- =============================================================================
-- FarmQueue — 0016_mandi_official_attributes
--
-- WHY THIS MIGRATION EXISTS
--   Phase 4 recorded that no authoritative machine-readable list of UP mandis
--   was retrievable, so the mandis table was left empty and every procurement
--   centre has mandi_id NULL. That is no longer true: the Rajya Krishi Utpadan
--   Mandi Parishad, Uttar Pradesh publishes its market list as static HTML at
--   upmandiparishad.upsdc.gov.in/MandiDetails.aspx — 251 markets, each with a
--   region, a district and an official market grade.
--
--   Two things in the current schema stop that list being imported honestly.
--
-- 1. code IS NOT NULL, BUT THE PUBLICATION STATES NO CODE
--   0003 declared mandis.code NOT NULL on the assumption that mandis would
--   arrive from a Local Government Directory import carrying market codes. The
--   Mandi Parishad listing publishes serial number, region, district, market
--   name and grade — and no identifier. A serial number is a position in a
--   sorted table, not an identity; it changes when the table is re-sorted.
--
--   The old schema forced a value to exist, and the only ways to satisfy it
--   were to invent a government identifier or to promote a row position into
--   one. Both are forbidden (Phase 1, P-4).
--
--   THIS IS NOT A WEAKENING. It mirrors 0012 exactly, which dropped the same
--   NOT NULL from districts.lgd_code for the same reason. A NULL code here
--   means "the publishing source states no code", not "the code is unknown".
--   Uniqueness is unaffected: mandis_code_unique_per_district still rejects two
--   identical non-null codes in a district, and PostgreSQL treats NULLs as
--   distinct, which is the correct behaviour for an attribute that is absent
--   rather than duplicated.
--
--   Unlike districts, no conditional CHECK is added requiring OFFICIAL rows to
--   carry a code. For a district, an LGD code IS the thing that makes it
--   official. For a mandi there is no such implication: this OFFICIAL source
--   publishes none, and a rule asserting otherwise would be false.
--
-- 2. GRADE IS PUBLISHED AND HAS NOWHERE TO GO
--   The Mandi Parishad assigns each market a grade (A+, A, B, C). It is an
--   officially published attribute of the market, so it is stored as one. The
--   CHECK lists exactly the four values the source uses; a grade outside them
--   would mean the publication changed and should fail loudly rather than be
--   absorbed.
--
-- WHAT THIS MIGRATION DOES NOT DO
--   * It imports no data. The rows arrive in server/imports/0004, under a
--     data_sources row, like every other provenanced import.
--   * It does not touch procurement_centres. A mandi is not a procurement
--     centre — 0003 says so in its own table comment — and nothing here makes
--     one imply the other.
--   * It invents no code, no coordinate and no capacity.
--
-- FORWARD-ONLY.
-- =============================================================================

BEGIN;

ALTER TABLE mandis
    ALTER COLUMN code DROP NOT NULL;

COMMENT ON COLUMN mandis.code IS
    'Market identifier as published by the source. NULL means the publication '
    'states no code — not that the code is unknown. A serial number in a '
    'listing is a row position, not an identity, and is never stored here.';

ALTER TABLE mandis
    ADD COLUMN grade text;

ALTER TABLE mandis
    ADD CONSTRAINT mandis_grade_allowed
        CHECK (grade IS NULL OR grade IN ('A+', 'A', 'B', 'C'));

COMMENT ON COLUMN mandis.grade IS
    'Market grade as assigned by the publishing authority (A+, A, B, C). NULL '
    'where the source publishes none. Reproduced exactly as published; never '
    'derived from size, turnover or any other attribute.';

INSERT INTO schema_migrations (version, name) VALUES ('0016', 'mandi_official_attributes');

COMMIT;
