# FarmQueue - apply migrations with psql (Windows PowerShell).
#
# Requires only the PostgreSQL client (psql). There is no npm dependency.
# Each migration file wraps itself in BEGIN/COMMIT and records itself in
# schema_migrations, so this script only has to decide what to skip.
#
#   $env:DATABASE_URL = "postgres://user:pass@localhost:5432/farmqueue"
#   powershell -File server\scripts\apply-migrations.ps1

$ErrorActionPreference = "Stop"

if (-not $env:DATABASE_URL) {
    Write-Error "DATABASE_URL is not set. Example: postgres://farmqueue_app:secret@localhost:5432/farmqueue"
    exit 1
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Error "psql not found on PATH."
    exit 1
}

$migrationsDir = Join-Path (Split-Path -Parent $PSScriptRoot) "migrations"

$serverVersion = & psql $env:DATABASE_URL -tAc "SHOW server_version"
Write-Output "Server version: $serverVersion"
Write-Output "Migrations:     $migrationsDir"
Write-Output ""

# The ledger does not exist before 0001 runs; treat any failure as "none applied".
$applied = @()
try {
    $applied = & psql $env:DATABASE_URL -tAc "SELECT version FROM schema_migrations ORDER BY version"
    if ($null -eq $applied) { $applied = @() }
} catch {
    $applied = @()
}
$applied = $applied | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }

Get-ChildItem -Path $migrationsDir -Filter "*.sql" | Sort-Object Name | ForEach-Object {
    $base    = $_.Name
    $version = $base.Split("_")[0]

    if ($applied -contains $version) {
        Write-Output "skip   $base (already applied)"
        return
    }

    Write-Output "apply  $base"
    # No --single-transaction: each file opens its own transaction.
    & psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -q -f $_.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Migration $base failed with exit code $LASTEXITCODE. Nothing from that file was committed."
        exit $LASTEXITCODE
    }
}

Write-Output ""
Write-Output "Applied migrations:"
& psql $env:DATABASE_URL -c "SELECT version, name, applied_at FROM schema_migrations ORDER BY version"
