import QRCode from 'qrcode';
import { randomBytes, createHmac, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { fail, randomSecret, sha256Hex } from './util.js';
// Replaces the bootstrap token after a rotation; backups keep copying the file, but it holds no secret.
export const rotatedMarker =
  '# Kookaburra Relay admin token was changed in the console and is not stored in this file.';
const derive = promisify(scrypt);
// Exclusive temp file plus rename: a symlink planted at the target is replaced, never written through.
function replaceFile(path, content) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
const equal = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode(secret) {
  let bits = 0,
    value = 0,
    out = [];
  for (const c of secret) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret, time = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac('sha1', decode(secret)).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function tokenHash(value) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + (await derive(value, salt, 32)).toString('hex');
}
async function verifyToken(value, stored) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const [salt, hash] = stored.split(':');
  return equal((await derive(value, salt, 32)).toString('hex'), hash);
}
export class Security {
  constructor({ db, seal, open, now = Date.now, adminPath }) {
    this.db = db;
    this.seal = seal;
    this.open = open;
    this.now = now;
    this.adminPath = adminPath;
    this.verifying = 0;
    this.attempt = new AsyncLocalStorage();
    // scrypt runs under the admin row lock while holding a pool connection; cap attempts before taking one.
    for (const method of ['login', 'reauthenticate', 'changeToken', 'setup', 'confirm', 'disable']) {
      const perform = this[method].bind(this);
      this[method] = (...args) => this.limited(() => perform(...args));
    }
  }
  async limited(work) {
    if (this.attempt.getStore()) return work();
    if (this.verifying >= 4)
      throw Object.assign(Error('Gateway resource limit'), { status: 503, reason: 'login_concurrency', retryAfter: 5 });
    this.verifying++;
    try {
      return await this.attempt.run(true, work);
    } finally {
      this.verifying--;
    }
  }
  // The bootstrap file only hands over the first token; it is never read once a token is stored.
  async initialize(token) {
    const stored = await this.db.prepare('SELECT token_hash FROM admin_security WHERE id=1').get();
    if (stored) {
      if (token && !(await verifyToken(token, stored.token_hash)))
        console.warn(
          'GATEWAY_ADMIN_TOKEN differs from the stored admin token and is ignored; it is only imported on first start. Sign in with the current token or change it in the console.',
        );
      return;
    }
    if (!token) {
      token = existsSync(this.adminPath) ? readFileSync(this.adminPath, 'utf8').trim() : '';
      if (!token || token === rotatedMarker) {
        token = randomSecret();
        replaceFile(this.adminPath, token);
      }
      if (token.length < 32) throw Error('Gateway admin token must be at least 32 characters');
    }
    await this.db
      .prepare('INSERT INTO admin_security(id,token_hash) VALUES(1,?) ON CONFLICT DO NOTHING')
      .run(await tokenHash(token));
  }
  async row() {
    return this.db.prepare('SELECT * FROM admin_security WHERE id=1 FOR UPDATE').get();
  }
  async factor(row, code) {
    code = typeof code === 'string' ? code.trim() : '';
    if (!row.totp_secret) return;
    if (/^\d{6}$/.test(code)) {
      const secret = this.open(row.totp_secret),
        step = Math.floor(this.now() / 30000);
      for (const offset of [0, -1, 1])
        if (step + offset > row.last_step && equal(totp(secret, (step + offset) * 30000), code)) {
          await this.db.prepare('UPDATE admin_security SET last_step=? WHERE id=1').run(step + offset);
          return;
        }
    } else {
      const hashes = row.recovery_hashes,
        hash = sha256Hex(code.toLowerCase().replace(/\s/g, ''));
      const index = hashes.findIndex(h => equal(h, hash));
      if (index >= 0) {
        hashes.splice(index, 1);
        await this.db.prepare('UPDATE admin_security SET recovery_hashes=? WHERE id=1').run(JSON.stringify(hashes));
        return;
      }
    }
    fail(403, 'Invalid or already used verification code');
  }
  async reauthenticate(row, body) {
    if (!(await verifyToken(body.currentToken, row.token_hash))) fail(403, 'Invalid current token');
    await this.factor(row, body.code);
  }
  async login(body) {
    return this.db.transaction(async () => {
      const row = await this.row();
      if (!(await verifyToken(body.token, row.token_hash))) fail(401, 'Unauthorized');
      if (row.totp_secret && !body.code) return { requiresSecondFactor: true };
      await this.factor(row, body.code);
      const session = randomSecret(),
        expires = this.now() + 8 * 3600000;
      await this.db.prepare('DELETE FROM admin_sessions WHERE expires<=?').run(this.now());
      await this.db.prepare('INSERT INTO admin_sessions VALUES(?,?)').run(sha256Hex(session), expires);
      return { session, expires };
    });
  }
  async authenticate(value) {
    if (
      !(await this.db
        .prepare('SELECT 1 FROM admin_sessions WHERE hash=? AND expires>?')
        .get(sha256Hex(value), this.now()))
    )
      fail(401, 'Unauthorized');
  }
  async logout(value) {
    await this.db.prepare('DELETE FROM admin_sessions WHERE hash=?').run(sha256Hex(value));
  }
  async status() {
    const row = await this.db.prepare('SELECT totp_secret,recovery_hashes FROM admin_security WHERE id=1').get();
    return { twoFactorEnabled: !!row.totp_secret, recoveryCodesRemaining: row.recovery_hashes.length };
  }
  async changeToken(body) {
    if (
      typeof body.newToken !== 'string' ||
      body.newToken.length < 32 ||
      body.newToken.length > 256 ||
      /\s/.test(body.newToken)
    )
      fail(400, 'New token must contain 32–256 characters without spaces');
    const result = await this.db.transaction(async () => {
      const row = await this.row();
      await this.reauthenticate(row, body);
      if (await verifyToken(body.newToken, row.token_hash)) fail(400, 'New token must differ from current token');
      await this.db
        .prepare('UPDATE admin_security SET token_hash=?,pending_secret=NULL,pending_until=NULL WHERE id=1')
        .run(await tokenHash(body.newToken));
      await this.db.exec('DELETE FROM admin_sessions');
      return { signInAgain: true };
    });
    // The rotation is committed; a stale bootstrap token must not stay in the data directory or its backups.
    try {
      replaceFile(this.adminPath, rotatedMarker + '\n');
    } catch {
      console.error('Admin token file could not be replaced after rotation');
    }
    return result;
  }
  async setup(body) {
    return this.db.transaction(async () => {
      const row = await this.row();
      if (row.totp_secret) fail(409, 'Two-step verification is already enabled');
      await this.reauthenticate(row, body);
      const secret = base32(randomBytes(20));
      await this.db
        .prepare('UPDATE admin_security SET pending_secret=?,pending_until=? WHERE id=1')
        .run(this.seal(secret), this.now() + 600000);
      const uri =
        'otpauth://totp/Kookaburra%20Relay:Admin?secret=' +
        secret +
        '&issuer=Kookaburra%20Relay&algorithm=SHA1&digits=6&period=30';
      return { secret, qr: await QRCode.toDataURL(uri, { width: 220, margin: 2 }) };
    });
  }
  async confirm(body) {
    return this.db.transaction(async () => {
      const row = await this.row();
      if (row.totp_secret || !row.pending_secret || row.pending_until < this.now())
        fail(400, 'Setup expired; start again');
      if (!(await verifyToken(body.currentToken, row.token_hash))) fail(403, 'Invalid current token');
      const codes = Array.from({ length: 10 }, () =>
        randomBytes(10)
          .toString('hex')
          .match(/.{1,5}/g)
          .join('-'),
      );
      await this.factor({ ...row, totp_secret: row.pending_secret, last_step: -1 }, body.code);
      await this.db
        .prepare(
          'UPDATE admin_security SET totp_secret=pending_secret,pending_secret=NULL,pending_until=NULL,recovery_hashes=? WHERE id=1',
        )
        .run(JSON.stringify(codes.map(sha256Hex)));
      await this.db.exec('DELETE FROM admin_sessions');
      return { recoveryCodes: codes, signInAgain: true };
    });
  }
  async disable(body) {
    return this.db.transaction(async () => {
      const row = await this.row();
      await this.reauthenticate(row, body);
      await this.db.exec(
        "UPDATE admin_security SET totp_secret=NULL,pending_secret=NULL,pending_until=NULL,last_step=-1,recovery_hashes='[]' WHERE id=1; DELETE FROM admin_sessions",
      );
      return { signInAgain: true };
    });
  }
}
