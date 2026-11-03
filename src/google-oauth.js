import { createHash } from 'node:crypto';
import { signJWT } from './jwt.js';

const endpoint = 'https://oauth2.googleapis.com/token';
const capacity = 32;

// Provider requests time out after 10 s, refuse redirects and cap the body at 64 KiB. Owners that
// abort in-flight requests on close() pass the Set their controllers are tracked in.
export async function boundedFetch(fetcher, url, options, active) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10000);
  active?.add(controller);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error' });
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) throw Error('Provider response too large');
      chunks.push(chunk);
    }
    return { response, text: Buffer.concat(chunks).toString() };
  } finally {
    clearTimeout(timer);
    active?.delete(controller);
  }
}

// Service-account access tokens for one scope, from the fixed Google endpoint only. Tokens are cached per
// credential, so one instance can serve several applications' service accounts; at most 32 are kept, the oldest
// stored dropped first. Concurrent refreshes for a credential share a promise, and a refresh superseded by
// invalidate() never replaces the cache. Transport failures propagate as thrown; a rejected or malformed token
// response throws with its HTTP `responseStatus`.
export class GoogleOAuth {
  constructor({ scope, fetcher = fetch, now = Date.now }) {
    this.scope = scope;
    this.fetcher = fetcher;
    this.now = now;
    this.controllers = new Set();
    this.cached = new Map();
    this.pending = new Map();
  }
  async token({ clientEmail, privateKey }) {
    const key = createHash('sha256').update(clientEmail).update('\0').update(privateKey).digest('hex');
    const cached = this.cached.get(key);
    if (cached && cached.expires > this.now() + 60000) return cached.token;
    if (this.pending.has(key)) return this.pending.get(key).promise;
    const pending = {};
    this.pending.set(key, pending);
    pending.promise = (async () => {
      const started = this.now(),
        iat = Math.floor(started / 1000);
      const assertion = signJWT(
        { alg: 'RS256', typ: 'JWT' },
        { iss: clientEmail, scope: this.scope, aud: endpoint, iat, exp: iat + 3600 },
        privateKey,
      );
      const { response, text } = await boundedFetch(
        this.fetcher,
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }).toString(),
        },
        this.controllers,
      );
      const body = JSON.parse(text || '{}');
      if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token)
        throw Object.assign(Error('Google OAuth token request failed'), { responseStatus: response.status });
      // A token without a whole-second lifetime beyond the refresh margin is used once, never cached.
      if (this.pending.get(key) === pending && Number.isSafeInteger(body.expires_in) && body.expires_in > 60) {
        // Re-inserting moves the credential to the newest position.
        this.cached.delete(key);
        this.cached.set(key, { token: body.access_token, expires: started + Math.min(3600, body.expires_in) * 1000 });
        if (this.cached.size > capacity) this.cached.delete(this.cached.keys().next().value);
      }
      return body.access_token;
    })();
    try {
      return await pending.promise;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
  // Forget a token the provider rejected; with no argument, forget everything including refreshes in flight.
  invalidate(token) {
    if (token === undefined) {
      this.cached.clear();
      this.pending.clear();
    } else for (const [key, entry] of this.cached) if (entry.token === token) this.cached.delete(key);
  }
  close() {
    for (const controller of this.controllers) controller.abort();
    this.invalidate();
  }
}
