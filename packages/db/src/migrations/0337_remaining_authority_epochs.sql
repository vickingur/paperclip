-- Templates are company-scoped. The same complete-row policy projection applies.
CREATE TRIGGER authority_epoch_insert AFTER INSERT ON tool_stdio_command_templates
REFERENCING NEW TABLE AS new_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_company_policy_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_delete AFTER DELETE ON tool_stdio_command_templates
REFERENCING OLD TABLE AS old_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_company_policy_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_update AFTER UPDATE ON tool_stdio_command_templates
REFERENCING OLD TABLE AS old_authority NEW TABLE AS new_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_company_policy_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_truncate BEFORE TRUNCATE ON tool_stdio_command_templates
FOR EACH STATEMENT EXECUTE FUNCTION reject_policy_authority_truncate();
--> statement-breakpoint
CREATE FUNCTION invalidate_secret_version_epochs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE affected uuid[]; secret_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT secret_id) INTO secret_ids FROM new_authority;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT secret_id) INTO secret_ids FROM old_authority;
  ELSE
    SELECT array_agg(DISTINCT (row_data->>'secret_id')::uuid) INTO secret_ids
    FROM (
      (SELECT to_jsonb(o) AS row_data FROM old_authority o EXCEPT SELECT to_jsonb(n) FROM new_authority n)
      UNION
      (SELECT to_jsonb(n) FROM new_authority n EXCEPT SELECT to_jsonb(o) FROM old_authority o)
    ) changed;
  END IF;
  -- A deleted parent's cascade is already fenced by the company_secrets DELETE
  -- trigger. A surviving parent with a missing epoch still fails closed.
  SELECT array_agg(DISTINCT s.company_id) INTO affected FROM company_secrets s
    JOIN companies c ON c.id = s.company_id WHERE s.id = ANY(secret_ids);
  PERFORM invalidate_tool_authority_epochs(affected);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER authority_epoch_insert AFTER INSERT ON company_secret_versions
REFERENCING NEW TABLE AS new_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_secret_version_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_delete AFTER DELETE ON company_secret_versions
REFERENCING OLD TABLE AS old_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_secret_version_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_update AFTER UPDATE ON company_secret_versions
REFERENCING OLD TABLE AS old_authority NEW TABLE AS new_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_secret_version_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_truncate BEFORE TRUNCATE ON company_secret_versions
FOR EACH STATEMENT EXECUTE FUNCTION reject_policy_authority_truncate();
--> statement-breakpoint
CREATE FUNCTION invalidate_plugin_authority_epochs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE affected uuid[]; changed boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      (SELECT to_jsonb(o) - ARRAY['updated_at', 'last_error'] FROM old_authority o
       EXCEPT SELECT to_jsonb(n) - ARRAY['updated_at', 'last_error'] FROM new_authority n)
      UNION
      (SELECT to_jsonb(n) - ARRAY['updated_at', 'last_error'] FROM new_authority n
       EXCEPT SELECT to_jsonb(o) - ARRAY['updated_at', 'last_error'] FROM old_authority o)
    ) INTO changed;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_authority) INTO changed;
  ELSE
    SELECT EXISTS (SELECT 1 FROM old_authority) INTO changed;
  END IF;
  IF changed THEN
    -- Registration is instance-wide authority. Stabilize company creation while
    -- taking the complete company set; a creator either commits before this lock
    -- and is invalidated, or waits until the registration mutation commits.
    -- This lock is on companies only, never heartbeat/issue/operational tables.
    -- Admission does not take a company-table lock; writers still block normally.
    LOCK TABLE companies IN SHARE MODE;
    SELECT array_agg(id ORDER BY id) INTO affected FROM companies;
    PERFORM invalidate_tool_authority_epochs(affected);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER authority_epoch_insert AFTER INSERT ON plugins
REFERENCING NEW TABLE AS new_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_plugin_authority_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_delete AFTER DELETE ON plugins
REFERENCING OLD TABLE AS old_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_plugin_authority_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_update AFTER UPDATE ON plugins
REFERENCING OLD TABLE AS old_authority NEW TABLE AS new_authority FOR EACH STATEMENT
EXECUTE FUNCTION invalidate_plugin_authority_epochs();
--> statement-breakpoint
CREATE TRIGGER authority_epoch_truncate BEFORE TRUNCATE ON plugins
FOR EACH STATEMENT EXECUTE FUNCTION reject_policy_authority_truncate();
