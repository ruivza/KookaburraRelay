import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
const titles=source.slice(source.indexOf('const getTitles'),source.indexOf('const getStates'));
const channels=source.slice(source.indexOf('function renderChannels('),source.indexOf('function filters('));
const load=source.slice(source.indexOf('async function load('),source.indexOf('function modal('));
function page(hash) {
 const elements={content:{innerHTML:'',querySelectorAll:()=>[]},breadcrumb:{textContent:''}};
 const context=vm.createContext({
  location:{hash},URLSearchParams,document:{querySelectorAll:()=>[]},elements,
  t:s=>s,html:(parts,...values)=>parts.reduce((out,part,i)=>out+part+(values[i]??''),''),
  api:async path=>path==='/admin/apps'?{applications:[],channels:[]}:{},
  renderOverview:()=>'<div>Overview</div>',renderList:()=>'<div>Records</div>',
  heading:(title,description)=>'<h1>'+title+'</h1><p>'+description+'</p>',
  empty:(title,description)=>'<p>'+title+'</p>'+description,notice(){},translateError:s=>s,
 });
 vm.runInContext(source.match(/^const esc = .*$/m)[0]+titles+
   "const $=id=>elements[id];let token='test-session',current='overview',navigation=0,epoch=0,apps=[],catalog=[],lastData,language='zh';const disclosureState=new Map();"+
   channels+load,context);
 return {run:code=>vm.runInContext(code,context),elements};
}

test('hash input cannot become channel back-link markup through the load route',async()=>{
 for(const hash of ['#apns?appId=fixture','#android?appId=fixture','#apns"><img src=x onerror=alert(1)>?appId=fixture','#android%22%3E%3Csvg%20onload=alert(1)%3E?appId=fixture']){
  const p=page(hash);await p.run('load()');
  assert.ok(!/<(?:img|svg)\b/i.test(p.elements.content.innerHTML));
  if(hash.startsWith('#apns?'))assert.match(p.elements.content.innerHTML,/href="#apns"/);
  else if(hash.startsWith('#android?'))assert.match(p.elements.content.innerHTML,/href="#android"/);
  else assert.equal(p.run('current'),'overview');
 }
});

test('unknown and inherited object properties are rejected as UI routes',async()=>{
 for(const requested of ['unknown','constructor','__proto__','toString','hasOwnProperty']){
  const p=page('#'+requested);await p.run('load()');assert.equal(p.run('current'),'overview');
 }
});

test('channel back-links depend on the rendered channel rather than mutable navigation state',()=>{
 const p=page('#apns?appId=fixture');
 p.run('current = '+JSON.stringify('"><img src=x onerror=alert(1)>'));
 for(const [kind,route]of [['apns','apns'],['fcm','android']]){
  const markup=p.run('renderChannels('+JSON.stringify(kind)+')');
  assert.match(markup,new RegExp('href="#'+route+'"'));
  assert.ok(!/<img\b/i.test(markup));
 }
});
