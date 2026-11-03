import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { GoogleOAuth, boundedFetch } from '../src/google-oauth.js';
const endpoint = 'https://oauth2.googleapis.com/token',
  scope = 'https://www.googleapis.com/auth/test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credential = {
  clientEmail: 'a@project.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const other = { ...credential, clientEmail: 'b@project.iam.gserviceaccount.com' };
// The service account a token request was signed for.
const issuer = options =>
  JSON.parse(Buffer.from(new URLSearchParams(options.body).get('assertion').split('.')[1], 'base64url')).iss;
const gate = () => {
  let open;
  const shut = new Promise(r => (open = r));
  return { shut, open };
};
function client(respond) {
  const f = { now: 1800000000000, calls: [] };
  f.oauth = new GoogleOAuth({
    scope,
    now: () => f.now,
    fetcher: async (url, options) => {
      f.calls.push({ url, options });
      return respond(f.calls.length, options);
    },
  });
  return f;
}

test('Google OAuth signs a scoped assertion for the fixed endpoint and caches from request start until the refresh margin', async () => {
  const f = client(n => {
    if (n === 1) f.now += 5000;
    return Response.json({ access_token: 'token-' + n, expires_in: n === 1 ? 86400 : 3600 });
  });
  assert.equal(await f.oauth.token(credential), 'token-1');
  const { url, options } = f.calls[0],
    form = new URLSearchParams(options.body),
    [header, claims, signature] = form.get('assertion').split('.');
  assert.equal(url, endpoint);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + claims), publicKey, Buffer.from(signature, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: credential.clientEmail,
    scope,
    aud: endpoint,
    iat: 1800000000,
    exp: 1800003600,
  });
  // The 86400 s lifetime is capped at an hour, counted from before the 5 s exchange, less the 60 s margin.
  f.now = 1800000000000 + 3600000 - 60001;
  assert.equal(await f.oauth.token(credential), 'token-1');
  f.now += 1;
  assert.equal(await f.oauth.token(credential), 'token-2');
  assert.equal(f.calls.length, 2);
});

test('Google OAuth shares one refresh per credential while other credentials refresh and cache independently', async () => {
  const held = gate(),
    f = client(async (n, options) => {
      if (n === 1) await held.shut;
      return Response.json({ access_token: issuer(options) + '-' + n, expires_in: 3600 });
    });
  const first = [f.oauth.token(credential), f.oauth.token(credential)];
  assert.equal(await f.oauth.token(other), other.clientEmail + '-2');
  held.open();
  assert.deepEqual(await Promise.all(first), [credential.clientEmail + '-1', credential.clientEmail + '-1']);
  // The slower refresh is cached for its own credential and leaves the other one's token in place.
  assert.equal(await f.oauth.token(credential), credential.clientEmail + '-1');
  assert.equal(await f.oauth.token(other), other.clientEmail + '-2');
  assert.equal(f.calls.length, 2);
  // A rotated key under the same email is a different credential.
  assert.equal(
    await f.oauth.token({
      ...credential,
      privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    }),
    credential.clientEmail + '-3',
  );
});

test('Google OAuth fetches once per credential when credentials alternate, and invalidate(token) forgets only its own', async () => {
  const f = client((n, options) => Response.json({ access_token: issuer(options) + '-' + n, expires_in: 3600 }));
  for (let round = 0; round < 3; round++) {
    assert.equal(await f.oauth.token(credential), credential.clientEmail + '-1');
    assert.equal(await f.oauth.token(other), other.clientEmail + '-2');
  }
  assert.equal(f.calls.length, 2);
  f.oauth.invalidate(credential.clientEmail + '-1');
  assert.equal(await f.oauth.token(other), other.clientEmail + '-2');
  assert.equal(await f.oauth.token(credential), credential.clientEmail + '-3');
  assert.equal(f.calls.length, 3);
});

test('Google OAuth keeps at most 32 credentials, dropping the oldest stored first', async () => {
  const f = client((n, options) => Response.json({ access_token: issuer(options) + '-' + n, expires_in: 3600 }));
  const many = Array.from({ length: 33 }, (_, i) => ({
    ...credential,
    clientEmail: 'account-' + i + '@project.iam.gserviceaccount.com',
  }));
  for (const account of [...many.slice(0, 32), ...many.slice(0, 32)]) await f.oauth.token(account);
  assert.equal(f.calls.length, 32);
  await f.oauth.token(many[32]);
  assert.equal(f.oauth.cached.size, 32);
  assert.equal(await f.oauth.token(many[1]), many[1].clientEmail + '-2');
  assert.equal(await f.oauth.token(many[0]), many[0].clientEmail + '-34');
});

test('Google OAuth invalidation drops only the rejected token; invalidate() and close() discard refreshes in flight', async () => {
  let held = null;
  const f = client(async (n, options) => {
    if (held)
      await Promise.race([
        held.shut,
        new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
      ]);
    return Response.json({ access_token: 'token-' + n, expires_in: 3600 });
  });
  assert.equal(await f.oauth.token(credential), 'token-1');
  f.oauth.invalidate('token-0');
  assert.equal(await f.oauth.token(credential), 'token-1');
  f.oauth.invalidate('token-1');
  assert.equal(await f.oauth.token(credential), 'token-2');
  f.oauth.invalidate('token-2');
  held = gate();
  const dropped = f.oauth.token(credential);
  await new Promise(setImmediate);
  f.oauth.invalidate();
  held.open();
  assert.equal(await dropped, 'token-3');
  held = null;
  assert.equal(await f.oauth.token(credential), 'token-4');
  f.oauth.invalidate('token-4');
  held = gate();
  const aborted = f.oauth.token(credential);
  await new Promise(setImmediate);
  f.oauth.close();
  await assert.rejects(aborted, error => error.name === 'AbortError' && !('responseStatus' in error));
  assert.equal(f.oauth.controllers.size, 0);
  held = null;
  assert.equal(await f.oauth.token(credential), 'token-6');
});

test('Google OAuth reports rejected or malformed responses by status, passes transport failures through and never caches untrusted lifetimes', async () => {
  for (const [response, status] of [
    [new Response('{}', { status: 503 }), 503],
    [Response.json({ error: 'invalid_grant' }, { status: 400 }), 400],
    [Response.json({ access_token: '', expires_in: 3600 }), 200],
    [Response.json({ expires_in: 3600 }), 200],
    [new Response('null'), 200],
    [new Response(''), 200],
  ])
    await assert.rejects(client(() => response).oauth.token(credential), error => error.responseStatus === status);
  await assert.rejects(
    client(() => new Response('<html>')).oauth.token(credential),
    error => error instanceof SyntaxError && !('responseStatus' in error),
  );
  const failure = TypeError('fetch failed');
  await assert.rejects(
    client(() => {
      throw failure;
    }).oauth.token(credential),
    error => error === failure,
  );
  for (const expires_in of [undefined, null, 60, 3599.5, '3600', -1]) {
    const f = client(n => Response.json({ access_token: 'token-' + n, expires_in }));
    assert.equal(await f.oauth.token(credential), 'token-1');
    assert.equal(await f.oauth.token(credential), 'token-2');
  }
});

test('boundedFetch refuses redirects, caps the body at 64 KiB and aborts after 10 s', async t => {
  const text = 'x'.repeat(65536);
  assert.equal(
    (
      await boundedFetch(
        async (url, options) => {
          assert.equal(options.redirect, 'error');
          return new Response(text);
        },
        'https://example.test',
        {},
      )
    ).text,
    text,
  );
  await assert.rejects(
    boundedFetch(async () => new Response(text + 'x'), 'https://example.test', {}),
    /Provider response too large/,
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const active = new Set();
  const pending = boundedFetch(
    (url, options) =>
      new Promise((_, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
    'https://example.test',
    {},
    active,
  );
  assert.equal(active.size, 1);
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(active.size, 0);
});
