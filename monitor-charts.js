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
 const shortTime=time=>new Date(time).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 return `<div class="time-chart" data-time-chart="${esc(JSON.stringify(data))}"><div class="line-chart-heading"><span>${esc(label)}</span><span>${t('峰值')} ${axis(m.max)} ${esc(unit)}</span></div><div class="line-chart-plot"><div class="line-chart-axis chart-axis" aria-hidden="true">${[...m.ticks].reverse().map(tick=>`<span>${axis(tick.value)}</span>`).join('')}</div><svg class="history-chart" viewBox="${LEFT} ${TOP} ${RIGHT-LEFT} ${BOTTOM-TOP}" preserveAspectRatio="none" role="img" tabindex="0" aria-label="${esc(label+' · '+t('使用左右方向键查看采样值'))}"><title>${esc(label)}</title>${m.ticks.map(tick=>`<line x1="${LEFT}" y1="${tick.y}" x2="${RIGHT}" y2="${tick.y}" class="chart-grid" vector-effect="non-scaling-stroke"/>`).join('')}${m.segments.map(s=>s.length===1?`<circle cx="${s[0].x}" cy="${s[0].y}" r="3" fill="${color}"/>`:`<polyline fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" points="${s.map(p=>`${p.x},${p.y}`).join(' ')}"/>`).join('')}<g data-chart-cursor visibility="hidden"><line y1="${TOP}" y2="${BOTTOM}" stroke="var(--chart-cursor)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/><circle r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/></g><rect x="${LEFT}" y="${TOP}" width="${RIGHT-LEFT}" height="${BOTTOM-TOP}" fill="transparent"/></svg></div><div class="chart-tooltip" role="status" hidden></div><div class="stacked-range"><time title="${esc(stamp(m.minTime))}">${esc(shortTime(m.minTime))}</time><time title="${esc(stamp(m.maxTime))}">${esc(shortTime(m.maxTime))}</time></div></div>`;
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
 tooltip.style.left=Math.max(0,Math.min(box.width-tooltip.offsetWidth,svgBox.left-box.left+(x-LEFT)/(RIGHT-LEFT)*svgBox.width-tooltip.offsetWidth/2))+'px';tooltip.style.top='0px';
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

// Keep labels outside the SVG so text does not grow with the plot width.
// Buckets retain their actual timestamps; missing queue samples remain gaps.
export function renderStackedChart(samples,series,label,interval=3600000){
 const {t,esc,stamp}=ctx;
 const legend=`<div class="stacked-legend">${series.map(k=>`<span><i class="series-${k.key}" aria-hidden="true"></i>${esc(t(k.label))}</span>`).join('')}</div>`;
 if(!samples.length)return `<div class="stacked-chart">${legend}<div class="stacked-empty"><strong>${t('暂无采样数据')}</strong><span>${t('开始采样后显示队列趋势。')}</span></div></div>`;
 const totals=samples.map(s=>series.reduce((n,k)=>n+Number(s[k.key]||0),0));
 const peak=Math.max(...totals),max=Math.max(1,peak),span=Math.max(interval,samples.at(-1).time-samples[0].time+interval),width=560*interval/span;
 const x=s=>560*(s.time-samples[0].time)/span;
 const shortTime=time=>new Date(time).toLocaleString(undefined,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 const range=`<div class="stacked-range"><time title="${esc(stamp(samples[0].time))}">${esc(shortTime(samples[0].time))}</time><time title="${esc(stamp(samples.at(-1).time))}">${esc(shortTime(samples.at(-1).time))}</time></div>`;
 if(!peak){
  const message=interval===60000?'已采样时刻没有待处理任务':'最近 24 小时暂无推送结果';
  const note=interval===60000?'缺失采样时段不计入正常状态。':'产生推送结果后，这里会显示趋势。';
  return `<div class="stacked-chart">${legend}<div class="stacked-empty"><span class="stacked-empty-mark" aria-hidden="true">—</span><strong>${t(message)}</strong><span>${t(note)}</span></div>${range}</div>`;
 }
 return `<div class="stacked-chart">${legend}<div class="stacked-plot"><div class="stacked-yaxis" aria-hidden="true"><span>${max}</span><span>0</span></div><svg viewBox="0 0 560 160" preserveAspectRatio="none" role="img" aria-label="${esc(t(label))}"><title>${esc(t(label))}</title>${[5,80,155].map(y=>`<line x1="0" y1="${y}" x2="560" y2="${y}" class="chart-grid" vector-effect="non-scaling-stroke"/>`).join('')}${samples.map(s=>{let y=155;const title=stamp(s.time)+' · '+series.map(k=>t(k.label)+': '+Number(s[k.key]||0)).join(' / ');return `<g tabindex="0" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><rect x="${x(s)}" y="0" width="${width}" height="160" fill="transparent"/>${series.map(k=>{const h=Number(s[k.key]||0)/max*150;y-=h;return `<rect x="${x(s)}" y="${y}" width="${Math.max(.1,width*.78)}" height="${h}" fill="${k.color}"/>`;}).join('')}</g>`;}).join('')}</svg></div>${range}</div>`;
}
