import { createPrivateKey } from 'node:crypto';
import { GoogleOAuth, boundedFetch } from './google-oauth.js';

// Service-account JSON is encrypted by the configuration store. Only fixed Google
// endpoints are used; token_uri from uploaded files is deliberately ignored.
export class FCMChannel {
  constructor(config, { fetcher = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetcher = fetcher;
    this.controllers = new Set();
    const key = createPrivateKey(config.privateKey);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048)
      throw Error('FCM requires an RSA private key of at least 2048 bits');
    this.oauth = new GoogleOAuth({ scope: 'https://www.googleapis.com/auth/firebase.messaging', fetcher, now });
  }
  // A token response Google rejected or malformed is an authentication failure; transport errors stay network errors.
  authorization() {
    return this.oauth.token({ clientEmail: this.config.clientEmail, privateKey: this.config.privateKey }).catch(error => {
      throw error?.responseStatus ? Object.assign(Error('FCM authorization failed'), { providerStatus: error.responseStatus >= 500 ? 503 : 403 }) : error;
    });
  }
  async send(target, token, message) {
    if (!['challenge', 'sync', 'alert'].includes(message.kind)) return { status: 400, reason: 'UnsupportedMessage' };
    try {
      const access = await this.authorization();
      const data = message.kind === 'challenge'
        ? { perchRegistration: JSON.stringify(message.proof) }
        : message.kind === 'alert' ? {relay:JSON.stringify({version:1,deviceId:target.device_id,appId:target.app_id,serverId:target.server_id,kind:'alert'})}
        : { perch: JSON.stringify({ version: 1, deviceId: target.device_id, appId: target.app_id }) };
      const { response, text } = await boundedFetch(this.fetcher, `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, data, ...(message.kind === 'alert' ? {notification:{title:message.alert.title,body:message.alert.body}} : {}), android: { priority: message.kind === 'alert' ? 'high' : 'normal', ...(message.kind === 'alert' ? {notification:{default_sound:message.alert.sound}} : {}), ttl: message.kind === 'challenge' ? '300s' : '3600s', collapse_key: message.kind === 'challenge' ? 'perch-enroll' : message.kind === 'alert' ? 'relay-alert' : 'perch-sync' } } }),
      }, this.controllers);
      const body = JSON.parse(text || '{}');
      if (response.status === 401) this.oauth.invalidate(access);
      const reason = body.error?.details?.find(item => item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
      return { status: response.ok ? 200 : response.status, reason: reason || body.error?.status,
        retryAfter: response.headers.get('retry-after') };
    } catch (error) {
      return { status: error.providerStatus || 0, reason: error.providerStatus ? 'AuthenticationError' : 'NetworkError' };
    }
  }
  close() { for (const controller of this.controllers) controller.abort(); this.oauth.close(); }
}
