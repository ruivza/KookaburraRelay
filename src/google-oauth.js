import { createHash } from 'node:crypto';
import { signJWT } from './jwt.js';

const endpoint = 'https://oauth2.googleapis.com/token';

// Provider requests time out after 10 s, refuse redirects and cap the body at 64 KiB. Owners that
// abort in-flight requests on close() pass the Set their controllers are tracked in.
export async function boundedFetch(fetcher, url, options, active) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  active?.add(controller);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error' });
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 65536) throw Error('Provider response too large'); chunks.push(chunk); }
    return { response, text: Buffer.concat(chunks).toString() };
  } finally { clearTimeout(timer); active?.delete(controller); }
}

// Service-account access tokens for one scope, from the fixed Google endpoint only. One token is cached,
// keyed by credential; concurrent refreshes for that credential share a promise, and a refresh superseded
// by another credential or by invalidate() never replaces the cache. Transport failures propagate as
// thrown; a rejected or malformed token response throws with its HTTP `responseStatus`.
export class GoogleOAuth {
  constructor({ scope, fetcher = fetch, now = Date.now }) { Object.assign(this, { scope, fetcher, now, controllers: new Set() }); }
  async token({ clientEmail, privateKey }) {
    const key = createHash('sha256').update(clientEmail).update('\0').update(privateKey).digest('hex');
    if (this.cached?.key === key && this.cached.expires > this.now() + 60000) return this.cached.token;
    if (this.pending?.key === key) return this.pending.promise;
    const pending = this.pending = { key };
    pending.promise = (async () => {
      const started = this.now(), iat = Math.floor(started / 1000);
      const assertion = signJWT({ alg: 'RS256', typ: 'JWT' }, { iss: clientEmail, scope: this.scope, aud: endpoint, iat, exp: iat + 3600 }, privateKey);
      const { response, text } = await boundedFetch(this.fetcher, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() }, this.controllers);
      const body = JSON.parse(text || '{}');
      if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token)
        throw Object.assign(Error('Google OAuth token request failed'), { responseStatus: response.status });
      // A token without a whole-second lifetime beyond the refresh margin is used once, never cached.
      if (this.pending === pending && Number.isSafeInteger(body.expires_in) && body.expires_in > 60)
        this.cached = { key, token: body.access_token, expires: started + Math.min(3600, body.expires_in) * 1000 };
      return body.access_token;
    })();
    try { return await pending.promise; } finally { if (this.pending === pending) this.pending = null; }
  }
  // Forget a token the provider rejected; with no argument, forget everything including refreshes in flight.
  invalidate(token) { if (token === undefined) this.cached = this.pending = null; else if (this.cached?.token === token) this.cached = null; }
  close() { for (const controller of this.controllers) controller.abort(); this.invalidate(); }
}
