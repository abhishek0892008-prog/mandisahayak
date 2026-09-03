#!/usr/bin/env bash
#
# FarmQueue — provision a database from zero to bookable.
#
# Runs the whole documented sequence in one step: migrations, the bootstrap
# administrator, then both imports under that administrator's accountability.
#
#   DATABASE_URL=postgres://user@host:5432/farmqueue \
#     bash server/scripts/provision-database.sh
#
# Add --recreate to drop and recreate the database first. That is what the test
# database wants: the integration suite books real windows against real lanes,
# so a database carrying bookings from an earlier run reports NO_AVAILABILITY
# rather than a scheduling defect.
#
#   TEST_DATABASE_URL=postgres://fqverify@127.0.0.1:55432/farmqueue_test \
#     bash server/scripts/provision-database.sh --recreate
#
# Verification scripts are NOT run here; run them separately (see README).
set -euo pipefail

RECREATE=0
for arg in "$@"; do
    case "$arg" in
        --recreate) RECREATE=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

DB_URL="${DATABASE_URL:-${TEST_DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
    echo "Set DATABASE_URL (or TEST_DATABASE_URL)." >&2
    exit 1
fi

command -v psql >/dev/null 2>&1 || { echo "psql not found on PATH." >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMPORTS="$HERE/../imports"

# The bootstrap admin's id is a constant, defined in seed-bootstrap-admin.sql.
ADMIN_ID='33333333-0000-4000-a000-000000000001'

if [ "$RECREATE" = "1" ]; then
    # Split the database name off the URL and reconnect to the maintenance
    # database, since you cannot drop the database you are connected to.
    DB_NAME="${DB_URL##*/}"
    DB_NAME="${DB_NAME%%\?*}"
    ADMIN_URL="${DB_URL%/*}/postgres"

    echo "recreate  $DB_NAME"
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
        -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" \
        -c "CREATE DATABASE \"$DB_NAME\""
fi

echo "migrate"
DATABASE_URL="$DB_URL" bash "$HERE/apply-migrations.sh"

echo
echo "seed      bootstrap administrator"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$HERE/seed-bootstrap-admin.sql"

echo "import    0001 MSP (OFFICIAL)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q \
    -v activating_admin="$ADMIN_ID" \
    -f "$IMPORTS/0001_msp_rms_2026_27_kms_2026_27.sql"

echo "import    0002 UP demonstration geography (CONFIGURED)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q \
    -v configured_by="$ADMIN_ID" \
    -f "$IMPORTS/0002_up_demonstration_geography.sql"

echo "import    0003 notification templates (CONFIGURED)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q \
    -v configured_by="$ADMIN_ID" \
    -f "$IMPORTS/0003_notification_templates.sql"

echo
psql "$DB_URL" -tA -v ON_ERROR_STOP=1 -c "
    SELECT format(
        'ready: %s migrations, %s crops, %s MSP rates, %s centres, %s bookings',
        (SELECT count(*) FROM schema_migrations),
        (SELECT count(*) FROM crops),
        (SELECT count(*) FROM msp_rates),
        (SELECT count(*) FROM procurement_centres),
        (SELECT count(*) FROM bookings))"
