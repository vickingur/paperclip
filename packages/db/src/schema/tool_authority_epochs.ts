import { sql } from "drizzle-orm";
import { bigint, pgTable, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Authority writers increment this row in their own transaction; admissions
// hold FOR SHARE before reading authority. Missing rows must never be created
// by an admission, since that would turn broken provisioning into an allow.
export const toolAuthorityEpochs = pgTable("tool_authority_epochs", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  epoch: bigint("epoch", { mode: "bigint" }).notNull().default(sql`0`),
});
