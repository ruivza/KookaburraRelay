import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database, migrations } from '../src/database.js';
import { migrate } from '../scripts/migrate-sqlite.mjs';
test('SQLite import preserves exact rows and refuses initialized targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-import-')),
    source = join(dir, 'gateway.sqlite'),
    schema = 'test_import_' + randomUUID().replaceAll('-', '');
  const db = new Database(process.env.GATEWAY_DATABASE_URL, schema);
  const sqlite = new DatabaseSync(source);
  sqlite.exec(
    readFileSync(new URL('../src/migrations/004-baseline.sql', import.meta.url), 'utf8')
      .replace(/^ALTER TABLE .*;$/gm, '')
      .replace(/BIGSERIAL/g, 'INTEGER')
      .replace(/JSONB/g, 'TEXT')
      .replace(/ ON CONFLICT DO NOTHING/g, ''),
  );
  sqlite
    .prepare('INSERT INTO applications VALUES(?,?,1,?,?)')
    .run('notes', '测试应用', 'revision', 'encrypted-private-key');
  sqlite
    .prepare('INSERT INTO gateway_logs VALUES(?,?,?,?,?,?,?,?,?)')
    .run(42, 1790000000000, 'audit', 'test', 'notes', 'apns', 200, 5, 'req');
  sqlite.close();
  try {
    const report = await migrate(source, db);
    assert.ok(report.every(r => r.verified));
    assert.equal((await db.prepare('SELECT name FROM applications WHERE id=?').get('notes')).name, '测试应用');
    await db
      .prepare('INSERT INTO gateway_logs(time,kind,action,status,duration,request_id) VALUES(?,?,?,?,?,?)')
      .run(1790000000001, 'audit', 'next', 200, 1, 'next');
    assert.equal((await db.prepare('SELECT max(id) n FROM gateway_logs').get()).n, 43);
    await assert.rejects(migrate(source, db), /already initialized/);
  } finally {
    await db.exec(`DROP SCHEMA ${schema} CASCADE`);
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('numbered migrations apply once, in order, and complete databases from 0.1.x releases', async () => {
  const schema = 'test_migrations_' + randomUUID().replaceAll('-', '');
  const db = new Database(process.env.GATEWAY_DATABASE_URL, schema);
  const versions = async () =>
    (await db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).map(r => r.version);
  try {
    const files = migrations();
    assert.ok(files.length >= 1 && files[0].version === 4);
    assert.deepEqual(
      files.map(f => f.version),
      [...new Set(files.map(f => f.version))].sort((a, b) => a - b),
    );
    await db.initialize();
    assert.deepEqual(
      await versions(),
      files.map(f => f.version),
    );
    const exists = (table, column) =>
      db
        .prepare(
          'SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=?' +
            (column ? ' AND column_name=?' : ''),
        )
        .get(schema, table, ...(column ? [column] : []));
    for (const [table, column] of [['limits'], ['configuration'], ['applications', 'secret']])
      assert.equal(await exists(table, column), undefined, table + (column ? '.' + column : ''));
    // A database last run by 0.1.2: its markers, without the column 0.1.3 added.
    await db.exec('ALTER TABLE registrations DROP COLUMN confirmed_at');
    await db.exec('DELETE FROM schema_migrations');
    await db.exec('INSERT INTO schema_migrations VALUES(1),(2),(3)');
    await db.initialize();
    assert.ok(
      await db
        .prepare(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name='registrations' AND column_name='confirmed_at'",
        )
        .get(schema),
    );
    assert.deepEqual(await versions(), [1, 2, 3, ...files.map(f => f.version)]);
    await db.initialize();
    assert.deepEqual(await versions(), [1, 2, 3, ...files.map(f => f.version)]);
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.close();
  }
});

test('a nested transaction is a savepoint: its failure keeps the outer transaction and its writes', async () => {
  const schema = 'test_savepoint_' + randomUUID().replaceAll('-', '');
  const db = new Database(process.env.GATEWAY_DATABASE_URL, schema);
  try {
    await db.exec(`CREATE SCHEMA ${schema}`);
    await db.exec('CREATE TABLE t(v TEXT PRIMARY KEY)');
    await db.transaction(async () => {
      await db.prepare('INSERT INTO t VALUES(?)').run('outer');
      await assert.rejects(
        db.transaction(async () => {
          await db.prepare('INSERT INTO t VALUES(?)').run('inner');
          // A failing statement would abort a plain shared transaction.
          await db.prepare('INSERT INTO t VALUES(?)').run('outer');
        }),
        e => e.code === '23505',
      );
      await db.prepare('INSERT INTO t VALUES(?)').run('after');
    });
    assert.deepEqual(
      (await db.prepare('SELECT v FROM t ORDER BY v').all()).map(r => r.v),
      ['after', 'outer'],
    );
    // Work started inside a transaction but detached from it runs on the pool, not the finished transaction.
    let late;
    await db.transaction(async () => {
      late = db.detached(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return (await db.prepare('SELECT count(*) n FROM t').get()).n;
      });
    });
    assert.equal(await late, 2);
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.close();
  }
});
