import { createGateway as create } from '../src/server.js';
import { Database } from '../src/database.js';
import { createHash } from 'node:crypto';
import { after } from 'node:test';
const schemas = new Set();
// New installations have no applications; most tests run against the default application that installations from
// before 0.3.0 have; it is created on a schema's first start only, so a restart keeps deletions.
// defaultApplication: false starts like a new installation.
export async function createGateway({ defaultApplication = true, ...options }) {
  const databaseSchema = 'test_' + createHash('sha256').update(options.dataDir).digest('hex').slice(0, 16);
  const first = !schemas.has(databaseSchema);
  schemas.add(databaseSchema);
  const app = await create({ ...options, databaseSchema });
  if (defaultApplication && first) await app.applications.create({ id: 'perch-mail', name: 'Perch Mail' });
  return app;
}
after(async () => {
  if (!schemas.size) return;
  const db = new Database(process.env.GATEWAY_DATABASE_URL);
  try {
    for (const s of schemas) await db.exec(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
  } finally {
    await db.close();
  }
});
