// Generic notification envelopes. Business meaning belongs to the sending application.
export const notificationAlgorithm = 'p256-hkdf-sha256-aes256gcm-v1';
export function encryptedNotification(value, kind, now = Date.now()) {
  if (value === undefined || value === null) return null;
  const fail = () => { throw Object.assign(Error('Invalid encrypted notification'), {status:400}); };
  if (kind !== 'encrypted_alert' || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'ciphertext,ephemeralKey,expires,id,keyId,version'
    || value.version !== 1 || typeof value.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(value.keyId)
    || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) || !Number.isSafeInteger(value.expires)
    || value.expires <= now || value.expires > now + 86400000) fail();
  const valid = (s,min,max) => {
    if (typeof s !== 'string') return false;
    const b = Buffer.from(s,'base64');
    return b.length >= min && b.length <= max && b.toString('base64') === s;
  };
  if (!valid(value.ephemeralKey,65,65) || Buffer.from(value.ephemeralKey,'base64')[0] !== 4
    || !valid(value.ciphertext,28,2400)) fail();
  return {version:1,keyId:value.keyId,id:value.id,expires:value.expires,ephemeralKey:value.ephemeralKey,ciphertext:value.ciphertext};
}

export const notificationKinds = ['sync','alert','encrypted_alert'];
export function requestedKinds(body) {
  const purpose = body.purpose ?? 'sync';
  if (body.kinds !== undefined && body.purpose !== undefined) throw Object.assign(Error('Use kinds or purpose, not both'),{status:400});
  const input = body.kinds ?? (purpose === 'sync' ? ['sync'] : ['sync',purpose]);
  if (!Array.isArray(input) || !input.length || input.some(k => !notificationKinds.includes(k)) || new Set(input).size !== input.length)
    throw Object.assign(Error('Invalid notification capabilities'),{status:400});
  return notificationKinds.filter(k => input.includes(k));
}
export function allows(entry, kind) {
  return notificationKinds.includes(kind) && (entry.kinds ?? ['sync']).includes(kind);
}
export function alertContent(value) {
  const fail = () => {throw Object.assign(Error('Invalid alert content'),{status:400});};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['title','body','sound'].includes(k))) fail();
  for (const [key,limit] of [['title',120],['body',400]]) {
    if (typeof value[key] !== 'string' || Array.from(value[key]).length > limit
      || /[\u0000-\u001f\u007f-\u009f]/.test(value[key])) fail();
  }
  if (!value.title.trim() && !value.body.trim()) fail();
  if (value.sound !== undefined && typeof value.sound !== 'boolean') fail();
  return {title:value.title,body:value.body,sound:value.sound ?? true};
}
export function deliveryContent(kind, notification, alert, now) {
  if (!notificationKinds.includes(kind)) throw Object.assign(Error('Unsupported notification kind'),{status:400});
  if (kind === 'alert') {
    if (notification != null) throw Object.assign(Error('Unexpected encrypted content'),{status:400});
    return {alert:alertContent(alert)};
  }
  if (alert != null) throw Object.assign(Error('Unexpected alert content'),{status:400});
  const encrypted = encryptedNotification(notification,kind,now);
  return encrypted ? {encryptedNotification:encrypted} : null;
}
export function notificationSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['kinds','fallback'].includes(k)))
    throw Object.assign(Error('Invalid notification settings'),{status:400});
  const kinds = input.kinds ?? ['sync'];
  if (!Array.isArray(kinds) || kinds.some(k=>!notificationKinds.includes(k)) || new Set(kinds).size !== kinds.length)
    throw Object.assign(Error('Invalid notification capabilities'),{status:400});
  const fallback = alertContent(input.fallback ?? {title:'Notification',body:'Open the app to view the update.'});
  // Accept legacy sound settings, but encrypted alerts always request the system sound.
  fallback.sound = true;
  return {kinds:notificationKinds.filter(k=>kinds.includes(k)),fallback};
}
