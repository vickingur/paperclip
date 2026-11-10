import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("remaining authority epochs", () => {
  it("fences template and indirect credential version CRUD, OLD/NEW owners and cascades", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-indirect-");
    const db = postgres(database.connectionString, { onnotice: () => {} });
    try {
      const ids = [randomUUID(), randomUUID()].sort(), secrets = [randomUUID(), randomUUID()];
      for (let i = 0; i < ids.length; i++) {
        await db`INSERT INTO companies(id,name,issue_prefix) VALUES (${ids[i]},'Fixture',${ids[i].slice(0,8)})`;
        await db`INSERT INTO company_secrets(id,company_id,key,name) VALUES (${secrets[i]},${ids[i]},'fixture','Fixture')`;
      }
      const epochs = async () => (await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(ids)} ORDER BY company_id`).map(r => BigInt(r.epoch));
      const template = randomUUID(), version = randomUUID();
      const before = await epochs();
      await db`INSERT INTO tool_stdio_command_templates(id,company_id,template_key,name,command) VALUES (${template},${ids[0]},'fixture','Fixture','fixture')`;
      await db`UPDATE tool_stdio_command_templates SET command='changed' WHERE id=${template}`;
      await db`UPDATE tool_stdio_command_templates SET company_id=${ids[1]} WHERE id=${template}`;
      await db`DELETE FROM tool_stdio_command_templates WHERE id=${template}`;
      expect(await epochs()).toEqual([before[0] + 3n, before[1] + 2n]);
      const initial = await epochs();
      await db`INSERT INTO company_secret_versions(id,secret_id,version,material,value_sha256,fingerprint_sha256) VALUES (${version},${secrets[0]},1,'{}','synthetic','synthetic')`;
      await db`UPDATE company_secret_versions SET material='{"synthetic":true}' WHERE id=${version}`;
      await db`UPDATE company_secret_versions SET secret_id=${secrets[1]} WHERE id=${version}`;
      expect(await epochs()).toEqual([initial[0] + 3n, initial[1] + 1n]);
      const moved = await epochs();
      await expect(db.begin(async tx => {
        await tx`UPDATE company_secret_versions SET status='revoked' WHERE id=${version}`;
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await epochs()).toEqual(moved);
      await db`DELETE FROM tool_authority_epochs WHERE company_id=${ids[1]}`;
      await expect(db`UPDATE company_secret_versions SET status='revoked' WHERE id=${version}`).rejects.toMatchObject({ code: '23514' });
      expect((await db`SELECT status FROM company_secret_versions WHERE id=${version}`)[0].status).toBe('current');
      await db`INSERT INTO tool_authority_epochs(company_id,epoch) VALUES (${ids[1]},${String(moved[1])})`;
      await db`DELETE FROM company_secret_versions WHERE id=${version}`;
      expect(await epochs()).toEqual([moved[0], moved[1] + 1n]);
      await db`INSERT INTO company_secret_versions(secret_id,version,material,value_sha256,fingerprint_sha256) VALUES (${secrets[1]},2,'{}','synthetic','synthetic')`;
      const cascade = await epochs();
      await db`DELETE FROM company_secrets WHERE id=${secrets[1]}`;
      expect(await db`SELECT id FROM company_secret_versions WHERE secret_id=${secrets[1]}`).toHaveLength(0);
      expect(await epochs()).toEqual([cascade[0], cascade[1] + 1n]);
      for (const table of ['company_secret_versions', 'tool_stdio_command_templates']) {
        await expect(db`TRUNCATE ${db(table)} CASCADE`).rejects.toMatchObject({ code: '23514' });
      }
    } finally { await db.end(); await database.cleanup(); }
  }, 60_000);

  it("invalidates all companies for plugin authority and fails closed atomically", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-plugin-");
    const db = postgres(database.connectionString, { onnotice: () => {} });
    try {
      const ids = [randomUUID(), randomUUID()].sort(), plugin = randomUUID();
      for (const id of ids) await db`INSERT INTO companies(id,name,issue_prefix) VALUES (${id},'Fixture',${id.slice(0,8)})`;
      const epochs = async () => (await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(ids)} ORDER BY company_id`).map(r => BigInt(r.epoch));
      await db`INSERT INTO plugins(id,plugin_key,package_name,version,manifest_json) VALUES (${plugin},'synthetic','synthetic','1','{}')`;
      expect(await epochs()).toEqual([1n, 1n]);
      await db`UPDATE plugins SET last_error='observation',updated_at=now() WHERE id=${plugin}`;
      expect(await epochs()).toEqual([1n, 1n]);
      await db`UPDATE plugins SET manifest_json='{"synthetic":true}',version='2' WHERE id=${plugin}`;
      expect(await epochs()).toEqual([2n, 2n]);
      await expect(db.begin(async tx => {
        await tx`UPDATE plugins SET status='disabled' WHERE id=${plugin}`;
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await epochs()).toEqual([2n, 2n]);
      await db`DELETE FROM tool_authority_epochs WHERE company_id=${ids[1]}`;
      await expect(db`UPDATE plugins SET status='disabled' WHERE id=${plugin}`).rejects.toMatchObject({ code: '23514' });
      expect((await db`SELECT status FROM plugins WHERE id=${plugin}`)[0].status).toBe('installed');
      expect((await epochs())[0]).toBe(2n);
      await db`INSERT INTO tool_authority_epochs(company_id,epoch) VALUES (${ids[1]},2)`;
      await db`DELETE FROM plugins WHERE id=${plugin}`;
      expect(await epochs()).toEqual([3n, 3n]);
      await expect(db`TRUNCATE plugins CASCADE`).rejects.toMatchObject({ code: '23514' });
    } finally { await db.end(); await database.cleanup(); }
  }, 60_000);

  it("serializes global registration with admission and concurrent company provisioning", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-plugin-race-");
    const db = postgres(database.connectionString, { max: 6, onnotice: () => {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let admission: Promise<unknown> | undefined, writer: Promise<unknown> | undefined, creator: Promise<unknown> | undefined;
    try {
      const company = randomUUID(), newCompany = randomUUID(), plugin = randomUUID();
      await db`INSERT INTO companies(id,name,issue_prefix) VALUES (${company},'Fixture',${company.slice(0,8)})`;
      await db`INSERT INTO plugins(id,plugin_key,package_name,version,manifest_json) VALUES (${plugin},'synthetic','synthetic','1','{}')`;
      let locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      admission = db.begin(async tx => {
        await tx`SELECT company_id FROM tool_authority_epochs WHERE company_id=${company} FOR SHARE NOWAIT`;
        locked(); await gate;
      });
      await ready;
      writer = db.begin(async tx => {
        await tx`SET LOCAL lock_timeout='3s'`;
        await tx`UPDATE plugins SET status='disabled' WHERE id=${plugin}`;
      });
      const waitFor = async (query: string) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE ${query}) AS waiting`;
          if (row.waiting) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error(`Expected actual Lock wait for ${query}`);
      };
      await waitFor('UPDATE plugins SET status%');
      creator = db.begin(async tx => {
        await tx`SET LOCAL lock_timeout='3s'`;
        await tx`INSERT INTO companies(id,name,issue_prefix) VALUES (${newCompany},'New',${newCompany.slice(0,8)})`;
      });
      await waitFor('INSERT INTO companies%');
      // Global registration does not lock operational tables.
      await db.begin(async tx => {
        await tx`SET LOCAL lock_timeout='100ms'`;
        await tx`INSERT INTO agents(company_id,name,role,adapter_type) VALUES (${company},'Concurrent','engineer','process')`;
        await tx`UPDATE plugins SET last_error='observation' WHERE id=${randomUUID()}`;
      });
      release(); await admission; await writer; await creator;
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id=${company}`)[0].epoch).toBe('2');
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id=${newCompany}`)[0].epoch).toBe('0');
      expect((await db`SELECT status FROM plugins WHERE id=${plugin}`)[0].status).toBe('disabled');
    } finally { release(); await Promise.allSettled([admission, writer, creator]); await db.end(); await database.cleanup(); }
  }, 60_000);
});
