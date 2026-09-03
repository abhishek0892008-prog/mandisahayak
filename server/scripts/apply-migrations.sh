#!/usr/bin/env bash
#
# FarmQueue — apply migrations with psql.
#
# Requires only the PostgreSQL client (psql). There is no npm dependency.
# Each migration file wraps itself in BEGIN/COMMIT and records itself in
# schema_migrations, so this script only has to decide what to skip.
#
#   DATABASE_URL=postgres://user:pass@host:5432/farmqueue \
#     bash server/scripts/apply-migrations.sh
#
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is not set." >&2
    echo "Example: DATABASE_URL=postgres://farmqueue_app:secret@localhost:5432/farmqueue" >&2
    exit 1
fi

MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../migrations" && pwd)"

command -v psql >/dev/null 2>&1 || {
    echo "psql not found on PATH." >&2
    exit 1
}

echo "Server version: $(psql "$DATABASE_URL" -tAc 'SHOW server_version')"
echo "Migrations:     $MIGRATIONS_DIR"
echo

applied_versions="$(
    psql "$DATABASE_URL" -tAc \
        "SELECT version FROM schema_migrations ORDER BY version" 2>/dev/null || true
)"

for file in "$MIGRATIONS_DIR"/*.sql; do
    base="$(basename "$file")"
    version="${base%%_*}"

    if printf '%s\n' "$applied_versions" | grep -qx "$version"; then
        echo "skip   $base (already applied)"
        continue
    fi

    echo "apply  $base"
    # No --single-transaction: each file opens its own transaction, and nesting
    # would make psql emit "there is already a transaction in progress".
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$file"
done

echo
echo "Applied migrations:"
psql "$DATABASE_URL" -c \
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version"
