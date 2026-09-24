import {randomUUID} from 'node:crypto';
const DAY=86400000;
export const defaults={enabled:true,intervalHours:24,requestsDays:14,errorsDays:30,auditDays:90,jobsDays:30,metricsDays:30,probesDays:30,runsDays:30};
const kinds=['requests','errors','audit','jobs','metrics','probes','runs','expired'];
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export class Maintenance {
 constructor({db,now=Date.now,runId}){Object.assign(this,{db,now,runId});this.busy=false;}
 validate(value){
  if(!value||typeof value.enabled!=='boolean')fail(400,'Invalid retention settings');
  const settings={enabled:value.enabled};
  for(const key of Object.keys(defaults).filter(k=>k!=='enabled')){const n=value[key];if(!Number.isInteger(n)||n<1||n>(key==='intervalHours'?168:3650))fail(400,'Invalid retention settings');settings[key]=n;}
  return settings;
 }
 async initialize(autoStart){
  await this.db.prepare('INSERT INTO maintenance_settings VALUES(1,?,?) ON CONFLICT DO NOTHING').run(JSON.stringify(defaults),this.now()+defaults.intervalHours*3600000);
  await this.db.prepare("UPDATE maintenance_runs SET status='failed',finished=?,error='Interrupted by restart' WHERE status='running'").run(this.now());
  if(autoStart)this.timer=setInterval(()=>{void this.tick().catch(()=>console.error('Maintenance scheduler failed'));},60000).unref();
 }
 async state(){const row=await this.db.prepare('SELECT * FROM maintenance_settings WHERE id=1').get();return {settings:row.settings,nextAt:row.settings.enabled?row.next_at:null,running:this.busy,databaseBytes:(await this.db.query('SELECT pg_database_size(current_database()) bytes')).rows[0].bytes,runs:await this.db.prepare('SELECT * FROM maintenance_runs ORDER BY started DESC LIMIT 20').all()};}
 plan(settings,types=kinds,before=null){
  const now=this.now(),cut=k=>before??now-settings[k+'Days']*DAY;
  const plans={requests:[['gateway_logs',"kind='request' AND time<?",[cut('requests')]]],errors:[['gateway_logs',"kind='error' AND time<?",[cut('errors')]]],audit:[['gateway_logs',"kind='audit' AND time<?",[cut('audit')]]],jobs:[['delivery_jobs',"state NOT IN ('queued','retrying','sending') AND updated<?",[cut('jobs')]]],metrics:[['gateway_samples','time<?',[cut('metrics')]],['gateway_queue_samples','time<?',[cut('metrics')]]],probes:[['gateway_probes','time<?',[cut('probes')]]],runs:[['gateway_runs','heartbeat<? AND id<>?',[cut('runs'),this.runId]]],expired:[['registrations','expires<=?',[now]],['admin_sessions','expires<=?',[now]],['limits','start<?',[now-3600000]]]};
  return types.flatMap(kind=>plans[kind].map(([table,where,values])=>({kind,table,where,values})));
 }
 async preview(body){
  const current=(await this.state()).settings;
  const mode=body.mode==='settings'?'settings':'cleanup',settings=mode==='settings'?this.validate(body.settings):current;
  const types=mode==='settings'?kinds:body.types;
  if(!Array.isArray(types)||!types.length||types.some(t=>!kinds.includes(t))||new Set(types).size!==types.length)fail(400,'Invalid cleanup selection');
  const before=body.before==null?null:Number(body.before);
  if(before!==null&&(!Number.isSafeInteger(before)||before<0||before>this.now()||mode==='settings'))fail(400,'Invalid cleanup cutoff');
  const plan=this.plan(settings,types,before),counts={};
  for(const p of plan)counts[p.kind]=(counts[p.kind]||0)+(await this.db.prepare(`SELECT count(*) n FROM ${p.table} WHERE ${p.where}`).get(...p.values)).n;
  const id=randomUUID(),expires=this.now()+300000;
  await this.db.prepare('DELETE FROM maintenance_previews WHERE expires<=?').run(this.now());
  await this.db.prepare('INSERT INTO maintenance_previews VALUES(?,?,?)').run(id,expires,JSON.stringify({mode,settings,plan}));
  return {previewId:id,expires,counts};
 }
 async consume(id,mode){const row=await this.db.prepare('DELETE FROM maintenance_previews WHERE id=? AND expires>? RETURNING payload').get(typeof id==='string'?id:'',this.now());if(!row||row.payload.mode!==mode)fail(409,'Cleanup preview expired; preview again');return row.payload;}
 async save(id){const p=await this.consume(id,'settings');await this.db.prepare('UPDATE maintenance_settings SET settings=?,next_at=? WHERE id=1').run(JSON.stringify(p.settings),this.now()+p.settings.intervalHours*3600000);return this.state();}
 async tick(){if(this.busy||this.stopping)return;const row=await this.db.prepare('SELECT * FROM maintenance_settings WHERE id=1').get();if(row.settings.enabled&&row.next_at<=this.now())await this.start(this.plan(row.settings),'automatic');}
 async manual(id){if(this.busy)fail(409,'Cleanup is already running');const p=await this.consume(id,'cleanup');return this.start(p.plan,'manual');}
 async start(plan,source){
  if(this.busy||this.stopping)fail(409,'Cleanup is already running');this.busy=true;
  let client,locked=false;
  try{
   client=await this.db.pool.connect();const lock=await client.query('SELECT pg_try_advisory_lock(hashtext(current_schema()),72841105) locked');locked=lock.rows[0].locked;if(!locked)fail(409,'Cleanup is already running');
   const id=randomUUID();await this.db.prepare("INSERT INTO maintenance_runs(id,started,source,status) VALUES(?,?,?,'running')").run(id,this.now(),source);
   await this.db.prepare("UPDATE maintenance_settings SET next_at=?+(settings->>'intervalHours')::bigint*3600000 WHERE id=1").run(this.now());
   this.work=this.execute(id,plan,client).finally(()=>{this.busy=false;});return {id,status:'running'};
  }catch(error){if(locked)await client.query('SELECT pg_advisory_unlock(hashtext(current_schema()),72841105)').catch(()=>{});client?.release();this.busy=false;throw error;}
 }
 async execute(id,plan,client){
  const deleted={};let partial=false;
  try{
   for(const p of plan){
    deleted[p.kind]??=0;
    for(let i=0;i<200;i++){
     if(this.stopping){partial=true;break;}
     const result=await this.db.prepare(`WITH batch AS (SELECT ctid FROM ${p.table} WHERE ${p.where} LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM ${p.table} WHERE ctid IN (SELECT ctid FROM batch)`).run(...p.values);
     deleted[p.kind]+=result.changes;
     await this.db.prepare('UPDATE maintenance_runs SET deleted=? WHERE id=?').run(JSON.stringify(deleted),id);
     if(result.changes<1000)break;if(i===199)partial=true;
     await new Promise(resolve=>setTimeout(resolve,20));
    }
   }
   await this.db.prepare('UPDATE admin_security SET pending_secret=NULL,pending_until=NULL WHERE pending_until<=?').run(this.now());
   await this.db.prepare('DELETE FROM maintenance_previews WHERE expires<=?').run(this.now());
   await this.db.prepare('UPDATE maintenance_runs SET status=?,finished=? WHERE id=?').run(partial?'partial':'completed',this.now(),id);
   await this.db.exec("DELETE FROM maintenance_runs WHERE id IN (SELECT id FROM maintenance_runs WHERE status<>'running' ORDER BY started DESC OFFSET 100)");
  }catch(error){console.error('Maintenance failed:',error.code||'unknown');await this.db.prepare("UPDATE maintenance_runs SET status='failed',finished=?,deleted=?,error='Database cleanup failed; check service logs' WHERE id=?").run(this.now(),JSON.stringify(deleted),id).catch(()=>{});}
  finally{await client.query('SELECT pg_advisory_unlock(hashtext(current_schema()),72841105)').catch(()=>{});client.release();}
 }
 async close(){this.stopping=true;clearInterval(this.timer);await this.work;}
}
