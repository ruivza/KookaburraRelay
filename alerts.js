import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
import {createHmac,randomUUID} from 'node:crypto';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export const alertDefaults=Object.freeze({enabled:false,rejections:100,queueDepth:1000,oldestSeconds:300,failures:10,cooldownSeconds:900});
export function webhookURL(value) {
  let url;try{url=new URL(value);}catch{fail(400,'Invalid webhook URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href.length>2048||!url.hostname||url.port&&url.port!=='443')fail(400,'Webhook requires an HTTPS URL on port 443');
  return url;
}
export async function sendWebhook({url,secret,payload,id},resolver=lookup) {
  const endpoint=webhookURL(url);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const addresses=await Promise.race([resolver(endpoint.hostname,{all:true}),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('Webhook timeout')),{once:true}))]);
    if(!addresses.length||addresses.some(({address})=>!ipaddr.isValid(address)||ipaddr.process(address).range()!=='unicast'))throw Error('Webhook requires public addresses');
    if(controller.signal.aborted)throw Error('Webhook timeout');
    const address=addresses[0].address,body=JSON.stringify(payload);
    await new Promise((resolve,reject)=>{
      const req=https.request(endpoint,{method:'POST',signal:controller.signal,
        lookup:(_host,options,done)=>options.all?done(null,[{address,family:isIP(address)}]):done(null,address,isIP(address)),
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Relay-Event-ID':id,
          ...(secret?{'X-Relay-Signature':'sha256='+createHmac('sha256',secret).update(body).digest('hex')}:{})}},res=>{
          let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>8192)res.destroy(Error('Webhook response too large'));});
          res.on('error',reject);res.on('end',()=>res.statusCode>=200&&res.statusCode<300?resolve():reject(Error('Webhook rejected')));
        });
      req.on('error',reject);req.end(body);
    });
  } finally {clearTimeout(timer);}
}
export class Alerts {
  constructor({db,seal,open,abuse,monitor,now=Date.now,sender=sendWebhook}) {Object.assign(this,{db,seal,open,abuse,monitor,now,sender});}
  async initialize(autoStart=true) {
    await this.db.prepare('INSERT INTO alert_settings VALUES(1,?,NULL,?) ON CONFLICT DO NOTHING').run(JSON.stringify(alertDefaults),randomUUID());
    if(autoStart)this.timer=setInterval(()=>{void this.tick().catch(()=>{this.workerFailed=true;});},60000).unref();
  }
  async row(){return this.db.prepare('SELECT * FROM alert_settings WHERE id=1').get();}
  async state(){const row=await this.row(),secret=row.secret?JSON.parse(this.open(row.secret)):null;return {settings:row.settings,configured:!!secret,host:secret?new URL(secret.url).hostname:'',hasSigningSecret:!!secret?.secret,workerFailed:!!this.workerFailed,
    recent:await this.db.prepare('SELECT id,created,kind,state,attempts,error FROM alert_notifications ORDER BY created DESC LIMIT 30').all()};}
  async save(body) {
    const s={...alertDefaults,...body.settings};
    if(!body.settings||typeof body.settings!=='object'||Object.keys(body.settings).some(k=>!(k in alertDefaults))||typeof s.enabled!=='boolean')fail(400,'Invalid alert settings');
    for(const key of ['rejections','queueDepth','oldestSeconds','failures','cooldownSeconds'])if(!Number.isSafeInteger(s[key])||s[key]<1||s[key]>10000000)fail(400,'Invalid alert settings');
    if(s.cooldownSeconds<60||s.cooldownSeconds>86400)fail(400,'Invalid alert cooldown');
    const previous=await this.row();let secret=previous.secret?JSON.parse(this.open(previous.secret)):null;
    if(body.url) {webhookURL(body.url);secret={url:body.url,secret:body.signingSecret||''};}
    else if(body.signingSecret!==undefined&&body.signingSecret!=='') {if(!secret)fail(400,'Webhook URL required');secret.secret=body.signingSecret;}
    if(secret&&(typeof secret.secret!=='string'||secret.secret.length>512))fail(400,'Invalid webhook signing secret');
    if(s.enabled&&!secret)fail(400,'Webhook URL required');
    await this.db.transaction(async()=>{
      await this.db.prepare('UPDATE alert_settings SET settings=?,secret=?,revision=? WHERE id=1').run(JSON.stringify(s),secret?this.seal(JSON.stringify(secret)):null,randomUUID());
      await this.db.prepare("UPDATE alert_notifications SET state='cancelled' WHERE state='pending'").run();
      await this.db.exec('DELETE FROM alert_incidents');
    });return this.state();
  }
  async enqueue(kind,active,value,row) {
    const current=await this.db.prepare('SELECT * FROM alert_incidents WHERE kind=?').get(kind);
    if(!active&&!current?.active)return;
    if(current?.active===+active&&this.now()-current.last_queued<row.settings.cooldownSeconds*1000)return;
    if((await this.db.prepare("SELECT count(*) n FROM alert_notifications WHERE state='pending'").get()).n>=1000)return;
    const id=randomUUID(),payload={id,kind,state:active?'firing':'resolved',value,time:this.now(),text:`Kookaburra Relay: ${kind} ${active?'firing':'resolved'} (${value})`};
    await this.db.transaction(async()=>{
      await this.db.prepare("INSERT INTO alert_notifications(id,created,kind,state,payload,next_at,revision) VALUES(?,?,?,'pending',?,?,?)").run(id,this.now(),kind,JSON.stringify(payload),this.now(),row.revision);
      await this.db.prepare('INSERT INTO alert_incidents VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET active=excluded.active,last_queued=excluded.last_queued').run(kind,+active,this.now());
    });
  }
  async tick() {
    if(this.running)return this.running;
    this.running=this.perform();try{await this.running;this.workerFailed=false;}finally{this.running=null;}
  }
  async perform() {
    const row=await this.row();
    await this.db.prepare("DELETE FROM alert_notifications WHERE created<? AND state<>'pending'").run(this.now()-7*86400000);
    if(!row.settings.enabled||!row.secret)return;
    // Counters are flushed by the abuse worker. Recent persisted history survives restarts.
    const rejects=(await this.db.prepare('SELECT coalesce(sum(count),0) n FROM abuse_events WHERE time>=?').get(this.now()-300000)).n;
    const queue=await this.monitor.queueStatus();
    const failures=(await this.db.prepare("SELECT count(*) n FROM delivery_jobs WHERE updated>=? AND state IN ('failed','unknown')").get(this.now()-300000)).n;
    const checks=[['rejections',rejects,row.settings.rejections],['queue_depth',queue.queued+queue.retrying,row.settings.queueDepth],['queue_age',queue.oldestWaitSeconds,row.settings.oldestSeconds],['delivery_failures',failures,row.settings.failures]];
    for(const [kind,value,threshold] of checks)await this.enqueue(kind,value>=threshold,value,row);
    const jobs=await this.db.prepare("SELECT * FROM alert_notifications WHERE state='pending' AND next_at<=? ORDER BY created LIMIT 4").all(this.now());
    for(const job of jobs){
      const current=await this.row();
      if(!current.settings.enabled||current.revision!==job.revision){await this.db.prepare("UPDATE alert_notifications SET state='cancelled' WHERE id=?").run(job.id);continue;}
      try{
        await this.sender({...JSON.parse(this.open(current.secret)),payload:job.payload,id:job.id});
        await this.db.prepare("UPDATE alert_notifications SET state='sent',attempts=attempts+1,error='' WHERE id=? AND state='pending'").run(job.id);
      }catch{
        const attempts=job.attempts+1;
        await this.db.prepare("UPDATE alert_notifications SET state=?,attempts=?,next_at=?,error='Webhook delivery failed' WHERE id=? AND state='pending'").run(attempts>=6?'failed':'pending',attempts,this.now()+Math.min(3600000,60000*2**(attempts-1)),job.id);
      }
    }
  }
  async close(){clearInterval(this.timer);await this.running;}
}
