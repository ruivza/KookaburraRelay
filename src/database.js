import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync } from 'node:fs';
// Millisecond timestamps and counts remain numbers throughout the gateway API.
pg.types.setTypeParser(20, value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw Error('Database integer exceeds safe range');
  return n;
});
export function migrations() {
  const files = readdirSync(new URL('./migrations/', import.meta.url)).filter(file =>
    /^\d{3}-[a-z0-9-]+\.sql$/.test(file),
  );
  return files.sort().map(file => ({ version: Number(file.slice(0, 3)), file }));
}
export class Database {
  constructor(url, schema = 'public', { poolSize = 20 } = {}) {
    if (!url) throw Error('GATEWAY_DATABASE_URL is required');
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error('Invalid database schema');
    if (!Number.isInteger(poolSize) || poolSize < 2 || poolSize > 200) throw Error('Invalid database pool size');
    this.schema = schema;
    this.context = new AsyncLocalStorage();
    this.settings = {
      connectionString: url,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      options: `-c search_path=${schema}`,
    };
    this.pool = new pg.Pool({ ...this.settings, max: poolSize });
    this.pool.on('error', () => console.error('PostgreSQL connection interrupted'));
  }
  // A connection outside the pool for session-long locks and long background work, which would otherwise
  // hold a pool slot. The caller ends it.
  async dedicated() {
    const client = new pg.Client(this.settings);
    client.on('error', () => console.error('PostgreSQL connection interrupted'));
    await client.connect();
    return client;
  }
  async query(sql, values = []) {
    return (this.context.getStore()?.client || this.pool).query(sql, values);
  }
  // Runs fn just before the current transaction sends COMMIT and again once it has committed (once, now, outside a
  // transaction). For idempotent cache invalidation: anyone who waited on this transaction's row locks resumes after
  // the first call, so finds nothing stale, and the second drops what was loaded in between. A rollback skips the
  // second call. It also marks the transaction as having changed configuration, so its own cached reads go to the
  // database.
  onCommit(fn) {
    const state = this.context.getStore();
    if (!state) return fn();
    state.changedConfiguration = true;
    state.committed.push(fn);
  }
  changedConfiguration() {
    return !!this.context.getStore()?.changedConfiguration;
  }
  // Runs fn outside any transaction context, for work started from inside one that outlives it (a background
  // job would otherwise keep using the transaction's connection after it was released).
  detached(fn) {
    return this.context.exit(fn);
  }
  prepare(sql) {
    let n = 0;
    sql = sql.replace(/\?/g, () => '$' + ++n);
    return {
      get: async (...v) => (await this.query(sql, v)).rows[0],
      all: async (...v) => (await this.query(sql, v)).rows,
      run: async (...v) => ({ changes: (await this.query(sql, v)).rowCount }),
    };
  }
  async exec(sql) {
    await this.query(sql);
  }
  // A transaction inside another is a savepoint: its failure rolls back only its own writes and leaves the outer
  // transaction usable. Commit hooks run when the outermost transaction commits.
  async transaction(fn) {
    const outer = this.context.getStore();
    if (outer) {
      const savepoint = 'nested_' + ++outer.savepoints;
      await outer.client.query('SAVEPOINT ' + savepoint);
      try {
        const result = await fn();
        await outer.client.query('RELEASE SAVEPOINT ' + savepoint);
        return result;
      } catch (error) {
        await outer.client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
        throw error;
      }
    }
    const client = await this.pool.connect();
    const state = { client, changedConfiguration: false, committed: [], savepoints: 0 };
    let result;
    try {
      await client.query('BEGIN');
      result = await this.context.run(state, fn);
      for (const hook of state.committed) hook();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const hook of state.committed) hook();
    return result;
  }
  // Applies src/migrations/NNN-name.sql files not yet recorded in schema_migrations, in order, in one transaction.
  // Versions 1-3 predate numbered files: 1 marked the original schema file, 2 marks an initialized gateway and
  // 3 a SQLite import; numbered files start at 4.
  async initialize() {
    await this.exec(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.transaction(async () => {
      await this.query('SELECT pg_advisory_xact_lock(72841101)');
      await this.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)');
      const applied = new Set((await this.prepare('SELECT version FROM schema_migrations').all()).map(r => r.version));
      for (const { version, file } of migrations()) {
        if (applied.has(version)) continue;
        await this.exec(readFileSync(new URL('./migrations/' + file, import.meta.url), 'utf8'));
        await this.prepare('INSERT INTO schema_migrations VALUES(?)').run(version);
      }
    });
  }
  async close() {
    await this.pool.end();
  }
}
