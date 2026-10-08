import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartModel,nearestPoint,initializeCharts,renderChart,renderStackedChart} from '../public/monitor-charts.js';
test('chart scale contains real values, integer counts and zero series',()=>{
 for(const [key,values] of [['rss',[80,113.45]],['latency',[.003,.017]],['requests',[0,1]],['queued',[0,0]]]){
  const m=chartModel(values.map((value,i)=>({time:100000+i*60000,[key]:value})),key);
  assert(m.ceiling>=Math.max(...values));assert(m.ceiling>0);assert.equal(m.ticks[0].value,0);
  if(['requests','queued'].includes(key))assert(m.ticks.every(t=>Number.isInteger(t.value)));
  assert(m.segments.flat().every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 }
});
test('charts preserve gaps and do not invent latency during idle minutes',()=>{
 const samples=[{time:0,latency:12,requests:2},{time:60000,latency:0,requests:0},{time:120000,latency:20,requests:1},{time:600000,latency:40,requests:1}];
 const m=chartModel(samples,'latency');assert.equal(m.segments.length,3);assert.equal(m.points[1].value,null);
 assert.equal(nearestPoint(m.points,300000),null);assert.equal(nearestPoint(m.points,118000),2);
 assert.equal(nearestPoint([],0),null);
});
test('charts provide units, accessible navigation and escaped data',()=>{
 const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
 initializeCharts({t:x=>x,esc,stamp:x=>'time '+x});
 const output=renderChart([{time:60000,rss:123.45}],'rss','memory <unsafe>');
 assert(output.includes('MB'));assert(output.includes('chart-axis'));assert(output.includes('tabindex="0"'));assert(!output.includes('<unsafe>'));
 assert(!output.includes('NaN'));assert(!renderChart([],'rss','empty').includes('<svg'));
});

test('stacked queues preserve real time gaps and expose every state accessibly',()=>{
 initializeCharts({t:x=>x,esc:s=>String(s).replaceAll('"','&quot;').replaceAll('<','&lt;'),stamp:String});
 const output=renderStackedChart([{time:0,queued:1,sending:2},{time:600000,queued:0,sending:3}], [{key:'queued',label:'Waiting',color:'blue'},{key:'sending',label:'Sending',color:'green'}],'Queue',60000);
 assert(output.includes('Waiting: 1 / Sending: 2'));assert(output.includes('tabindex="0"'));assert(!output.includes('NaN'));
 assert.match(output,/x="509\.09/);
 assert(!output.includes('style="'));
});
