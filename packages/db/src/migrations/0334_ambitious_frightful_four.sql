CREATE TABLE "tool_authority_epochs" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_authority_epochs" ADD CONSTRAINT "tool_authority_epochs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION provision_tool_authority_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tool_authority_epochs(company_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- One atomic statement locks company creation across trigger installation and
-- backfill. A creator either finishes before the backfill or sees the trigger.
DO $$
BEGIN
  LOCK TABLE companies IN SHARE ROW EXCLUSIVE MODE;
  CREATE TRIGGER companies_provision_tool_authority_epoch
    AFTER INSERT ON companies FOR EACH ROW
    EXECUTE FUNCTION provision_tool_authority_epoch();
  INSERT INTO tool_authority_epochs(company_id) SELECT id FROM companies;
END;
$$;
--> statement-breakpoint
-- Caller passes OLD and NEW companies together. Writers block normally; NOWAIT
-- belongs only on admission, never on authority mutations. No implicit repair.
CREATE FUNCTION invalidate_tool_authority_epochs(affected uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE company uuid;
BEGIN
  FOR company IN SELECT DISTINCT id FROM unnest(affected) AS ids(id)
    WHERE id IS NOT NULL ORDER BY id
  LOOP
    UPDATE tool_authority_epochs SET epoch = epoch + 1 WHERE company_id = company;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Missing tool authority epoch for company %', company
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$;
