-- Company-scoped connection, catalog, grant and direct credential authority.
-- Only explicit observations/bookkeeping are excluded; unknown fields invalidate.
CREATE FUNCTION connection_authority_projection(table_name text, row_data jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  row_data := row_data - 'updated_at';
  IF table_name = 'tool_connections' THEN
    row_data := row_data - ARRAY['health_status', 'health_message', 'health_checked_at',
      'last_health_at', 'last_catalog_refresh_at', 'last_error'];
  ELSIF table_name = 'connection_grants' THEN
    row_data := row_data - 'last_used_at';
    -- Match preparedGrantHash: preserve scopes, tenant/subject identity,
    -- credential refs and all unknown OAuth/provider fields.
    IF jsonb_typeof(row_data #> '{provider_tenant,oauth}') = 'object' THEN
      row_data := jsonb_set(row_data, '{provider_tenant,oauth}',
        (row_data #> '{provider_tenant,oauth}') - ARRAY[
          'accessTokenExpiresAt', 'refreshedAt', 'refreshTokenExpiresAt', 'refreshLease']);
    END IF;
  ELSIF table_name = 'tool_catalog_entries' THEN
    row_data := row_data - 'last_seen_at';
  ELSIF table_name = 'company_secrets' THEN
    row_data := row_data - 'last_resolved_at';
  ELSIF table_name = 'company_secret_provider_configs' THEN
    row_data := row_data - ARRAY['health_status', 'health_checked_at', 'health_message', 'health_details'];
  END IF;
  RETURN row_data;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION invalidate_company_connection_epochs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE affected uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM new_authority;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM old_authority;
  ELSE
    SELECT array_agg(DISTINCT (row_data->>'company_id')::uuid) INTO affected
    FROM (
      (SELECT connection_authority_projection(TG_TABLE_NAME, to_jsonb(o)) AS row_data FROM old_authority o
       EXCEPT SELECT connection_authority_projection(TG_TABLE_NAME, to_jsonb(n)) FROM new_authority n)
      UNION
      (SELECT connection_authority_projection(TG_TABLE_NAME, to_jsonb(n)) FROM new_authority n
       EXCEPT SELECT connection_authority_projection(TG_TABLE_NAME, to_jsonb(o)) FROM old_authority o)
    ) changed;
  END IF;
  SELECT array_agg(id) INTO affected FROM companies WHERE id = ANY(affected);
  PERFORM invalidate_tool_authority_epochs(affected);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE authority_table text;
BEGIN
  FOREACH authority_table IN ARRAY ARRAY[
    'tool_applications', 'tool_connections', 'connection_grants',
    'connection_grant_members', 'connection_grant_delegations', 'tool_connection_installs',
    'tool_catalog_entries', 'tool_mcp_gateways', 'company_secrets',
    'company_secret_bindings', 'company_secret_provider_configs'
  ] LOOP
    EXECUTE format('CREATE TRIGGER authority_epoch_insert AFTER INSERT ON %I
      REFERENCING NEW TABLE AS new_authority FOR EACH STATEMENT
      EXECUTE FUNCTION invalidate_company_connection_epochs()', authority_table);
    EXECUTE format('CREATE TRIGGER authority_epoch_delete AFTER DELETE ON %I
      REFERENCING OLD TABLE AS old_authority FOR EACH STATEMENT
      EXECUTE FUNCTION invalidate_company_connection_epochs()', authority_table);
    EXECUTE format('CREATE TRIGGER authority_epoch_update AFTER UPDATE ON %I
      REFERENCING OLD TABLE AS old_authority NEW TABLE AS new_authority FOR EACH STATEMENT
      EXECUTE FUNCTION invalidate_company_connection_epochs()', authority_table);
    EXECUTE format('CREATE TRIGGER authority_epoch_truncate BEFORE TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION reject_policy_authority_truncate()', authority_table);
  END LOOP;
END;
$$;
