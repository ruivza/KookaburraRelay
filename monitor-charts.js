let ctx;
const LEFT=62,RIGHT=626,TOP=24,BOTTOM=178,WIDTH=640,HEIGHT=210;
export function chartModel(samples,key){
 const points=samples.map(s=>({time:Number(s.time),value:s[key]==null||(key==='latency'&&Number(s.requests)===0)?null:Number(s[key])})).filter(p=>Number.isFinite(p.time)).sort((a,b)=>a.time-b.time);
 const values=points.filter(p=>Number.isFinite(p.value)&&p.value>=0),max=Math.max(0,...values.map(p=>p.value));
 const raw=(max||1)/4,power=10**Math.floor(Math.log10(raw)),fraction=raw/power;
 let step=[1,2,2.5,5,10].find(n=>n>=fraction)*power;
 if(['requests','queued'].includes(key))step=Math.max(1,Math.ceil(step));
 const ceiling=Math.ceil((max||1)/step)*step,minTime=points[0]?.time??0,maxTime=points.at(-1)?.time??minTime,span=Math.max(60000,maxTime-minTime);
 const x=time=>LEFT+(time-minTime)/span*(RIGHT-LEFT),y=value=>BOTTOM-value/ceiling*(BOTTOM-TOP);
 const segments=[];let segment=[];
 for(let i=0;i<points.length;i++){
  const p=points[i];if(p.value===null||!Number.isFinite(p.value)||p.value<0||(i&&p.time-points[i-1].time>120000)){if(segment.length)segments.push(segment);segment=[];}
  if(p.value!==null&&Number.isFinite(p.value)&&p.value>=0)segment.push({...p,x:x(p.time),y:y(p.value)});
 }
 if(segment.length)segments.push(segment);
 return {points,segments,max,ceiling,minTime,maxTime,span,ticks:Array.from({length:Math.round(ceiling/step)+1},(_,i)=>({value:i*step,y:y(i*step)}))};
}
export function nearestPoint(points,time){
 if(!points.length)return null;
 let lo=0,hi=points.length-1;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(points[mid].time<time)lo=mid+1;else hi=mid;}
 const index=lo>0&&time-points[lo-1].time<=points[lo].time-time?lo-1:lo;
 return Math.abs(points[index].time-time)>60000?null:index;
}
export function initializeCharts(context){ctx=context;}
export function renderChart(samples,key,label,color='var(--chart-green)'){
 const {t,esc,stamp}=ctx;
 if(!samples.length)return `<div class="empty">${t('每分钟采样一次，尚无历史数据。')}</div>`;
 const m=chartModel(samples,key),unit=key==='rss'?'MB':key==='latency'?'ms':t('条');
 const data={...m,key,label,unit};delete data.segments;delete data.ticks;
 const axis=n=>Number(n.toPrecision(4)).toLocaleString(undefined,{maximumFractionDigits:3});
 return `<div class="time-chart" data-time-chart="${esc(JSON.stringify(data))}"><svg class="history-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" tabindex="0" aria-label="${esc(label+' · '+t('使用左右方向键查看采样值'))}"><title>${esc(label)}</title><text x="${LEFT}" y="14" class="chart-axis">${esc(unit)}</text>${m.ticks.map(tick=>`<line x1="${LEFT}" y1="${tick.y}" x2="${RIGHT}" y2="${tick.y}" class="chart-grid"/><text x="${LEFT-9}" y="${tick.y+4}" text-anchor="end" class="chart-axis">${axis(tick.value)}</text>`).join('')}<line x1="${LEFT}" y1="${TOP}" x2="${LEFT}" y2="${BOTTOM}" class="chart-grid"/>${m.segments.map(s=>s.length===1?`<circle cx="${s[0].x}" cy="${s[0].y}" r="3" fill="${color}"/>`:`<polyline fill="none" stroke="${color}" stroke-width="2.5" points="${s.map(p=>`${p.x},${p.y}`).join(' ')}"/>`).join('')}<g data-chart-cursor visibility="hidden"><line y1="${TOP}" y2="${BOTTOM}" stroke="var(--chart-cursor)" stroke-dasharray="4 4"/><circle r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/></g><rect x="${LEFT}" y="${TOP}" width="${RIGHT-LEFT}" height="${BOTTOM-TOP}" fill="transparent"/></svg><div class="chart-tooltip" role="status" hidden></div><div class="chart-labels"><span>${esc(stamp(m.minTime))}</span><span>${t('峰值')} ${axis(m.max)} ${esc(unit)}</span><span>${esc(stamp(m.maxTime))}</span></div></div>`;
}
function show(chart,index,time){
 const data=JSON.parse(chart.dataset.timeChart),svg=chart.querySelector('svg'),tooltip=chart.querySelector('.chart-tooltip'),cursor=chart.querySelector('[data-chart-cursor]'),point=index===null?null:data.points[index];
 const value=point?.value,valid=Number.isFinite(value)&&value>=0;
 chart.dataset.activePoint=index??'';
 tooltip.textContent=(ctx.stamp(point?.time??time))+'\n'+data.label+'\n'+(valid?Number(value.toFixed(2)).toLocaleString()+' '+data.unit:ctx.t('无采样数据'));
 tooltip.hidden=false;cursor.setAttribute('visibility',valid?'visible':'hidden');
 const x=LEFT+((point?.time??time)-data.minTime)/data.span*(RIGHT-LEFT);
 if(valid){const line=cursor.querySelector('line'),circle=cursor.querySelector('circle');line.setAttribute('x1',x);line.setAttribute('x2',x);circle.setAttribute('cx',x);circle.setAttribute('cy',BOTTOM-value/data.ceiling*(BOTTOM-TOP));}
 const box=chart.getBoundingClientRect(),svgBox=svg.getBoundingClientRect();
 tooltip.style.left=Math.max(0,Math.min(box.width-tooltip.offsetWidth,x/WIDTH*svgBox.width-tooltip.offsetWidth/2))+'px';tooltip.style.top='0px';
}
function hide(chart){chart.querySelector('.chart-tooltip').hidden=true;chart.querySelector('[data-chart-cursor]').setAttribute('visibility','hidden');}
if(typeof document!=='undefined'){
 const pointAt=event=>{const svg=event.target.closest?.('.history-chart');if(!svg)return;const chart=svg.closest('[data-time-chart]'),data=JSON.parse(chart.dataset.timeChart),matrix=svg.getScreenCTM();if(!matrix)return;const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());if(point.x<LEFT||point.x>RIGHT||point.y<TOP||point.y>BOTTOM){hide(chart);return;}const time=data.minTime+(point.x-LEFT)/(RIGHT-LEFT)*data.span;show(chart,nearestPoint(data.points,time),time);};
 document.addEventListener('pointermove',pointAt);document.addEventListener('pointerdown',pointAt);
 document.addEventListener('pointerout',e=>{const chart=e.target.closest?.('[data-time-chart]');if(chart&&!chart.contains(e.relatedTarget))hide(chart);});
 document.addEventListener('focusin',e=>{if(e.target.matches?.('.history-chart')){const chart=e.target.closest('[data-time-chart]'),data=JSON.parse(chart.dataset.timeChart);if(chart.querySelector('.chart-tooltip').hidden)show(chart,data.points.length-1,data.maxTime);}});
 document.addEventListener('focusout',e=>{if(e.target.matches?.('.history-chart'))hide(e.target.closest('[data-time-chart]'));});
 document.addEventListener('keydown',e=>{if(!e.target.matches?.('.history-chart'))return;const chart=e.target.closest('[data-time-chart]');if(e.key==='Escape'){hide(chart);return;}if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const data=JSON.parse(chart.dataset.timeChart),last=data.points.length-1,current=chart.dataset.activePoint===''?last:Number(chart.dataset.activePoint??last);const index=e.key==='Home'?0:e.key==='End'?last:Math.max(0,Math.min(last,current+(e.key==='ArrowLeft'?-1:1)));show(chart,index,data.points[index].time);});
}
