import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("tool authority epoch migration", () => {
  it("backfills companies created across trigger installation without a provisioning gap", async () => {
    const database = await startEmbeddedPostgresTestDatabase("tool-authority-bootstrap-");
    const db = postgres(database.connectionString, { max: 4, onnotice: () => {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await db`DROP TRIGGER companies_provision_tool_authority_epoch ON companies`;
      await db`DELETE FROM tool_authority_epochs`;
      const before = randomUUID();
      const during = randomUUID();
      await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${before}, 'Before', 'BEFORE')`;
      let inserted!: () => void;
      const ready = new Promise<void>(resolve => { inserted = resolve; });
      const creator = db.begin(async tx => {
        await tx`INSERT INTO companies(id, name, issue_prefix) VALUES (${during}, 'During', 'DURING')`;
        inserted();
        await gate;
      });
      await ready;
      const migration = await readFile(new URL("./migrations/0334_ambitious_frightful_four.sql", import.meta.url), "utf8");
      const install = migration.split("--> statement-breakpoint").find(part => part.includes("LOCK TABLE companies"))!;
      const installer = db.unsafe(install).execute();
      // Observe the actual conflicting lock before allowing the creator to
      // commit. A timing-only race would not demonstrate bootstrap ordering.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await db`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE relation = 'companies'::regclass
          AND mode = 'ShareRowExclusiveLock' AND NOT granted) AS waiting`;
        if (state.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release();
      await creator;
      await installer;
      expect(waiting).toBe(true);
      const after = randomUUID();
      await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${after}, 'After', 'AFTER')`;
      const rows = await db`SELECT company_id FROM tool_authority_epochs WHERE company_id IN ${db([before, during, after])}`;
      expect(rows.map(row => row.company_id).sort()).toEqual([before, during, after].sort());
    } finally {
      release();
      await db.end();
      await database.cleanup();
    }
  }, 60_000);
  it("lets unrelated writers proceed while same-company authority waits for admission", async () => {
    const database = await startEmbeddedPostgresTestDatabase("tool-authority-lock-");
    const db = postgres(database.connectionString, { max: 5, onnotice: () => {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ids = [randomUUID(), randomUUID()];
    try {
      for (const id of ids) await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${id}, 'Lock fixture', ${id.slice(0, 8)})`;
      let locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const admission = db.begin(async tx => {
        await tx`SELECT company_id FROM tool_authority_epochs WHERE company_id = ${ids[0]} FOR SHARE NOWAIT`;
        locked();
        await gate;
      });
      await ready;
      let writerFinished = false;
      const writer = db.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SELECT invalidate_tool_authority_epochs(${[ids[0]]}::uuid[])`;
      }).then(() => { writerFinished = true; });
      // An unrelated company's authority writer must not wait for admission.
      await db.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        await tx`SELECT invalidate_tool_authority_epochs(${[ids[1]]}::uuid[])`;
      });
      expect(writerFinished).toBe(false);
      // A conflicting NOWAIT lock rejects immediately with the expected SQLSTATE.
      await expect(db.begin(async tx => {
        await tx`SELECT company_id FROM tool_authority_epochs WHERE company_id = ${ids[0]} FOR UPDATE NOWAIT`;
      })).rejects.toMatchObject({ code: '55P03' });
      release();
      await admission;
      await writer;
      expect(writerFinished).toBe(true);
    } finally {
      release();
      await db.end();
      await database.cleanup();
    }
  }, 60_000);
  it("provisions companies, orders multi-company invalidation, rolls back and fails closed", async () => {
    const database = await startEmbeddedPostgresTestDatabase("tool-authority-epoch-");
    const db = postgres(database.connectionString, { max: 4, onnotice: () => {} });
    try {
      const ids = [randomUUID(), randomUUID()].sort();
      for (const id of ids) {
        await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${id}, 'Epoch fixture', ${id.slice(0, 8)})`;
      }
      const rows = await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(ids)} ORDER BY company_id`;
      expect(rows.map(row => row.epoch)).toEqual(['0', '0']);
      // Both operations use opposite caller order, but the function sorts the
      // complete set before acquiring a write lock. Neither must deadlock.
      await Promise.all([ids, [...ids].reverse()].map(order => db.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SELECT invalidate_tool_authority_epochs(${order}::uuid[])`;
      })));
      const changed = await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(ids)} ORDER BY company_id`;
      expect(changed.map(row => row.epoch)).toEqual(['2', '2']);
      await expect(db.begin(async tx => {
        await tx`SELECT invalidate_tool_authority_epochs(${ids}::uuid[])`;
        throw new Error('rollback fixture');
      })).rejects.toThrow('rollback fixture');
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id = ${ids[0]}`)[0].epoch).toBe('2');
      await db`DELETE FROM tool_authority_epochs WHERE company_id = ${ids[1]}`;
      await expect(db`SELECT invalidate_tool_authority_epochs(${ids}::uuid[])`).rejects.toThrow('Missing tool authority epoch');
      // First company's increment was part of the same failed statement.
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id = ${ids[0]}`)[0].epoch).toBe('2');
      await db`DELETE FROM companies WHERE id = ${ids[0]}`;
      expect(await db`SELECT * FROM tool_authority_epochs WHERE company_id = ${ids[0]}`).toHaveLength(0);
    } finally {
      await db.end();
      await database.cleanup();
    }
  }, 60_000);
});
