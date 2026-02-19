FROM pgducklake/pgducklake:17-main

USER root

# Supabase SQL init scripts (run alphabetically by postgres entrypoint)
# Base image includes: 0001-install-pg_duckdb.sql, 0002-enable-md-pg_duckdb.sql

# 1. Create _supabase database
COPY ./volumes/db/_supabase.sql    /docker-entrypoint-initdb.d/00-supabase-system.sql

# 2. Create Supabase roles (must run BEFORE system schemas that reference them)
COPY ./scripts/init-supabase-roles.sql  /docker-entrypoint-initdb.d/01-supabase-roles.sql

# 3. System schemas (reference supabase_admin, supabase_functions_admin, etc.)
COPY ./volumes/db/webhooks.sql     /docker-entrypoint-initdb.d/02-webhooks.sql
COPY ./volumes/db/roles.sql        /docker-entrypoint-initdb.d/03-roles.sql
COPY ./volumes/db/jwt.sql          /docker-entrypoint-initdb.d/04-jwt.sql
COPY ./volumes/db/realtime.sql     /docker-entrypoint-initdb.d/05-realtime.sql
COPY ./volumes/db/logs.sql         /docker-entrypoint-initdb.d/06-logs.sql
COPY ./volumes/db/pooler.sql       /docker-entrypoint-initdb.d/07-pooler.sql

# 4. DuckDB S3 secret for Supabase Storage
COPY ./scripts/init-pgducklake-s3.sql   /docker-entrypoint-initdb.d/20-pgducklake-s3.sql

# 5. DuckLake demo tables and SECURITY DEFINER functions
COPY ./scripts/init-ducklake-demo.sql   /docker-entrypoint-initdb.d/21-ducklake-demo.sql

USER postgres
