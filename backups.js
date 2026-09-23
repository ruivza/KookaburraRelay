import {randomUUID} from 'node:crypto';
import {storageSettings,validateTarget} from './storage-target.js';
export {validateTarget} from './storage-target.js';
import {validateRecipient} from './backup-crypto.js';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export const backupDefaults={enabled:false,endpoint:'',bucket:'',prefix:'kookaburra-relay',keyId:'',recipient:'',intervalHours:24,retentionDays:14};
export class Backups {
  constructor({db,seal,open,security,now=Date.now,validateKey=validateRecipient}){Object.assign(this,{db,seal,open,security,now,validateKey});}
  async initialize(){
    if(await this.row())return;
    const interval=Number(process.env.GATEWAY_BACKUP_INTERVAL_SECONDS||86400)/3600;
    const retention=Number(process.env.GATEWAY_BACKUP_RETENTION_DAYS||14);
    if(!Number.isInteger(interval)||interval<1||interval>168||!Number.isInteger(retention)||retention<1||retention>365)throw Error('Invalid initial backup schedule');
    await this.db.prepare('INSERT INTO backup_settings VALUES(1,?,NULL,?) ON CONFLICT DO NOTHING').run(JSON.stringify({...backupDefaults,intervalHours:interval,retentionDays:retention,revision:randomUUID()}),this.now());
  }
  async row(){const row=await this.db.prepare('SELECT * FROM backup_settings WHERE id=1').get();return row?{...row,settings:storageSettings(row.settings)}:row;}
  async status(){
    const row=await this.row(),worker=await this.db.prepare('SELECT heartbeat FROM backup_worker WHERE id=1').get();
    return {settings:{...row.settings,hasApplicationKey:!!row.secret},nextAt:row.next_at,workerOnline:!!worker&&worker.heartbeat>this.now()-120000,
      twoFactorEnabled:(await this.security.status()).twoFactorEnabled,
      remoteCheck:await this.db.prepare("SELECT remote_status,COALESCE(finished,created) AS finished FROM backup_jobs WHERE config_revision=? AND remote_status IN ('completed','failed') ORDER BY COALESCE(finished,created) DESC,id DESC LIMIT 1").get(row.settings.revision),
      lastLocalSuccess:(await this.db.prepare("SELECT max(local_completed) time FROM backup_jobs WHERE local_status='completed'").get()).time,
      lastRemoteSuccess:(await this.db.prepare("SELECT max(finished) time FROM backup_jobs WHERE remote_status='completed' AND kind='backup' AND config_revision=?").get(row.settings.revision)).time,
      jobs:await this.db.prepare('SELECT * FROM backup_jobs ORDER BY created DESC,id DESC LIMIT 30').all()};
  }
  async save(body){
    const input=body.settings;
    if(!input||typeof input.enabled!=='boolean')fail(400,'Invalid backup settings');
    const settings=storageSettings({});for(const key of [...Object.keys(backupDefaults),'provider','region','forcePathStyle','fixedFileName'])settings[key]=input[key];
    Object.assign(settings,storageSettings(settings));
    if(!Number.isInteger(settings.intervalHours)||settings.intervalHours<1||settings.intervalHours>168||!Number.isInteger(settings.retentionDays)||settings.retentionDays<1||settings.retentionDays>365)fail(400,'Invalid backup schedule');
    for(const k of ['endpoint','bucket','prefix','keyId','recipient'])if(typeof settings[k]!=='string')fail(400,'Invalid backup settings');
    settings.endpoint=settings.endpoint.trim().replace(/\/$/,'');
    if(typeof settings.region==='string')settings.region=settings.region.trim();
    for(const k of ['bucket','prefix','keyId','recipient'])settings[k]=settings[k].trim();
    if(!['b2','r2','aws','custom'].includes(settings.provider)||typeof settings.forcePathStyle!=='boolean'||typeof settings.fixedFileName!=='boolean')fail(400,'Invalid storage provider');
    const hasTarget=settings.enabled||['endpoint','bucket','keyId','recipient'].some(k=>settings[k]);
    if(hasTarget){validateTarget(settings);await this.validateKey(settings.recipient);}
    if(body.applicationKey!==undefined&&(typeof body.applicationKey!=='string'||body.applicationKey.length>256||/\s/.test(body.applicationKey)))fail(400,'Invalid S3 Secret Access Key');
    await this.db.transaction(async()=>{
      await this.security.reauthenticate(await this.security.row(),body);
      const row=await this.db.prepare('SELECT * FROM backup_settings WHERE id=1 FOR UPDATE').get();
      if(body.revision!==row.settings.revision)fail(409,'Backup settings changed; refresh and try again');
      if(await this.db.prepare("SELECT 1 FROM backup_jobs WHERE state='running'").get())fail(409,'Backup worker is busy; wait before changing settings');
      const replacement=body.applicationKey||'';
      if(replacement&&replacement.length<8)fail(400,'Invalid S3 Secret Access Key');
      if(row.secret&&!replacement&&((row.settings.provider??'b2')!==settings.provider||row.settings.endpoint!==settings.endpoint||row.settings.bucket!==settings.bucket||row.settings.keyId!==settings.keyId))fail(400,'Enter a new Secret Access Key when changing the storage destination');
      const secret=replacement?this.seal(replacement):row.secret;
      if(hasTarget&&!secret)fail(400,'S3 Secret Access Key is required');
      settings.revision=randomUUID();
      await this.db.prepare('UPDATE backup_settings SET settings=?,secret=?,next_at=? WHERE id=1').run(JSON.stringify(settings),secret,this.now()+settings.intervalHours*3600000);
      await this.db.prepare("UPDATE backup_jobs SET state='cancelled',finished=?,error='ConfigurationChanged' WHERE state IN ('queued','retrying')").run(this.now());
    });
    return this.status();
  }
  async enqueue(kind='backup',source='manual'){
    if(!['backup','test'].includes(kind))fail(400,'Invalid backup operation');
    return this.db.transaction(async()=>{
      const row=await this.db.prepare('SELECT * FROM backup_settings WHERE id=1 FOR UPDATE').get();
      if(kind==='test'){validateTarget(row.settings);if(!row.secret||!row.settings.recipient)fail(400,'Save storage credentials and public key first');}
      if(await this.db.prepare("SELECT 1 FROM backup_jobs WHERE state IN ('queued','running','retrying') AND kind=?").get(kind))fail(409,'A backup operation is already pending');
      return this.insert(row,kind,source);
    });
  }
  async insert(row,kind,source){
    const id=randomUUID();
    await this.db.prepare("INSERT INTO backup_jobs(id,kind,source,state,created,next_at,config_revision,remote_status) VALUES(?,?,?,'queued',?,?,?,?)").run(id,kind,source,this.now(),this.now(),row.settings.revision,kind==='test'||row.settings.enabled?'pending':'disabled');
    return this.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(id);
  }
  async retry(id){
    return this.db.transaction(async()=>{
      const row=await this.db.prepare('SELECT * FROM backup_settings WHERE id=1 FOR UPDATE').get();
      const job=await this.db.prepare('SELECT * FROM backup_jobs WHERE id=? FOR UPDATE').get(id);
      if(!job||!['failed','retrying'].includes(job.state))fail(409,'This backup cannot be retried');
      if(job.config_revision!==row.settings.revision)fail(409,'Backup target changed; create a new backup');
      if(await this.db.prepare("SELECT 1 FROM backup_jobs WHERE state IN ('queued','running','retrying') AND id<>? AND kind=?").get(id,job.kind))fail(409,'A backup operation is already pending');
      await this.db.prepare("UPDATE backup_jobs SET state='queued',attempts=0,next_at=?,finished=NULL,error='' WHERE id=?").run(this.now(),id);
      return this.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(id);
    });
  }
}
