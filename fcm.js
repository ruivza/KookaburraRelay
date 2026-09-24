import { createPrivateKey, sign } from 'node:crypto';

// Service-account JSON is encrypted by the configuration store. Only fixed Google
// endpoints are used; token_uri from uploaded files is deliberately ignored.
export class FCMChannel {
  constructor(config, { fetcher = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetcher = fetcher;
    this.now = now;
    this.controllers = new Set();
    this.key = createPrivateKey(config.privateKey);
    if (this.key.asymmetricKeyType !== 'rsa' || this.key.asymmetricKeyDetails.modulusLength < 2048)
      throw Error('FCM requires an RSA private key of at least 2048 bits');
  }
  async request(url, options) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher(url, { ...options, signal: controller.signal, redirect: 'error' });
      let bytes = 0, chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 65536) throw Error('Provider response too large');
        chunks.push(chunk);
      }
      return { response, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  async authorization() {
    if (this.accessToken && this.now() < this.expires - 60000) return this.accessToken;
    if (this.authorizing) return this.authorizing;
    this.authorizing = (async () => {
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const issued = Math.floor(this.now() / 1000);
      const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({
        iss: this.config.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token', iat: issued, exp: issued + 3600,
      });
      const assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), this.key).toString('base64url');
      const { response, body } = await this.request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
      if (!response.ok || typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in))
        throw Object.assign(Error('FCM authorization failed'), { providerStatus: response.status >= 500 ? 503 : 403 });
      this.accessToken = body.access_token;
      this.expires = this.now() + Math.min(3600, body.expires_in) * 1000;
      return this.accessToken;
    })();
    try { return await this.authorizing; } finally { this.authorizing = null; }
  }
  async send(target, token, message) {
    if (!['challenge', 'sync', 'alert'].includes(message.kind)) return { status: 400, reason: 'UnsupportedMessage' };
    try {
      const access = await this.authorization();
      const data = message.kind === 'challenge'
        ? { perchRegistration: JSON.stringify(message.proof) }
        : message.kind === 'alert' ? {relay:JSON.stringify({version:1,deviceId:target.device_id,appId:target.app_id,serverId:target.server_id,kind:'alert'})}
        : { perch: JSON.stringify({ version: 1, deviceId: target.device_id, appId: target.app_id }) };
      const { response, body } = await this.request(`https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, data, ...(message.kind === 'alert' ? {notification:{title:message.alert.title,body:message.alert.body}} : {}), android: { priority: message.kind === 'alert' ? 'high' : 'normal', ...(message.kind === 'alert' ? {notification:{default_sound:message.alert.sound}} : {}), ttl: message.kind === 'challenge' ? '300s' : '3600s', collapse_key: message.kind === 'challenge' ? 'perch-enroll' : message.kind === 'alert' ? 'relay-alert' : 'perch-sync' } } }),
      });
      if (response.status === 401) this.accessToken = null;
      const reason = body.error?.details?.find(item => item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
      return { status: response.ok ? 200 : response.status, reason: reason || body.error?.status,
        retryAfter: response.headers.get('retry-after') };
    } catch (error) {
      return { status: error.providerStatus || 0, reason: error.providerStatus ? 'AuthenticationError' : 'NetworkError' };
    }
  }
  close() { for (const controller of this.controllers) controller.abort(); this.accessToken = null; }
}
