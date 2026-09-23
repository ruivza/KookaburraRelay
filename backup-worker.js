import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,stat,writeFile,rm,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Database} from './database.js';
import {loadEncryption} from './master-key.js';
import {Backups} from './backups.js';
import {S3Storage} from './s3-storage.js';
import {encryptFile} from './backup-crypto.js';
const exec=promisify(execFile);
const exists=async path=>!!await stat(path).catch(()=>null);
const permanent=new Set(['BucketVersioningRequired','VersioningCheckFailed','EncryptionFailed','BackupTooLarge','RemoteObjectConflict','LocalBackupMissing','AccessDenied','BucketOrObjectNotFound']);
function safeError(error){
  const status=error.$metadata?.httpStatusCode;
  if(status===401||status===403)return 'AccessDenied';
  if(status===404)return 'BucketOrObjectNotFound';
  if(status===429)return 'StorageThrottled';
  if(status>=500)return 'StorageUnavailable';
  return ['BucketVersioningRequired','VersioningCheckFailed','EncryptionFailed','BackupTooLarge','RemoteObjectConflict','LocalBackupMissing','LocalBackupFailed','RemoteVerificationFailed'].includes(error.message)?error.message:'BackupOperationFailed';
}
export class BackupWorker {
  constructor({db,backups,root='/backups',now=Date.now,storageFactory=(s,k)=>new S3Storage(s,k),encrypt=encryptFile,localBackup}){
    Object.assign(this,{db,backups,root,now,storageFactory,encrypt});
    this.controller=new AbortController();
    this.localBackup=localBackup|| (async settings=>{
      try {
        const result=await exec('sh',['/ops/backup-once.sh'],{env:{...process.env,BACKUP_RETENTION_DAYS:String(settings.retentionDays),BACKUP_DIR:this.root},signal:this.controller.signal,timeout:600000,maxBuffer:65536});
        const file=result.stdout.match(/Backup completed: (relay-[A-Za-z0-9-]+\.tar)/)?.[1];
        if(!file)throw Error();return file;
      }catch{throw Error('LocalBackupFailed');}
    });
  }
  async initialize(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    await mkdir(resolve(this.root,'.uploads'),{recursive:true,mode:0o700});
    await this.db.prepare("UPDATE backup_jobs SET state='retrying',error='Interrupted',next_at=? WHERE state='running'").run(this.now());
    await this.heartbeat();
  }
  async heartbeat(){
    await this.db.prepare('INSERT INTO backup_worker VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat').run(this.now());
    await writeFile(resolve(this.root,'.worker-heartbeat'),String(Math.floor(this.now()/1000)),{mode:0o600});
  }
  async tick(){
    if(this.controller.signal.aborted)return;
    const claimed=await this.db.transaction(async()=>{
      const row=await this.db.prepare('SELECT * FROM backup_settings WHERE id=1 FOR UPDATE').get();
      if(row.next_at<=this.now()&&!await this.db.prepare("SELECT 1 FROM backup_jobs WHERE kind='backup' AND state IN ('queued','running','retrying')").get()){
        await this.backups.insert(row,'backup','scheduled');
        await this.db.prepare('UPDATE backup_settings SET next_at=? WHERE id=1').run(this.now()+row.settings.intervalHours*3600000);
      }
      await this.db.prepare("UPDATE backup_jobs SET state='cancelled',finished=?,error='ConfigurationChanged' WHERE state IN ('queued','retrying') AND config_revision<>?").run(this.now(),row.settings.revision);
      const job=await this.db.prepare("SELECT * FROM backup_jobs WHERE state IN ('queued','retrying') AND next_at<=? ORDER BY created,id LIMIT 1 FOR UPDATE").get(this.now());
      if(!job)return null;
      await this.db.prepare("UPDATE backup_jobs SET state='running',started=?,attempts=attempts+1 WHERE id=?").run(this.now(),job.id);
      return {job:{...job,attempts:job.attempts+1},row};
    });
    if(claimed)await this.perform(claimed.job,claimed.row);
  }
  async perform(job,row){
    let storage;
    const encrypted=resolve(this.root,'.uploads',job.id+'.age');
    try {
      const s=row.settings;
      if(job.kind==='backup'&&job.local_status!=='completed'){
        job.local_file=await this.localBackup(s);
        if(!/^relay-[A-Za-z0-9-]+\.tar$/.test(job.local_file))throw Error('LocalBackupFailed');
        await this.db.prepare("UPDATE backup_jobs SET local_file=?,local_status='completed',local_completed=? WHERE id=?").run(job.local_file,this.now(),job.id);
        job.local_status='completed';
      }
      if(job.kind==='test'||s.enabled){
        if(!await exists(encrypted)){
          let source;
          if(job.kind==='test'){
            source=resolve(this.root,'.uploads',job.id+'.test');
            await writeFile(source,'Kookaburra Relay encrypted S3 connection test\n',{mode:0o600});
          }else{
            source=resolve(this.root,job.local_file);
            if(!await exists(source))throw Error('LocalBackupMissing');
          }
          try{await this.encrypt(source,encrypted,s.recipient,this.controller.signal);}
          finally{if(job.kind==='test')await rm(source,{force:true});}
        }
        const key=job.remote_key||`${s.prefix}/${job.kind==='test'?'_connection-tests':'archives'}/${s.fixedFileName?(job.kind==='test'?'connection-test':'backup'):job.id}.tar.age`;
        const versioned=!!s.fixedFileName;
        await this.db.prepare("UPDATE backup_jobs SET remote_key=?,remote_status='uploading' WHERE id=?").run(key,job.id);
        // Re-check immediately before sending. Settings cannot change while any
        // job is running; persisted revisions also fence work after a restart.
        if((await this.backups.row()).settings.revision!==job.config_revision)throw Error('ConfigurationChanged');
        storage=this.storageFactory(s,this.backups.open(row.secret));
        const uploaded=await storage.upload(encrypted,key,this.controller.signal,{versioned,backupId:job.id});
        await this.db.prepare("UPDATE backup_jobs SET state='completed',remote_status='completed',bytes=?,finished=?,remote_version=?,error='' WHERE id=?").run(uploaded.bytes,this.now(),uploaded.versionId||null,job.id);
        await rm(encrypted,{force:true});
      } else await this.db.prepare("UPDATE backup_jobs SET state='completed',finished=?,error='' WHERE id=?").run(this.now(),job.id);
    }catch(error){
      const reason=safeError(error),retry=job.attempts<6&&!permanent.has(reason);
      await this.db.prepare("UPDATE backup_jobs SET state=?,finished=?,next_at=?,error=?,local_status=?,remote_status=? WHERE id=?")
        .run(retry?'retrying':'failed',retry?null:this.now(),this.now()+Math.min(3600000,60000*2**(job.attempts-1)),reason,
          job.kind==='test'?'none':job.local_status==='completed'?'completed':'failed',
          job.kind==='test'||row.settings.enabled?'failed':'disabled',job.id);
    }finally{storage?.close();}
  }
  async prune(){
    const row=await this.backups.row(),cutoff=this.now()-row.settings.retentionDays*86400000;
    for(const file of await readdir(resolve(this.root,'.uploads'))){
      if(!/^[a-f0-9-]{36}\.(age|age\.partial|test)$/.test(file))continue;
      const path=resolve(this.root,'.uploads',file),info=await stat(path);
      if(info.mtimeMs>=cutoff)continue;
      const job=await this.db.prepare('SELECT state FROM backup_jobs WHERE id=?').get(file.slice(0,36));
      if(!job||!['running','queued','retrying'].includes(job.state))await rm(path,{force:true});
    }
    await this.db.exec("DELETE FROM backup_jobs WHERE id IN (SELECT id FROM backup_jobs WHERE state IN ('completed','failed','cancelled') ORDER BY created DESC OFFSET 100)");
  }
  stop(){this.controller.abort();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const db=new Database(process.env.GATEWAY_DATABASE_URL,process.env.GATEWAY_DATABASE_SCHEMA||'relay');
  let owner,worker,heartbeat,watchdog,stopping=false;
  const stop=()=>{stopping=true;worker?.stop();watchdog??=setTimeout(()=>process.exit(1),35000);};
  try {
    owner=await db.pool.connect();
    owner.on('error',()=>{process.exitCode=1;stop();});
    const locked=await owner.query('SELECT pg_try_advisory_lock(hashtext(current_schema()),72841106) locked');
    if(!locked.rows[0].locked)throw Error('BackupWorkerAlreadyRunning');
    const encryption=await loadEncryption(db,process.env.GATEWAY_DATA_DIR||'/gateway-data');
    if(stopping)throw Error("BackupOwnershipLost");
    const backups=new Backups({db,...encryption});
    worker=new BackupWorker({db,backups,root:process.env.BACKUP_DIR||'/backups'});
    await worker.initialize();
    heartbeat=setInterval(()=>{void worker.heartbeat().catch(()=>{process.exitCode=1;stop();});},30000);
    for(const sig of ['SIGTERM','SIGINT'])process.once(sig,stop);
    while(!worker.controller.signal.aborted){
      await worker.tick();await worker.prune();
      await delay(5000,undefined,{signal:worker.controller.signal}).catch(()=>{});
    }
  }catch{stop();console.error('Backup worker stopped; check database and backup volume availability');process.exitCode=1;}
  finally{
    clearInterval(heartbeat);worker?.stop();
    try{owner?.release(true);await db.close();}finally{clearTimeout(watchdog);process.exit(process.exitCode||0);}
  }
}
