import { createHash, X509Certificate, createPrivateKey } from 'node:crypto';
import { verifyAttestation, verifyAssertion } from 'node-app-attest';
import cbor from 'cbor';
import { GoogleOAuth, boundedFetch } from './google-oauth.js';
const invalid = () => {
  throw Object.assign(Error('Invalid application proof'), { status: 403 });
};
const unavailable = () => {
  throw Object.assign(Error('Application verification temporarily unavailable'), { status: 503, retryAfter: 60 });
};
const bytes = (value, max = 20000) => {
  if (typeof value !== 'string' || value.length > max) invalid();
  const result = Buffer.from(value, 'base64');
  if (!result.length || result.toString('base64') !== value) invalid();
  return result;
};

export function verifyApple({ proof, payload, policy, key, now = Date.now() }) {
  try {
    if (bytes(proof.keyId, 100).length !== 32) invalid();
    const common = { keyId: proof.keyId, bundleIdentifier: policy.bundleId, teamIdentifier: policy.teamId };
    if (key) {
      const assertion = bytes(proof.assertion);
      const decoded = cbor.decodeAllSync(assertion, { max_depth: 16 });
      if (
        decoded.length !== 1 ||
        !Buffer.isBuffer(decoded[0].authenticatorData) ||
        decoded[0].authenticatorData.length !== 37
      )
        invalid();
      const result = verifyAssertion({
        ...common,
        assertion,
        payload,
        publicKey: key.public_key,
        signCount: key.counter,
      });
      return { publicKey: key.public_key, counter: result.signCount };
    }
    const attestation = bytes(proof.attestation);
    const decoded = cbor.decodeAllSync(attestation, { max_depth: 16 });
    if (decoded.length !== 1 || decoded[0].attStmt?.x5c?.length !== 2) invalid();
    const [leaf, issuer] = decoded[0].attStmt.x5c.map(value => new X509Certificate(value));
    if (leaf.ca || !issuer.ca || !leaf.checkIssued(issuer)) invalid();
    for (const cert of [leaf, issuer])
      if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) invalid();
    const auth = decoded[0].authData;
    if (!Buffer.isBuffer(auth) || auth.length < 87 || !(auth[32] & 0x40) || auth.readUInt16BE(53) !== 32) invalid();
    const result = verifyAttestation({
      ...common,
      attestation,
      challenge: payload,
      allowDevelopmentEnvironment: policy.appleEnvironment === 'development',
    });
    if (result.environment !== policy.appleEnvironment) invalid();
    return { publicKey: result.publicKey, counter: 0 };
  } catch {
    invalid();
  }
}

export function googleCredential(value) {
  if (
    !value ||
    value.type !== 'service_account' ||
    typeof value.client_email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(value.client_email)
  )
    throw Object.assign(Error('Invalid Google service account'), { status: 400 });
  try {
    const key = createPrivateKey(value.private_key);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error();
    return { clientEmail: value.client_email, privateKey: key.export({ type: 'pkcs8', format: 'pem' }) };
  } catch {
    throw Object.assign(Error('Invalid Google service account'), { status: 400 });
  }
}
export function validateGoogleVerdict(verdict, { policy, payload, now = Date.now() }) {
  const r = verdict?.requestDetails,
    a = verdict?.appIntegrity;
  const time = Number(r?.timestampMillis);
  if (
    r?.requestPackageName !== policy.packageName ||
    r?.requestHash !== createHash('sha256').update(payload).digest('base64url') ||
    !Number.isSafeInteger(time) ||
    time > now + 30000 ||
    time < now - 300000 ||
    a?.packageName !== policy.packageName ||
    a?.appRecognitionVerdict !== 'PLAY_RECOGNIZED' ||
    !Array.isArray(a.certificateSha256Digest) ||
    !a.certificateSha256Digest.some(d => policy.certificateDigests.includes(d)) ||
    !Array.isArray(verdict?.deviceIntegrity?.deviceRecognitionVerdict) ||
    !verdict.deviceIntegrity.deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY') ||
    verdict.accountDetails?.appLicensingVerdict !== 'LICENSED'
  )
    invalid();
  return true;
}
export class GoogleIntegrity {
  constructor({ fetcher = fetch, now = Date.now } = {}) {
    Object.assign(this, {
      fetcher,
      now,
      oauth: new GoogleOAuth({ scope: 'https://www.googleapis.com/auth/playintegrity', fetcher, now }),
    });
  }
  async json(url, options) {
    try {
      const { response, text } = await boundedFetch(this.fetcher, url, options);
      if (!response.ok) throw Error();
      return JSON.parse(text);
    } catch {
      unavailable();
    }
  }
  // Any OAuth failure, a malformed token response included, is a retryable outage.
  accessToken(credential) {
    return this.oauth.token(credential).catch(unavailable);
  }
  async verify({ proof, payload, policy, credential }) {
    if (
      typeof proof.integrityToken !== 'string' ||
      proof.integrityToken.length < 20 ||
      proof.integrityToken.length > 20000
    )
      invalid();
    const token = await this.accessToken(credential);
    let decoded;
    try {
      decoded = await this.json(`https://playintegrity.googleapis.com/v1/${policy.packageName}:decodeIntegrityToken`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrity_token: proof.integrityToken }),
      });
    } catch (error) {
      // Do not retain a token the remote service rejected; the next request can obtain a fresh one.
      this.oauth.invalidate(token);
      throw error;
    }
    validateGoogleVerdict(decoded.tokenPayloadExternal, { policy, payload, now: this.now() });
  }
}
