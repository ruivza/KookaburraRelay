import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
// Millisecond timestamps and counts remain numbers throughout the gateway API.
pg.types.setTypeParser(20, value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw Error('Database integer exceeds safe range');
  return n;
});
export class Database {
  constructor(url, schema = 'public') {
    if (!url) throw Error('GATEWAY_DATABASE_URL is required');
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw Error('Invalid database schema');
    this.schema = schema;
    this.context = new AsyncLocalStorage();
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      options: `-c search_path=${schema}`,
    });
    this.pool.on('error', () => console.error('PostgreSQL connection interrupted'));
  }
  async query(sql, values = []) {
    return (this.context.getStore()?.client || this.pool).query(sql, values);
  }
  // Runs fn once the current transaction commits, or now outside one. It also marks the transaction as having
  // changed configuration, so ConfigCache reads inside it go to the database.
  afterCommit(fn) {
    const state = this.context.getStore();
    if (!state) return fn();
    state.changedConfiguration = true;
    state.committed.push(fn);
  }
  changedConfiguration() {
    return !!this.context.getStore()?.changedConfiguration;
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
  async transaction(fn) {
    if (this.context.getStore()) return fn();
    const client = await this.pool.connect();
    const state = { client, changedConfiguration: false, committed: [] };
    let result;
    try {
      await client.query('BEGIN');
      result = await this.context.run(state, fn);
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
  async initialize() {
    await this.exec(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.transaction(async () => {
      await this.query('SELECT pg_advisory_xact_lock(72841101)');
      await this.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    });
  }
  async close() {
    await this.pool.end();
  }
}
