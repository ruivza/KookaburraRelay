import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {defaultApp,validID} from './applications.js';
import {requestedKinds} from './notification.js';
import {verifyApple,GoogleIntegrity,googleCredential} from './integrity.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export const accessDefaults=Object.freeze({requireTrustedServers:false,iosRequired:false,androidRequired:false,teamId:'',bundleId:'',appleEnvironment:'production',packageName:'',certificateDigests:[],cloudProjectNumber:''});
export function registrationBinding(body) {
  const channel=body.channel??'apns',platform=body.platform??'ios',appId=body.appId??defaultApp;
  if(!validID(appId)||!validID(body.deviceId)||!validID(body.serverId)||!validID(body.nonce)||body.nonce.length<32 ||
    !['sandbox','production'].includes(body.environment)||!['apns','fcm'].includes(channel)||
    platform!==(channel==='apns'?'ios':'android')||typeof body.deviceToken!=='string'||
    !(channel==='apns'?/^[a-f0-9]{32,512}$/i:/^[A-Za-z0-9_:.-]{20,4096}$/).test(body.deviceToken))fail(400,'Invalid registration');
  const kinds=requestedKinds(body).slice().sort();
  return hash(JSON.stringify([appId,channel,platform,body.environment,body.deviceId,body.serverId,
    channel==='apns'?body.deviceToken.toLowerCase():body.deviceToken,body.nonce,kinds,body.purpose??null,body.serverTicket??null]));
}
export class AccessControl {
  constructor({db,seal,open,now=Date.now,abuse,appleVerifier=verifyApple,googleVerifier}) {
    Object.assign(this,{db,seal,open,now,abuse,appleVerifier});
    this.google=googleVerifier??new GoogleIntegrity({now}); this.verifying=0;
  }
  async initialize() {
    await this.cleanup();
    this.timer=setInterval(()=>{void this.cleanup().catch(()=>{});},60000).unref();
  }
  async cleanup() {
    if(this.cleaning)return this.cleaning;
    this.cleaning=(async()=>{for(const table of ['integrity_challenges','integrity_keys','server_tickets'])await this.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(this.now());})();
    try{await this.cleaning;}finally{this.cleaning=null;}
  }
  async close(){clearInterval(this.timer);await this.cleaning;}
  async policy(appId) {
    if(!validID(appId)||!await this.db.prepare('SELECT 1 FROM applications WHERE id=?').get(appId))fail(404,'Application not found');
    const row=await this.db.prepare('SELECT * FROM access_policies WHERE app_id=?').get(appId);
    return {settings:{...accessDefaults,...row?.settings},revision:row?.revision??'initial',secret:row?.google_secret??null};
  }
  async publicPolicy(appId) {
    const p=await this.policy(appId);
    return {requireTrustedServers:p.settings.requireTrustedServers,iosRequired:p.settings.iosRequired,androidRequired:p.settings.androidRequired,cloudProjectNumber:p.settings.cloudProjectNumber,revision:p.revision};
  }
  async describe(appId) {const p=await this.policy(appId);return {settings:p.settings,hasGoogleCredential:!!p.secret,revision:p.revision};}
  validate(input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!(k in accessDefaults)))fail(400,'Invalid access policy');
    const p={...accessDefaults,...input};
    for(const name of ['requireTrustedServers','iosRequired','androidRequired'])if(typeof p[name]!=='boolean')fail(400,'Invalid access policy');
    if(!['production','development'].includes(p.appleEnvironment)||typeof p.teamId!=='string'||typeof p.bundleId!=='string'||typeof p.packageName!=='string'||typeof p.cloudProjectNumber!=='string')fail(400,'Invalid access policy');
    if(p.teamId&&!/^[A-Z0-9]{10}$/.test(p.teamId)||p.bundleId&&!/^[A-Za-z0-9.-]{3,200}$/.test(p.bundleId)||p.packageName&&!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(p.packageName)||p.cloudProjectNumber&&!/^\d{1,20}$/.test(p.cloudProjectNumber))fail(400,'Invalid access policy');
    if(!Array.isArray(p.certificateDigests)||p.certificateDigests.length>10||p.certificateDigests.some(d=>typeof d!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(d)))fail(400,'Invalid signing certificate digests');
    if(p.iosRequired&&(!p.teamId||!p.bundleId)||p.androidRequired&&(!p.packageName||!p.cloudProjectNumber||!p.certificateDigests.length))fail(400,'Verification configuration incomplete');
    return p;
  }
  async savePolicy(appId,input) {
    const settings=this.validate(input.settings); const credential=input.googleServiceAccount?googleCredential(input.googleServiceAccount):null;
    await this.db.transaction(async()=>{
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      const previous=await this.policy(appId),encrypted=credential?this.seal(JSON.stringify(credential)):previous.secret;
      if(settings.androidRequired&&!encrypted)fail(400,'Google verification credential required');
      await this.db.prepare('INSERT INTO access_policies VALUES(?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET settings=excluded.settings,revision=excluded.revision,google_secret=excluded.google_secret').run(appId,JSON.stringify(settings),randomUUID(),encrypted);
      await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='AccessPolicyChanged',updated=? WHERE app_id=? AND state IN ('queued','retrying','sending')").run(this.now(),appId);
      await this.db.prepare('DELETE FROM registrations WHERE app_id=?').run(appId);
      await this.db.prepare('DELETE FROM integrity_keys WHERE app_id=?').run(appId);
      await this.db.prepare('DELETE FROM integrity_challenges WHERE app_id=?').run(appId);
    });
    return this.describe(appId);
  }
  async servers(){return this.db.prepare('SELECT id,name,state,apps,created FROM trusted_servers ORDER BY created DESC LIMIT 1000').all();}
  async createServer(body) {
    if(!validID(body.id)||typeof body.name!=='string'||!body.name.trim()||body.name.length>100||!Array.isArray(body.apps)||!body.apps.length||body.apps.length>100||body.apps.some(id=>!validID(id)))fail(400,'Invalid server application');
    await this.db.transaction(async()=>{
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      if((await this.db.prepare('SELECT count(*) n FROM trusted_servers').get()).n>=1000)fail(409,'Server directory full');
      for(const id of body.apps)await this.policy(id);
      if(await this.db.prepare('SELECT 1 FROM trusted_servers WHERE id=?').get(body.id))fail(409,'Server ID already exists');
      await this.db.prepare('INSERT INTO trusted_servers VALUES(?,?,\'pending\',NULL,?,?,?)').run(body.id,body.name.trim(),JSON.stringify([...new Set(body.apps)]),randomUUID(),this.now());
    });
    return {id:body.id,state:'pending'};
  }
  async updateServer(id,body) {
    if(!['approve','block','rotate'].includes(body.action))fail(400,'Invalid server action');
    const credential=body.action==='block'?null:secret();
    await this.db.transaction(async()=>{
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      const row=await this.db.prepare('SELECT * FROM trusted_servers WHERE id=? FOR UPDATE').get(id);
      if(!row)fail(404,'Server not found');
      if(body.action==='rotate'&&row.state!=='approved')fail(409,'Server is not approved');
      await this.db.prepare('UPDATE trusted_servers SET state=?,credential_hash=?,revision=? WHERE id=?').run(credential?'approved':'blocked',credential?hash(credential):null,randomUUID(),id);
      await this.db.prepare('DELETE FROM server_tickets WHERE server_id=?').run(id);
      await this.db.prepare("UPDATE delivery_jobs SET state='cancelled',notification=NULL,reason='ServerAccessChanged',updated=? WHERE registration_id IN (SELECT id FROM registrations WHERE server_id=?) AND state IN ('queued','retrying','sending')").run(this.now(),id);
      await this.db.prepare('DELETE FROM registrations WHERE server_id=?').run(id);
    });
    return {id,state:credential?'approved':'blocked',...(credential?{credential}:{})};
  }
  async authenticateServer(credential,appId,serverId) {
    if(typeof credential!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(credential))fail(403,'Server credential required');
    const row=await this.db.prepare('SELECT * FROM trusted_servers WHERE credential_hash=?').get(hash(credential));
    if(!row||row.state!=='approved'||row.id!==serverId||!row.apps.includes(appId))fail(403,'Server not authorized');
    return row;
  }
  async ticket(credential,body) {
    if(!validID(body.appId)||!validID(body.deviceId)||!validID(body.serverId))fail(400,'Invalid ticket request');
    const ticket=secret(),expiresAt=this.now()+300000;
    await this.db.transaction(async()=>{
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      const row=await this.authenticateServer(credential,body.appId,body.serverId);
      await this.policy(body.appId);
      await this.abuse.quota('tickets:global',20000,86400000,'server_ticket_quota');
      await this.abuse.quota('tickets:server:'+row.id,5000,86400000,'server_ticket_quota');
      if((await this.db.prepare('SELECT count(*) n FROM server_tickets WHERE expires>?').get(this.now())).n>=2000)fail(503,'Server ticket capacity reached');
      await this.db.prepare('INSERT INTO server_tickets VALUES(?,?,?,?,?,?)').run(hash(ticket),row.id,body.appId,body.deviceId,row.revision,expiresAt);
    });
    return {ticket,expiresAt};
  }
  async registrationServer(body,policy,consume=false) {
    const row=await this.db.prepare('SELECT * FROM trusted_servers WHERE id=?').get(body.serverId);
    if(row?.state==='blocked')fail(403,'Server blocked');
    if(!body.serverTicket) {if(policy.settings.requireTrustedServers)fail(403,'Server ticket required');return null;}
    if(typeof body.serverTicket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.serverTicket))fail(403,'Invalid server ticket');
    const ticket=await this.db.prepare('SELECT * FROM server_tickets WHERE hash=? AND expires>?').get(hash(body.serverTicket),this.now());
    if(!ticket||!row||row.state!=='approved'||!row.apps.includes(body.appId??defaultApp)||ticket.server_id!==body.serverId||ticket.device_id!==body.deviceId||ticket.app_id!==(body.appId??defaultApp)||ticket.revision!==row.revision)fail(403,'Invalid server ticket');
    if(consume)await this.db.prepare('DELETE FROM server_tickets WHERE hash=?').run(hash(body.serverTicket));
    return {id:row.id,revision:row.revision};
  }
  async registrationEnabled(appId) {
    if(!this.abuse.settings.registrationEnabled || !(await this.abuse.effective(appId)).registrationEnabled)
      this.abuse.reject('registration_paused',300,503);
  }
  async challenge(body,address) {
    const registration=body.registration, binding=registrationBinding(registration??{}),appId=registration.appId??defaultApp,channel=registration.channel??'apns';
    if(!this.abuse.memory('integrity:challenge:'+address,20)||!this.abuse.memory('integrity:challenge:global',300))this.abuse.reject('integrity_challenge_rate');
    return this.db.transaction(async()=>{
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      const policy=await this.policy(appId);await this.registrationEnabled(appId);await this.registrationServer(registration,policy);
      if(!(channel==='apns'?policy.settings.iosRequired:policy.settings.androidRequired))return {required:false};
      if((await this.db.prepare('SELECT count(*) n FROM integrity_challenges WHERE expires>?').get(this.now())).n>=2000)this.abuse.reject('integrity_challenge_capacity',60,503);
      const id=randomUUID(),payload='relay-register-v1:'+secret()+':'+binding,expiresAt=this.now()+300000;
      const keyKnown=typeof body.keyId==='string'&&!!await this.db.prepare('SELECT 1 FROM integrity_keys WHERE app_id=? AND key_id=? AND revision=? AND expires>?').get(appId,body.keyId,policy.revision,this.now());
      await this.db.prepare('INSERT INTO integrity_challenges VALUES(?,?,?,?,?,?,?)').run(id,appId,channel,binding,payload,policy.revision,expiresAt);
      return {required:true,id,payload,expiresAt,keyKnown,requestHash:createHash('sha256').update(payload).digest('base64url'),cloudProjectNumber:policy.settings.cloudProjectNumber};
    });
  }
  async prepareRegistration(body,address) {
    const appId=body.appId??defaultApp,channel=body.channel??'apns',binding=registrationBinding(body);
    const policy=await this.policy(appId),required=channel==='apns'?policy.settings.iosRequired:policy.settings.androidRequired;
    await this.registrationEnabled(appId);
    await this.registrationServer(body,policy);
    let verified;
    if(required) {
      const proof=body.integrity;
      if(!proof||!validID(proof.challengeId))fail(403,'Application proof required');
      if(this.verifying>=4||!this.abuse.memory('integrity:verify:'+address,20)||!this.abuse.memory('integrity:verify:global',120))this.abuse.reject('integrity_verification_rate',60,503);
      this.verifying++;
      try {
        // Count failed/remote verification attempts too; these quotas commit independently.
        await this.db.transaction(async()=>{await this.abuse.quota('integrity:global',10000,86400000,'integrity_daily');await this.abuse.quota('integrity:app:'+appId,5000,86400000,'integrity_daily');});
        const challenge=await this.db.prepare('DELETE FROM integrity_challenges WHERE id=? AND app_id=? AND binding=? AND channel=? AND revision=? AND expires>? RETURNING *').get(proof.challengeId,appId,binding,channel,policy.revision,this.now());
        if(!challenge)fail(403,'Application challenge expired or used');
        if(channel==='apns') {
          const key=typeof proof.keyId==='string'?await this.db.prepare('SELECT * FROM integrity_keys WHERE app_id=? AND key_id=? AND revision=? AND expires>?').get(appId,proof.keyId,policy.revision,this.now()):null;
          const result=await this.appleVerifier({proof,payload:challenge.payload,policy:policy.settings,key,now:this.now()});
          verified={keyId:proof.keyId,result,previous:key?.counter??null};
        } else {
          if(!policy.secret)fail(503,'Application verification not configured');
          await this.google.verify({proof,payload:challenge.payload,policy:policy.settings,credential:JSON.parse(this.open(policy.secret))});
        }
      } finally {this.verifying--;}
    }
    return this.db.transaction(async()=>{
      await this.db.query('SELECT pg_advisory_xact_lock(72841104)');
      if((await this.policy(appId)).revision!==policy.revision)fail(409,'Access policy changed');
      const server=await this.registrationServer(body,policy,true);
      if(verified) {
        const {keyId,result,previous}=verified;
        const current=await this.db.prepare('SELECT * FROM integrity_keys WHERE app_id=? AND key_id=?').get(appId,keyId);
        if(current && (previous===null || current.counter!==previous || result.counter<=current.counter))fail(403,'Application assertion replayed');
        if(!current&&previous!==null)fail(403,'Application key expired');
        if(!current&&(await this.db.prepare('SELECT count(*) n FROM integrity_keys').get()).n>=100000)this.abuse.reject('integrity_key_capacity',60,503);
        await this.db.prepare('INSERT INTO integrity_keys VALUES(?,?,?,?,?,?) ON CONFLICT(app_id,key_id) DO UPDATE SET counter=excluded.counter,expires=excluded.expires').run(appId,keyId,result.publicKey,result.counter,policy.revision,this.now()+90*86400000);
      }
      return {revision:policy.revision,server};
    });
  }
  async commitRegistration(body,grant) {
    if((await this.policy(body.appId??defaultApp)).revision!==grant.revision)fail(409,'Access policy changed');
    const row=await this.db.prepare('SELECT * FROM trusted_servers WHERE id=?').get(body.serverId);
    if(row?.state==='blocked'||grant.server&&(!row||row.state!=='approved'||row.revision!==grant.server.revision))fail(403,'Server blocked or changed');
  }
  async delivery(req,entry) {
    const policy=await this.policy(entry.app_id);
    const row=await this.db.prepare('SELECT state FROM trusted_servers WHERE id=?').get(entry.server_id);
    if(row?.state==='blocked')fail(403,'Server blocked');
    if(policy.settings.requireTrustedServers||entry.trusted_server)await this.authenticateServer(req.headers['x-relay-server-credential'],entry.app_id,entry.server_id);
  }
  async active(entry) {
    const row=await this.db.prepare('SELECT state FROM trusted_servers WHERE id=?').get(entry.server_id);
    return row?.state!=='blocked'&&(!entry.trusted_server||row?.state==='approved');
  }
}
