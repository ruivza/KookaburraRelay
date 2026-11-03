import { sign } from 'node:crypto';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// Compact JWS for provider credentials. ES256 signatures use the raw r||s form JOSE requires
// (RFC 7518 section 3.4), not the DER encoding node:crypto produces by default.
export function signJWT(header, claims, key) {
  if (header.alg !== 'ES256' && header.alg !== 'RS256') throw Error('Unsupported JWT algorithm');
  const unsigned = encode(header) + '.' + encode(claims);
  return (
    unsigned +
    '.' +
    sign('sha256', Buffer.from(unsigned), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key).toString(
      'base64url',
    )
  );
}
