import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
const marker = 'kookaburra-relay-master-key-v1';
const encryptedColumns = [
  ['access_policies', 'google_secret'], ['alert_settings', 'secret'],
  ['backup_settings', 'secret'], ['configuration', 'secret'], ['applications', 'secret'], ['app_channels', 'secret'],
  ['registrations', 'token'], ['registrations', 'credentials'],
  ['admin_security', 'totp_secret'], ['admin_security', 'pending_secret'],
];

// Caller holds the database ownership lock. Existing installations must never
// silently get a new key, even if all configured applications were deleted.
export async function loadEncryption(db, dataDir) {
  const path = resolve(dataDir, 'master.key');
  const check = await db.prepare('SELECT value FROM gateway_key_check WHERE id=1').get();
  if (!existsSync(path)) {
    let initialized = !!check || !!await db.prepare('SELECT 1 FROM schema_migrations WHERE version>=2').get()
      || !!await db.prepare('SELECT 1 FROM admin_security').get();
    for (const [table, column] of encryptedColumns) {
      if (initialized) break;
      initialized = !!await db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`).get();
    }
    if (initialized) throw Error('Master key missing for existing database; restore the original key volume');
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw Error('Invalid gateway master key');
  const seal = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64');
  };
  const open = value => {
    const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString();
  };
  try {
    if (check) {
      if (open(check.value) !== marker) throw Error('Invalid key marker');
    } else {
      // One-time legacy upgrade: authenticate every ciphertext in bounded batches
      // before binding the database to this key. No credentials enter logs.
      await db.transaction(async () => {
        for (const [table, column] of encryptedColumns) {
          await db.exec(`DECLARE key_validation NO SCROLL CURSOR FOR SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
          while (true) {
            const rows = (await db.query('FETCH FORWARD 500 FROM key_validation')).rows;
            for (const row of rows) open(row.value);
            if (rows.length < 500) break;
          }
          await db.exec('CLOSE key_validation');
        }
        await db.prepare('INSERT INTO gateway_key_check VALUES(1,?)').run(seal(marker));
      });
    }
  } catch {
    throw Error('Master key does not match database or encrypted data is damaged; restore matching database and key backups');
  }
  return { seal, open };
}
