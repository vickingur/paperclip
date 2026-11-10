import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("connection authority epochs", () => {
  it("invalidates every direct authority table on insertion, change and deletion", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-connection-coverage-");
    const db = postgres(database.connectionString, { onnotice: () => {} });
    try {
      const company = randomUUID();
      const app = randomUUID(), connection = randomUUID(), grant = randomUUID();
      const profile = randomUUID(), secret = randomUUID(), agent = randomUUID();
      await db`INSERT INTO companies(id,name,issue_prefix) VALUES (${company},'Fixture',${company.slice(0,8)})`;
      await db`INSERT INTO agents(id,company_id,name,role,adapter_type) VALUES (${agent},${company},'Fixture','engineer','process')`;
      await db`INSERT INTO tool_applications(id,company_id,name,type) VALUES (${app},${company},'Base','mcp')`;
      await db`INSERT INTO tool_connections(id,company_id,application_id,name,uid,transport) VALUES (${connection},${company},${app},'Base','base','mcp_remote')`;
      await db`INSERT INTO connection_grants(id,company_id,connection_id,kind) VALUES (${grant},${company},${connection},'organization')`;
      await db`INSERT INTO tool_profiles(id,company_id,profile_key,name) VALUES (${profile},${company},'base','Base')`;
      await db`INSERT INTO company_secrets(id,company_id,key,name) VALUES (${secret},${company},'base','Base')`;
      const cases = [
        ['tool_applications', { name: 'Second', type: 'mcp' }],
        ['tool_connections', { application_id: app, name: 'Second', uid: 'second', transport: 'mcp_remote' }],
        ['connection_grants', { connection_id: connection, kind: 'user', subject_user_id: 'fixture' }],
        ['connection_grant_members', { grant_id: grant, subject_type: 'user', subject_id: 'fixture' }],
        ['connection_grant_delegations', { grant_id: grant, agent_id: agent, created_by_user_id: 'fixture' }],
        ['tool_connection_installs', { connection_id: connection, target_type: 'company', target_id: company }],
        ['tool_catalog_entries', { connection_id: connection, name: 'fixture', tool_name: 'fixture', version_hash: 'fixture' }],
        ['tool_mcp_gateways', { name: 'Fixture', slug: 'fixture', profile_id: profile }],
        ['company_secrets', { key: 'second', name: 'Second' }],
        ['company_secret_bindings', { secret_id: secret, target_type: 'connection', target_id: connection, config_path: 'fixture' }],
        ['company_secret_provider_configs', { provider: 'fixture', display_name: 'Fixture' }],
      ] as const;
      const epoch = async () => BigInt((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id=${company}`)[0].epoch);
      for (const [table, fields] of cases) {
        const id = randomUUID(), before = await epoch();
        await db`INSERT INTO ${db(table)} ${db({ id, company_id: company, ...fields })}`;
        expect(await epoch(), `${table} insert`).toBe(before + 1n);
        await db`UPDATE ${db(table)} SET created_at=created_at + interval '1 second' WHERE id=${id}`;
        expect(await epoch(), `${table} update`).toBe(before + 2n);
        await db`DELETE FROM ${db(table)} WHERE id=${id}`;
        expect(await epoch(), `${table} delete`).toBe(before + 3n);
        await expect(db`TRUNCATE ${db(table)} CASCADE`).rejects.toMatchObject({ code: '23514' });
      }
      // Real mutable authority fields, including unknown OAuth fields, fail closed.
      const before = await epoch();
      await db`UPDATE tool_connections SET config='{"endpoint":"fixture"}' WHERE id=${connection}`;
      await db`UPDATE connection_grants SET provider_tenant='{"oauth":{"scopes":["read"]}}' WHERE id=${grant}`;
      await db`UPDATE connection_grants SET provider_tenant='{"oauth":{"scopes":["write"],"futureAuthority":true}}' WHERE id=${grant}`;
      await db`UPDATE company_secrets SET latest_version=2 WHERE id=${secret}`;
      expect(await epoch()).toBe(before + 4n);
    } finally { await db.end(); await database.cleanup(); }
  }, 60_000);

  it("covers OLD/NEW companies, rollback, missing epochs and reversed statement order", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-connection-atomic-");
    const db = postgres(database.connectionString, { max: 4, onnotice: () => {} });
    try {
      const ids = [randomUUID(), randomUUID()].sort();
      for (const id of ids) await db`INSERT INTO companies(id,name,issue_prefix) VALUES (${id},'Fixture',${id.slice(0,8)})`;
      const app = randomUUID();
      await db`INSERT INTO tool_applications(id,company_id,name,type) VALUES (${app},${ids[0]},'Move','mcp')`;
      const epochs = async () => (await db`SELECT epoch FROM tool_authority_epochs WHERE company_id IN ${db(ids)} ORDER BY company_id`).map(r => BigInt(r.epoch));
      const before = await epochs();
      await db`UPDATE tool_applications SET company_id=${ids[1]} WHERE id=${app}`;
      expect(await epochs()).toEqual(before.map(e => e + 1n));
      await Promise.all([ids, [...ids].reverse()].map(order => db.begin(async tx => {
        await tx`SET LOCAL lock_timeout='2s'`;
        await tx`INSERT INTO tool_applications ${tx(order.map(company_id => ({ company_id, name: randomUUID(), type: 'mcp' })))}`;
      })));
      const inserted = await epochs();
      await expect(db.begin(async tx => {
        await tx`UPDATE tool_applications SET status='archived' WHERE company_id IN ${tx(ids)}`;
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await epochs()).toEqual(inserted);
      await db`DELETE FROM tool_authority_epochs WHERE company_id=${ids[1]}`;
      await expect(db`UPDATE tool_applications SET status='archived' WHERE company_id IN ${db(ids)}`).rejects.toMatchObject({ code: '23514' });
      expect(await db`SELECT id FROM tool_applications WHERE status='archived'`).toHaveLength(0);
      expect((await epochs())[0]).toBe(inserted[0]);
    } finally { await db.end(); await database.cleanup(); }
  }, 60_000);

  it("serializes grant revocation while unrelated writes and health/refresh bookkeeping proceed", async () => {
    const database = await startEmbeddedPostgresTestDatabase("authority-connection-overlap-");
    const db = postgres(database.connectionString, { max: 5, onnotice: () => {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let admission: Promise<unknown> | undefined, writer: Promise<unknown> | undefined;
    try {
      const company = randomUUID(), other = randomUUID(), app = randomUUID(), connection = randomUUID(), grant = randomUUID();
      for (const id of [company, other]) await db`INSERT INTO companies(id,name,issue_prefix) VALUES (${id},'Fixture',${id.slice(0,8)})`;
      await db`INSERT INTO tool_applications(id,company_id,name,type) VALUES (${app},${company},'Fixture','mcp')`;
      await db`INSERT INTO tool_connections(id,company_id,application_id,name,uid,transport) VALUES (${connection},${company},${app},'Fixture','fixture','mcp_remote')`;
      await db`INSERT INTO connection_grants(id,company_id,connection_id,kind,provider_tenant) VALUES (${grant},${company},${connection},'organization','{"oauth":{"scopes":["read"]}}')`;
      const epoch = (await db`SELECT epoch FROM tool_authority_epochs WHERE company_id=${company}`)[0].epoch;
      let locked!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      admission = db.begin(async tx => {
        await tx`SELECT company_id FROM tool_authority_epochs WHERE company_id=${company} FOR SHARE NOWAIT`;
        locked(); await gate;
      });
      await ready;
      await db.begin(async tx => {
        await tx`SET LOCAL lock_timeout='100ms'`;
        await tx`UPDATE tool_connections SET health_status='healthy',health_message='fixture',health_checked_at=now(),last_health_at=now(),last_catalog_refresh_at=now(),last_error='fixture',updated_at=now() WHERE id=${connection}`;
        await tx`UPDATE connection_grants SET last_used_at=now(),updated_at=now(),provider_tenant='{"oauth":{"scopes":["read"],"accessTokenExpiresAt":"fixture","refreshedAt":"fixture","refreshTokenExpiresAt":"fixture","refreshLease":{"fixture":true}}}' WHERE id=${grant}`;
        await tx`INSERT INTO tool_applications(company_id,name,type) VALUES (${other},'Unrelated','mcp')`;
      });
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id=${company}`)[0].epoch).toBe(epoch);
      writer = db.begin(async tx => {
        await tx`SET LOCAL lock_timeout='3s'`;
        await tx`UPDATE connection_grants SET status='revoked' WHERE id=${grant}`;
      });
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await db`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE connection_grants SET status%') AS waiting`;
        if (row.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await db`SELECT status FROM connection_grants WHERE id=${grant}`)[0].status).toBe('active');
      release(); await admission; await writer;
      expect((await db`SELECT epoch FROM tool_authority_epochs WHERE company_id=${company}`)[0].epoch).toBe(String(BigInt(epoch) + 1n));
      expect((await db`SELECT status FROM connection_grants WHERE id=${grant}`)[0].status).toBe('revoked');
    } finally { release(); await Promise.allSettled([admission, writer]); await db.end(); await database.cleanup(); }
  }, 60_000);
});
