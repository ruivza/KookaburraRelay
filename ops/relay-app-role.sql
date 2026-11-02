-- Hands one schema and the objects in it to the gateway's non-superuser role.
-- Run as a superuser after setting relay.app_role and relay.app_schema in the
-- same session; ops/create-app-role.sh does this. Objects outside the schema
-- keep their owners (deliberately no REASSIGN OWNED).
DO $$
DECLARE
  app_role text := current_setting('relay.app_role');
  app_schema text := current_setting('relay.app_schema');
  item record;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app_role AND rolcanlogin
      AND NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Role % must exist, log in and hold no administrative attributes', app_role;
  END IF;
  IF pg_has_role(app_role, 'pg_execute_server_program', 'MEMBER')
      OR pg_has_role(app_role, 'pg_read_server_files', 'MEMBER')
      OR pg_has_role(app_role, 'pg_write_server_files', 'MEMBER') THEN
    RAISE EXCEPTION 'Role % must not have server file or program access', app_role;
  END IF;
  -- The gateway runs CREATE SCHEMA IF NOT EXISTS at startup, which checks this privilege.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), app_role);
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', app_schema, app_role);
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', app_schema, app_role);
  -- Indexes, row types and column-owned sequences follow their table.
  FOR item IN SELECT c.oid::regclass AS name, c.relkind FROM pg_class c
      WHERE c.relnamespace = app_schema::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE item.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      item.name, app_role);
  END LOOP;
  FOR item IN SELECT c.oid::regclass AS name FROM pg_class c
      WHERE c.relnamespace = app_schema::regnamespace AND c.relkind = 'S' AND c.relowner <> app_role::regrole LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', item.name, app_role);
  END LOOP;
  -- Skip routines that belong to an extension or are generated for a type.
  FOR item IN SELECT p.oid::regprocedure AS name FROM pg_proc p WHERE p.pronamespace = app_schema::regnamespace
      AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype IN ('e', 'i')) LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', item.name, app_role);
  END LOOP;
  -- Domains, enums and standalone composite types; array types follow them.
  FOR item IN SELECT t.oid::regtype AS name, t.typtype FROM pg_type t
      LEFT JOIN pg_class c ON c.oid = t.typrelid
      WHERE t.typnamespace = app_schema::regnamespace
        AND (t.typtype IN ('d', 'e') OR (t.typtype = 'c' AND c.relkind = 'c')) LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE item.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, item.name, app_role);
  END LOOP;
END
$$;
