import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("company policy authority triggers", () => {
  it("invalidates each policy/profile table on insert, change, reassignment and delete", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-policy-coverage-");
    const db = postgres(database.connectionString, { onnotice: () => {} });
    try {
      const companies = [randomUUID(), randomUUID()];
      for (const id of companies) await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${id}, 'Policy', ${id.slice(0, 8)})`;
      const profileId = randomUUID();
      await db`INSERT INTO tool_profiles(id, company_id, profile_key, name) VALUES (${profileId}, ${companies[0]}, 'fixture', 'Fixture')`;
      const cases = [
        ['principal_permission_grants', { principal_type: 'agent', principal_id: 'fixture', permission_key: 'fixture' }],
        ['company_memberships', { principal_type: 'agent', principal_id: 'fixture' }],
        ['tool_policies', { name: 'Fixture', policy_type: 'deny' }],
        ['tool_profiles', { profile_key: 'second', name: 'Second' }],
        ['tool_profile_entries', { profile_id: profileId, selector_type: 'tool_name', tool_name: 'fixture' }],
        ['tool_profile_bindings', { profile_id: profileId, target_type: 'agent', target_id: 'fixture' }],
      ] as const;
      const epochs = async () => (await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(companies)} ORDER BY company_id`).map(r => BigInt(r.epoch));
      for (const [table, fields] of cases) {
        const id = randomUUID();
        const before = await epochs();
        await db`INSERT INTO ${db(table)} ${db({ id, company_id: companies[0], ...fields })}`;
        const inserted = await epochs();
        expect(inserted.reduce((a, b) => a + b, 0n)).toBe(before.reduce((a, b) => a + b, 0n) + 1n);
        await db`UPDATE ${db(table)} SET updated_at = now() + interval '1 minute' WHERE id = ${id}`;
        expect(await epochs()).toEqual(inserted);
        await db`UPDATE ${db(table)} SET created_at = created_at + interval '1 second' WHERE id = ${id}`;
        const changed = await epochs();
        expect(changed.reduce((a, b) => a + b, 0n)).toBe(inserted.reduce((a, b) => a + b, 0n) + 1n);
        await db`UPDATE ${db(table)} SET company_id = ${companies[1]} WHERE id = ${id}`;
        expect(await epochs()).toEqual(changed.map(e => e + 1n));
        await db`DELETE FROM ${db(table)} WHERE id = ${id}`;
        const deleted = await epochs();
        expect(deleted.reduce((a, b) => a + b, 0n)).toBe(changed.reduce((a, b) => a + b, 0n) + 3n);
      }
      // Cascade can delete the epoch before the profile, and must remain valid.
      await db`DELETE FROM companies WHERE id = ${companies[0]}`;
      expect(await db`SELECT id FROM tool_profiles WHERE id = ${profileId}`).toHaveLength(0);
    } finally { await db.end(); await database.cleanup(); }
  }, 60_000);

  it("orders a statement's OLD/NEW company set and rolls back missing-epoch mutations", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-policy-atomic-");
    const db = postgres(database.connectionString, { max: 4, onnotice: () => {} });
    try {
      const ids = [randomUUID(), randomUUID()].sort();
      for (const id of ids) await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${id}, 'Policy', ${id.slice(0, 8)})`;
      // Opposite row order must not become opposite epoch-lock order.
      await Promise.all([ids, [...ids].reverse()].map(order => db.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`INSERT INTO tool_policies ${tx(order.map(company_id => ({ company_id, name: randomUUID(), policy_type: 'deny' })))}`;
      })));
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(ids)}`).map(r => r.epoch)).toEqual(['2', '2']);
      await expect(db.begin(async tx => {
        await tx`UPDATE tool_policies SET enabled = false WHERE company_id IN ${tx(ids)}`;
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await db`SELECT id FROM tool_policies WHERE NOT enabled`).toHaveLength(0);
      await db`DELETE FROM tool_authority_epochs WHERE company_id = ${ids[1]}`;
      await expect(db`UPDATE tool_policies SET enabled = false WHERE company_id IN ${db(ids)}`).rejects.toMatchObject({ code: '23514' });
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id = ${ids[0]}`)[0].epoch).toBe('2');
      expect(await db`SELECT id FROM tool_policies WHERE NOT enabled`).toHaveLength(0);
      await expect(db`TRUNCATE tool_policies CASCADE`).rejects.toMatchObject({ code: '23514' });
    } finally { await db.end(); await database.cleanup(); }
  }, 60_000);

  it("blocks a new deny on its company epoch while unrelated policy and timestamp writes proceed", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-policy-race-");
    const db = postgres(database.connectionString, { max: 5, onnotice: () => {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writer: Promise<unknown> | undefined;
    let admission: Promise<unknown> | undefined;
    try {
      const ids = [randomUUID(), randomUUID()];
      for (const id of ids) await db`INSERT INTO companies(id, name, issue_prefix) VALUES (${id}, 'Policy', ${id.slice(0, 8)})`;
      await db`INSERT INTO tool_policies(company_id, name, policy_type) VALUES (${ids[0]}, 'Existing', 'deny')`;
      let locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      admission = db.begin(async tx => {
        await tx`SELECT company_id FROM tool_authority_epochs WHERE company_id = ${ids[0]} FOR SHARE NOWAIT`;
        locked();
        await gate;
      });
      await ready;
      writer = db.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`INSERT INTO tool_policies(company_id, name, policy_type) VALUES (${ids[0]}, 'New deny', 'deny')`;
      });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await db`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
          AND query LIKE 'INSERT INTO tool_policies%') AS waiting`;
        if (row.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await db`SELECT id FROM tool_policies WHERE name = 'New deny'`).toHaveLength(0);
      await db.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '100ms'`;
        await tx`INSERT INTO tool_policies(company_id, name, policy_type) VALUES (${ids[1]}, 'Unrelated', 'deny')`;
        await tx`UPDATE tool_policies SET updated_at = now() WHERE company_id = ${ids[0]}`;
      });
      release();
      await admission;
      await writer;
      expect(await db`SELECT id FROM tool_policies WHERE name = 'New deny'`).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([admission, writer]);
      await db.end(); await database.cleanup();
    }
  }, 60_000);
});
