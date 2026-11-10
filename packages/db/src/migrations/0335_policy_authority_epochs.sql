-- Company-scoped policy/profile authority. Operational rows, credentials and
-- instance-wide registrations are intentionally not wired by this migration.
-- Use statement transition tables so a multi-company mutation passes its entire
-- OLD/NEW set to the ordered invalidator once, rather than locking in row order.
CREATE FUNCTION invalidate_company_policy_epochs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE affected uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM new_authority;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM old_authority;
  ELSE
    -- All fields except the observation timestamp remain fail-closed, including
    -- future columns. Symmetric difference also handles primary-key changes.
    SELECT array_agg(DISTINCT (row_data->>'company_id')::uuid) INTO affected
    FROM (
      (SELECT to_jsonb(o) - 'updated_at' AS row_data FROM old_authority o
       EXCEPT SELECT to_jsonb(n) - 'updated_at' FROM new_authority n)
      UNION
      (SELECT to_jsonb(n) - 'updated_at' FROM new_authority n
       EXCEPT SELECT to_jsonb(o) - 'updated_at' FROM old_authority o)
    ) changed;
  END IF;
  -- Company deletion may cascade after its epoch row has gone. Only a company
  -- actually deleted by this transaction is exempt; existing companies with
  -- missing epochs still raise in the invalidator and roll back the mutation.
  SELECT array_agg(id) INTO affected FROM companies WHERE id = ANY(affected);
  PERFORM invalidate_tool_authority_epochs(affected);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION reject_policy_authority_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Use DELETE for policy authority mutations' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
DO $$
DECLARE authority_table text;
BEGIN
  FOREACH authority_table IN ARRAY ARRAY[
    'principal_permission_grants', 'company_memberships', 'tool_policies',
    'tool_profiles', 'tool_profile_entries', 'tool_profile_bindings'
  ] LOOP
    EXECUTE format('CREATE TRIGGER authority_epoch_insert AFTER INSERT ON %I
      REFERENCING NEW TABLE AS new_authority FOR EACH STATEMENT
      EXECUTE FUNCTION invalidate_company_policy_epochs()', authority_table);
    EXECUTE format('CREATE TRIGGER authority_epoch_delete AFTER DELETE ON %I
      REFERENCING OLD TABLE AS old_authority FOR EACH STATEMENT
      EXECUTE FUNCTION invalidate_company_policy_epochs()', authority_table);
    EXECUTE format('CREATE TRIGGER authority_epoch_update AFTER UPDATE ON %I
      REFERENCING OLD TABLE AS old_authority NEW TABLE AS new_authority FOR EACH STATEMENT
      EXECUTE FUNCTION invalidate_company_policy_epochs()', authority_table);
    EXECUTE format('CREATE TRIGGER authority_epoch_truncate BEFORE TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION reject_policy_authority_truncate()', authority_table);
  END LOOP;
END;
$$;
