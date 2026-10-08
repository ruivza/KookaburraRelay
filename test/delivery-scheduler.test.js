import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeliveryQueue} from '../src/delivery.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(count=6){
  const jobs=Array.from({length:count},(_,i)=>({id:String(i),state:'queued'}));
  const queue=new DeliveryQueue({autoStart:false,concurrency:2,db:{prepare(){return {all:async(...args)=>jobs.filter(j=>j.state==='queued'&&!args.slice(1,-1).includes(j.id)).slice(0,args.at(-1))};}}});
  const first=deferred(),started=[],fifth=deferred();
  queue.perform=async id=>{jobs[Number(id)].state='sending';started.push(id);if(id==='0')await first.promise;jobs[Number(id)].state='accepted';if(id==='5')fifth.resolve();};
  return {queue,jobs,first,started,fifth};
}
test('free slots refill while another provider request is still blocked',async()=>{
  const f=fixture();const running=f.queue.flush();
  try{
    await Promise.race([f.fifth.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Queue waited for the slow first request')),500))]);
    assert.equal(f.jobs[0].state,'sending');
    assert.deepEqual(f.started,['0','1','2','3','4','5']);
    assert.ok(f.queue.slots.size<=2);
  }finally{f.first.resolve();await running;await f.queue.close();}
});
test('overlapping drains never duplicate a job or exceed available slots',async()=>{
  const f=fixture();const one=f.queue.flush(),two=f.queue.flush();
  f.first.resolve();await Promise.all([one,two]);
  assert.equal(new Set(f.started).size,6);assert.equal(f.started.length,6);
  await f.queue.close();
});
test('close stops refill and waits for the admitted provider request',async()=>{
  const f=fixture();const running=f.queue.flush();
  while(!f.started.length)await new Promise(r=>setImmediate(r));
  const closing=f.queue.close();const count=f.started.length;
  f.first.resolve();await Promise.all([running,closing]);
  assert.equal(f.started.length,count);assert.equal(f.queue.slots.size,0);
});
test('executor failure ends the drain without spinning or leaking slots',async()=>{
  const f=fixture(1);f.queue.perform=async()=>{throw Error('database unavailable');};
  await assert.rejects(f.queue.flush(),/database unavailable/);
  assert.equal(f.queue.slots.size,0);await f.queue.close();
});

test('starting the worker drains immediately without waiting for the one-second timer',async()=>{
  const f=fixture(1);f.queue.start();
  try {
    await new Promise(r=>setTimeout(r,30));
    assert.deepEqual(f.started,['0']);
  } finally { f.first.resolve();await f.queue.close(); }
});
test('background database failure waits for the timer instead of hot-looping',async()=>{
  const f=fixture(1);let attempts=0;
  f.queue.perform=async()=>{attempts++;throw Error('database unavailable');};
  f.queue.start();
  try{await new Promise(r=>setTimeout(r,50));assert.equal(attempts,1);assert.equal(f.queue.failures,1);}
  finally{await f.queue.close();}
});
