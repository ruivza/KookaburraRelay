import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { UptimeProbe } from '../scripts/uptime-probe.mjs';
test('external probe spools outages and uploads observations on recovery without fabricated uptime',async()=>{
  const db=new DatabaseSync(':memory:');let online=false,time=Date.now(),uploaded;
  const p=new UptimeProbe({db,origin:'https://gateway.example.test',credential:'m'.repeat(43),now:()=>time,fetcher:async(url,opts)=>{
    if(!online)throw Error('offline');
    if(url.endsWith('/healthz'))return Response.json({status:'ok'});
    uploaded=JSON.parse(opts.body);return Response.json({recorded:uploaded.samples.length});
  }});
  try {
    assert.equal((await p.tick()).pending,1);time+=60000;online=true;
    assert.equal((await p.tick()).pending,0);
    assert.deepEqual(uploaded.samples.map(s=>s.ok),[false,true]);
    assert.throws(()=>new UptimeProbe({db,origin:'http://remote.test',credential:'m'.repeat(43)}));
  }finally{db.close();}
});
