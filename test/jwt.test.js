import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { signJWT } from '../src/jwt.js';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

test('signJWT emits JOSE ES256 and RS256 compact tokens and refuses other algorithms', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const [header, claims, signature] = signJWT({ alg: 'ES256', kid: 'ABCDEFGHIJ' }, { iss: '0123456789', iat: 1700000000 }, ec.privateKey).split('.');
  assert.equal(header, encode({ alg: 'ES256', kid: 'ABCDEFGHIJ' }));assert.equal(claims, encode({ iss: '0123456789', iat: 1700000000 }));
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(header + '.' + claims), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  // PKCS#1 v1.5 is deterministic: RS256 must match a plain RSA-SHA256 signature for PEM and KeyObject keys alike.
  const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), rs = signJWT({ alg: 'RS256', typ: 'JWT' }, { iss: 'a@b' }, pem);
  const [h, c, s] = rs.split('.');
  assert.equal(s, sign('RSA-SHA256', Buffer.from(h + '.' + c), pem).toString('base64url'));
  assert.equal(rs, signJWT({ alg: 'RS256', typ: 'JWT' }, { iss: 'a@b' }, rsa.privateKey));
  for (const alg of ['none', 'HS256', undefined]) assert.throws(() => signJWT({ alg }, {}, rsa.privateKey), /Unsupported JWT algorithm/);
});
