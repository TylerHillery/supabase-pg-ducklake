-- Supabase database initialization for custom postgres images (e.g., pgducklake)
-- Replicates the setup from supabase/postgres init-scripts:
--   00000000000000-initial-schema.sql
--   00000000000001-auth-schema.sql
--   00000000000002-storage-schema.sql
--   00000000000003-post-setup.sql
--
-- This runs after the base image's own init scripts (pg_duckdb, ducklake, etc.)

-- =============================================================================
-- 1. PASSWORDS
-- =============================================================================

\set pgpass `echo "$POSTGRES_PASSWORD"`
ALTER ROLE postgres WITH PASSWORD :'pgpass';

-- =============================================================================
-- 2. CORE ROLES
-- =============================================================================

-- Supabase super admin
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
        CREATE ROLE supabase_admin WITH LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS;
    END IF;
END $$;

-- Replication admin
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_replication_admin') THEN
        CREATE ROLE supabase_replication_admin WITH LOGIN REPLICATION;
    END IF;
END $$;

-- ETL admin
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_etl_admin') THEN
        CREATE ROLE supabase_etl_admin WITH LOGIN REPLICATION BYPASSRLS;
    END IF;
END $$;
GRANT pg_read_all_data TO supabase_etl_admin;
GRANT CREATE ON DATABASE postgres TO supabase_etl_admin;

-- Read-only user
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_read_only_user') THEN
        CREATE ROLE supabase_read_only_user WITH LOGIN BYPASSRLS;
    END IF;
END $$;
GRANT pg_read_all_data TO supabase_read_only_user;

-- API roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
END $$;

-- Grant service_role SUPERUSER and LOGIN for set_config access (needed in PostgreSQL 17+)
ALTER ROLE service_role WITH SUPERUSER LOGIN;

-- Authenticator (PostgREST connector)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator WITH LOGIN NOINHERIT;
    END IF;
END $$;

GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;
GRANT supabase_admin TO authenticator;

-- Service-specific admin roles
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin WITH NOINHERIT CREATEROLE LOGIN NOREPLICATION;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_storage_admin') THEN
        CREATE ROLE supabase_storage_admin WITH NOINHERIT CREATEROLE LOGIN NOREPLICATION;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_functions_admin') THEN
        CREATE ROLE supabase_functions_admin WITH LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pgbouncer') THEN
        CREATE ROLE pgbouncer WITH LOGIN;
    END IF;
END $$;

-- Grant service roles to authenticator
GRANT supabase_auth_admin TO authenticator;
GRANT supabase_storage_admin TO authenticator;
GRANT supabase_functions_admin TO authenticator;

-- Dashboard user (for Supabase Studio)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'dashboard_user') THEN
        CREATE ROLE dashboard_user NOSUPERUSER CREATEDB CREATEROLE REPLICATION;
    END IF;
END $$;

-- =============================================================================
-- 3. PASSWORDS
-- =============================================================================

ALTER ROLE authenticator WITH PASSWORD :'pgpass';
ALTER ROLE pgbouncer WITH PASSWORD :'pgpass';
ALTER ROLE supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER ROLE supabase_functions_admin WITH PASSWORD :'pgpass';
ALTER ROLE supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER ROLE supabase_admin WITH PASSWORD :'pgpass';

-- =============================================================================
-- 4. DATABASES
-- =============================================================================

SELECT 'CREATE DATABASE _supabase'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '_supabase')\gexec

GRANT ALL ON DATABASE postgres TO supabase_storage_admin;
GRANT ALL ON DATABASE postgres TO supabase_auth_admin;
GRANT ALL ON DATABASE postgres TO dashboard_user;
GRANT ALL ON DATABASE _supabase TO supabase_admin;

-- =============================================================================
-- 5. SCHEMAS
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_admin;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS graphql_public;

-- =============================================================================
-- 6. EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- =============================================================================
-- 7. REALTIME
-- =============================================================================

CREATE PUBLICATION supabase_realtime;

-- =============================================================================
-- 8. SCHEMA GRANTS
-- =============================================================================

-- public
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

-- extensions
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- graphql_public
GRANT USAGE ON SCHEMA graphql_public TO authenticator, anon, authenticated, service_role;

-- auth
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;

-- storage
GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA storage TO supabase_storage_admin WITH GRANT OPTION;

-- =============================================================================
-- 9. DEFAULT PRIVILEGES
-- =============================================================================

-- public schema defaults
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

-- supabase_admin defaults in public (so objects it creates are accessible)
ALTER DEFAULT PRIVILEGES FOR USER supabase_admin IN SCHEMA public GRANT ALL
    ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR USER supabase_admin IN SCHEMA public GRANT ALL
    ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR USER supabase_admin IN SCHEMA public GRANT ALL
    ON FUNCTIONS TO postgres, anon, authenticated, service_role;

-- storage schema defaults
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

-- =============================================================================
-- 10. ROLE ATTRIBUTES & SEARCH PATHS
-- =============================================================================

-- BYPASSRLS / SUPERUSER for service roles (PG17+ needs SUPERUSER for set_config)
ALTER ROLE service_role WITH BYPASSRLS;
ALTER ROLE supabase_storage_admin WITH BYPASSRLS SUPERUSER;
ALTER ROLE supabase_auth_admin WITH BYPASSRLS;

-- Search paths
ALTER USER supabase_admin SET search_path TO public, extensions;
ALTER USER supabase_auth_admin SET search_path = "auth";
ALTER USER supabase_storage_admin SET search_path = "storage";
ALTER ROLE postgres SET search_path TO "\$user", public, extensions;

-- Statement timeouts for API roles
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';

-- =============================================================================
-- 11. AUTH FUNCTIONS (available before GoTrue starts)
-- =============================================================================

-- These support both legacy (request.jwt.claim.X) and non-legacy
-- (request.jwt.claims JSON) PostgREST formats.
-- Non-legacy is used when PGRST_DB_USE_LEGACY_GUCS=false.

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text;
$$ LANGUAGE sql STABLE;

-- Transfer ownership to supabase_auth_admin so GoTrue can CREATE OR REPLACE them
ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;

-- =============================================================================
-- 12. DASHBOARD USER GRANTS (for Supabase Studio)
-- =============================================================================

GRANT ALL ON SCHEMA auth TO dashboard_user;
GRANT ALL ON SCHEMA extensions TO dashboard_user;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO dashboard_user;
GRANT ALL ON ALL TABLES IN SCHEMA extensions TO dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA extensions TO dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA auth TO dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA extensions TO dashboard_user;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'storage') THEN
    GRANT ALL ON SCHEMA storage TO dashboard_user;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO dashboard_user;
    GRANT ALL ON ALL ROUTINES IN SCHEMA storage TO dashboard_user;
  END IF;
END $$;

-- =============================================================================
-- 13. STORAGE ROLE SETUP (from official storage-schema.sql)
-- =============================================================================

GRANT CREATE ON DATABASE postgres TO supabase_storage_admin;
