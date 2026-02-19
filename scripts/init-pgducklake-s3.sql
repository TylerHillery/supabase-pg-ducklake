-- Configure DuckDB/DuckLake for Supabase integration
-- Routes all S3 calls through storage:5000/s3 (NOT direct MinIO)

-- =============================================================================
-- 1. DuckDB role permissions
-- =============================================================================
-- pg_duckdb intercepts ALL DDL (ALTER TABLE, DROP TABLE IF EXISTS, etc.) across
-- ALL schemas — even for regular PostgreSQL heap tables. Any role that runs DDL
-- (GoTrue migrations, Storage migrations, etc.) must be granted the duckdb
-- postgres_role or it will get "permission denied" errors.

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'duckdb_users') THEN
        CREATE ROLE duckdb_users NOLOGIN;
    END IF;
END $$;

-- Add all roles that need to run DDL (and thus need pg_duckdb permission).
-- WITH INHERIT TRUE overrides NOINHERIT on the grantee for this specific grant,
-- so pg_duckdb's role membership check works correctly.
GRANT duckdb_users TO authenticated WITH INHERIT TRUE;
GRANT duckdb_users TO supabase_auth_admin WITH INHERIT TRUE;
GRANT duckdb_users TO supabase_storage_admin WITH INHERIT TRUE;

ALTER SYSTEM SET duckdb.postgres_role = 'duckdb_users';
SELECT pg_reload_conf();

-- Grant access to the ducklake catalog schema.
-- pg_duckdb checks these tables when intercepting DDL (even on non-DuckDB tables).
-- Must grant directly because NOINHERIT roles don't inherit group privileges.
GRANT USAGE ON SCHEMA ducklake TO duckdb_users, supabase_auth_admin, supabase_storage_admin, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA ducklake TO duckdb_users, supabase_auth_admin, supabase_storage_admin, authenticated;

-- =============================================================================
-- 2. DuckLake extension and S3 configuration
-- =============================================================================

-- Install ducklake extension in DuckDB
SELECT duckdb.install_extension('ducklake');

-- Create S3 secret using pg_duckdb's built-in function
-- Credentials match S3_PROTOCOL_ACCESS_KEY_ID/SECRET in storage service
SELECT duckdb.create_simple_secret(
    type      := 'S3',
    key_id    := '625729a08b95bf1b7ff351a663f3a23c',
    secret    := '850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907',
    region    := 'us-east-1',
    endpoint  := 'storage:5000/s3',
    use_ssl   := 'false',
    url_style := 'path',
    scope     := 's3://ducklake/'
);

-- Set default DuckLake table path to S3 bucket via Supabase Storage
ALTER SYSTEM SET ducklake.default_table_path = 's3://ducklake/';
SELECT pg_reload_conf();

-- Update the DuckLake catalog data_path from local filesystem to S3
-- (The base image initializes it with /var/lib/postgresql/data/pg_ducklake/)
UPDATE ducklake.ducklake_metadata SET value = 's3://ducklake/' WHERE key = 'data_path';
