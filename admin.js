import {initializeAccess,renderAccess,renderServers,renderAlerts} from './access-ui.js';
import {initializeAbuse,renderAbuse} from './abuse-ui.js';
import {initializeCharts,renderChart,renderStackedChart} from './monitor-charts.js';
import {initializeBackups,renderBackups} from './backups-ui.js';
import {initializeMaintenance,renderMaintenance} from './maintenance-ui.js';
import {initializeSecurity,renderSecurity,clearSecurity} from './security-ui.js';
import { t, html, language, locale, setLanguage, translateError } from './i18n.js';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const getTitles = () => ({ access:t('接入与验证'),servers:t('服务器接入'),alerts:t('异常告警'),abuse:t('资源保护'), overview:t('总览'), apps:t('应用管理'), apns:t('APNs 通道'), android:t('Android 通道'), deliveries:t('推送记录'), devices:t('设备登记'), monitor:t('运行监控'), logs:t('日志与审计'), backups:t('备份与恢复'), settings:t('存储与清理'), security:t('安全设置') });
let titles = getTitles();
const getStates = () => ({ queued:[t('已入队'),'blue'], retrying:[t('等待重试'),'amber'], sending:[t('发送中'),'blue'], accepted:[t('通道已接受'),'green'], failed:[t('发送失败'),'red'], unknown:[t('结果未知'),'amber'], cancelled:[t('已取消'),''] });
let states = getStates();
let token = '', epoch = 0, navigation = 0, apps = [], catalog = [], busy = false, current = 'overview', lastData;
const controllers = new Set();
const disclosureState = new Map();
document.addEventListener('toggle', event => {
  const detail=event.target;
  if(detail.matches?.('details[data-disclosure]') && detail.isConnected)
    disclosureState.set(detail.dataset.disclosure,detail.open);
},true);
const stamp = value => value ? new Date(value).toLocaleString(locale(), { hour12:false }) : '—';
const number = value => Number(value || 0).toLocaleString(locale());
const duration = ms => { const m = Math.floor(ms / 60000); return m >= 1440 ? html`${Math.floor(m/1440)} 天 ${Math.floor(m%1440/60)} 小时` : m >= 60 ? html`${Math.floor(m/60)} 小时 ${m%60} 分` : html`${m} 分 ${Math.floor(ms%60000/1000)} 秒`; };
const badge = (text, color = '') => html`<span class="badge ${esc(color)}">${esc(text)}</span>`;
const state = value => badge(...(states[value] || [value,'']));
const appName = id => apps.find(a => a.id === id)?.name || id;
let noticeTimer;
function notice(text, error = false) {
  if(error&&$('modal').open){
    clearTimeout(noticeTimer);$('message').hidden=true;
    let alert=$('modal').querySelector('[data-modal-error]');
    if(!alert){alert=document.createElement('p');alert.dataset.modalError='';alert.className='callout modal-error';alert.setAttribute('role','alert');alert.tabIndex=-1;$('modal').querySelector('.modal-head').after(alert);}
    alert.textContent=translateError(text);alert.hidden=false;alert.focus();return;
  }
  clearTimeout(noticeTimer); if (!error) noticeTimer = setTimeout(() => $('message').hidden = true, 6000); $('message').textContent = error ? translateError(text) : text; $('message').className = 'toast' + (error ? ' error' : ''); $('message').hidden = false; }
function lock() {
  clearSecurity(); $('login-factor').hidden=true; $('login-code').value=''; $('login-code').required=false;
  epoch++; navigation++; token = ''; apps = []; lastData = null; disclosureState.clear();
  for (const c of controllers) c.abort(); controllers.clear();
  $('management').hidden = true; $('login-panel').hidden = false; $('content').replaceChildren();
  $('modal').close(); $('modal').replaceChildren(); $('admin-token').value = ''; $('message').hidden = true;
}
async function api(path, method = 'GET', body) {
  const controller = new AbortController(), generation = epoch;
  controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { method, signal:controller.signal, headers:{ Authorization:'Bearer ' + token, ...(body ? {'Content-Type':'application/json'} : {}) }, body:body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (generation !== epoch) throw Error(t('会话已结束'));
    if (response.status === 401 && path !== '/auth/login') { lock(); notice(t('登录已失效，请重新登录'), true); }
    if (!response.ok) throw Error(result.error || result.reason || t('请求失败，请稍后重试'));
    return result;
  } finally { clearTimeout(timeout); controllers.delete(controller); }
}
async function action(work) {
  if (busy) return;
  busy = true; document.querySelectorAll('[data-language]').forEach(control => control.disabled = true); const generation = epoch; $('message').hidden = true;
  $('modal').querySelectorAll('[data-modal-error]').forEach(alert=>alert.hidden=true);
  $('modal').querySelectorAll('button:not(:disabled)').forEach(b => {b.dataset.busyDisabled='true'; b.disabled=true;});
  try { await work(); } catch (error) { if (generation === epoch) notice(error.name === 'AbortError' ? t('请求超时，请刷新确认操作结果。') : error.message, true); }
  finally { busy = false; document.querySelectorAll('[data-language]').forEach(control => control.disabled = false); $('modal').querySelectorAll('[data-busy-disabled]').forEach(b => {b.disabled=false; delete b.dataset.busyDisabled;}); }
}
function heading(title, description, actions = '') { return html`<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}<button data-action="refresh">↻ 刷新</button></div></div>`; }
function panel(title, subtitle, body, action = '') { return html`<section class="panel"><div class="panel-head"><div><h2>${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>${action}</div>${body}</section>`; }
function empty(title, description) { return html`<div class="empty"><div class="empty-icon"><svg class="icon" aria-hidden="true"><use href="#icon-inbox"></use></svg></div><strong>${title}</strong>${description}</div>`; }
function metric(title, value, note) { return html`<div class="metric"><div class="metric-label">${title}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`; }
function table(headers, rows, emptyText = t('暂无记录'), note = t('符合筛选条件的数据会显示在这里。')) { return rows.length ? html`<div class="table-wrap"><table><thead><tr>${headers.map(h => html`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(cells => html`<tr>${cells.map(c => html`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty(emptyText,note); }
const option = (value, text, selected) => html`<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(text)}</option>`;
function appCell(a) { return html`<span class="app-icon">${esc(a.name.slice(0,1).toUpperCase())}</span><span class="app-name"><strong>${esc(a.name)}</strong><small>${esc(a.id)}</small></span>`; }
function jobRows(items, controls = false) { return items.map(j => [ html`<strong>${esc(appName(j.app_id))}</strong><small>${esc(j.id.slice(0,8))}</small>`, esc(j.channel.toUpperCase()), state(j.state), esc(stamp(j.created)), controls ? html`${j.attempts} 次<small>${esc(j.reason || (j.status ? 'HTTP ' + j.status : t('尚未发送')))}</small>` : (j.status || '—'), ...(controls ? [html`${number(j.duration)} ms`, html`<div class="row-actions"><button data-action="view-job" data-id="${esc(j.id)}">详情</button>${['queued','retrying'].includes(j.state) ? html`<button class="quiet danger" data-action="cancel-job" data-id="${esc(j.id)}">取消</button>` : ''}</div>`] : []) ]); }
function renderOverview(v) {
  return heading(t('网关总览'),t('应用、通道与投递状态，一目了然。'), t('<button class="primary" data-action="new-app">＋ 添加应用</button>')) +
    html`<div class="metrics">${metric(t('应用'),number(v.applications.total),html`<em>${number(v.applications.enabled)}</em> 个已启用`)}${metric(t('有效设备'),number(v.devices),t('已完成设备接收验证'))}${metric(t('通道已接受 · 24h'),number(v.counts.accepted),t('不代表设备已收到'))}${metric(t('待处理任务'),number(v.queue),html`24h 失败 / 未知 <em>${number(v.counts.failed)}</em>`)}</div>` +
    html`<div class="split">${panel(t('应用概况'),t('每个应用独立配置推送通道'), table([t('应用'),t('配置状态'),t('设备')],apps.slice(0,5).map(a => [appCell(a), badge(a.enabled ? a.ready ? t('已配置') : t('待配置') : t('已停用'),a.enabled && a.ready ? 'green' : ''),number(a.registrations)]),t('还没有应用'),t('创建应用后配置 APNs 或 Android 通道。')),t('<a class="muted" href="#apps">查看全部 →</a>'))}${panel(t('当前运行'),t('当前实例的实时状态'),html`<div class="panel-body"><div class="health-row"><div>网关服务<p>已连接管理 API</p></div>${badge(t('运行中'),'green')}</div><div class="health-row"><div>本次运行时长<p>启动于 ${esc(stamp(v.startedAt))}</p></div><strong>${duration(v.uptime)}</strong></div><div class="health-row"><div>内存占用<p>进程驻留内存 RSS</p></div><strong>${(v.memory.rss/1048576).toFixed(1)} MB</strong></div></div>`,t('<a class="muted" href="#monitor">运行监控 →</a>'))}</div>` +
    panel(t('最近推送'),t('真实投递记录 · 不包含消息正文或设备 token'),table([t('应用 / 任务'),t('通道'),t('状态'),t('时间'),t('响应')],jobRows(v.recent),t('尚无推送记录'),t('完成设备登记并发送同步提示后，这里会显示处理结果。')),t('<a class="muted" href="#deliveries">查看全部 →</a>'));
}
function renderApps() {
  return heading(t('应用管理'),t('管理应用名称、启停状态和通道配置。'),t('<button class="primary" data-action="new-app">＋ 添加应用</button>')) +
    panel(t('全部应用'),html`${apps.length} 个应用 · 配置变更会撤销该应用现有设备登记`,table([t('应用'),t('状态'),t('通道'),t('有效设备'),t('接受 / 失败¹'),t('操作')], apps.map(a => [appCell(a),badge(a.enabled ? t('已启用') : t('已停用'), a.enabled ? 'green' : ''),[a.apns.enabled ? badge('APNs','blue') : '',a.fcm.enabled ? badge('FCM','blue') : ''].filter(Boolean).join(' ') || t('待配置'),number(a.registrations),html`${number(a.counts.accepted)} / ${number(a.counts.failed)}`,html`<div class="row-actions"><button data-action="view-app" data-id="${esc(a.id)}">详情</button><button data-action="edit-app" data-id="${esc(a.id)}">编辑</button><button data-action="app-channels" data-id="${esc(a.id)}">通道</button><button class="quiet danger" data-action="delete-app" data-id="${esc(a.id)}">删除</button></div>`]),t('还没有应用'),t('点击“添加应用”，建立你的第一个推送应用。'))) + t('<p class="help">¹ 保留期内的任务统计，失败包含结果未知。重命名不影响设备登记；停用、更新或删除通道后需重新登记。</p>');
}
function renderChannels(kind) {
  const android = kind === 'fcm';
  const descriptions = android ? t('通过 Firebase Cloud Messaging 发送 Android 后台同步提示。') : t('管理 Apple 推送密钥、Bundle ID 和开发 / 生产环境。');
  const selectedApp = new URLSearchParams(location.hash.split('?')[1]).get('appId');
  const items = selectedApp ? apps.filter(a => a.id === selectedApp) : apps;
  return heading(android ? t('Android 通道') : t('APNs 通道'),descriptions) +
    html`<div class="callout">${android ? t('FCM 通道已实现，需上传 Firebase 服务账号 JSON。Android 客户端需接入挑战确认协议；本项目尚未提供 Android App。') : t('私钥加密保存，不会回显。开发环境与生产环境需要匹配设备 token；保存配置仅校验格式，不代表 Apple 已授权或真机已送达。')}</div>` +
    (selectedApp ? '<p><a class="muted" href="#'+current+t('">← 显示全部应用</a></p>') : '') +
    (items.length ? html`<div class="cards">${items.map(a => { const c = a[kind]; return html`<section class="channel-card"><div class="panel-head"><div class="channel-logo"><svg class="icon" aria-hidden="true"><use href="#icon-${android ? 'android' : 'phone'}"></use></svg></div>${badge(!a.enabled ? t('应用已停用') : c.hasKey ? c.enabled ? t('已配置') : t('通道已停用') : t('待配置'),a.enabled && c.enabled ? 'green':'')}</div><h3>${esc(a.name)}</h3><p>${esc(a.id)}</p><div class="kv"><span>${android ? t('Firebase 项目'):'Bundle ID'}</span><strong>${esc((android ? c.projectId:c.topic)||'—')}</strong><span>环境</span><strong>${esc(android ? t('生产'):({production:t('生产'),sandbox:t('开发'),both:t('开发 + 生产')}[c.environment]))}</strong><span>已验证设备</span><strong>${number(a.registrations)} <span>（应用总计）</span></strong></div><div class="row-actions"><button data-action="configure" data-id="${esc(a.id)}" data-kind="${kind}">${c.hasKey ? t('编辑配置'):t('配置通道')}</button>${c.hasKey ? html`<button class="quiet danger" data-action="remove-channel" data-id="${esc(a.id)}" data-kind="${kind}">移除</button><button class="quiet" data-action="test-channel" data-id="${esc(a.id)}" data-kind="${kind}">测试</button>`:''}</div></section>`; }).join('')}</div>` : empty(t('请先创建应用'),t('<a href="#apps">前往应用管理 →</a>'))) +
    (android ? html`<div class="page-heading"><div><h1>其他厂商通道</h1><p>以下通道尚未实现，不接受设备登记或推送。</p></div></div><div class="cards">${catalog.filter(c=>c.platform==='android' && !c.implemented).map(c=>html`<section class="channel-card"><h3>${esc(language === 'en' ? ({huawei:'Huawei',xiaomi:'Xiaomi',oppo:'OPPO',vivo:'vivo',honor:'Honor'}[c.id] || c.name) : c.name)}</h3>${badge(t('尚未接入'))}<p>需要独立适配厂商认证、设备登记和发送接口。</p></section>`).join('')}</div>` : '');
}
function filters(params, page) {
  const includeState = page === 'deliveries';
  return html`<form class="filters" id="filters"><label>应用<select name="appId">${option('',t('全部应用'),params.get('appId'))}${apps.map(a=>option(a.id,a.name,params.get('appId'))).join('')}</select></label><label>通道<select name="channel">${option('',t('全部通道'),params.get('channel'))}${option('apns','APNs',params.get('channel'))}${option('fcm','FCM',params.get('channel'))}</select></label>${includeState ? html`<label>状态<select name="state">${option('',t('全部状态'),params.get('state'))}${Object.entries(states).map(([v,[name]])=>option(v,name,params.get('state'))).join('')}</select></label>` : page === 'logs' ? html`<label>类型<select name="kind">${option('',t('全部类型'),params.get('kind'))}${[['audit',t('管理审计')],['request',t('请求')],['error',t('错误')]].map(([v,n])=>option(v,n,params.get('kind'))).join('')}</select></label>` : ''}${page !== 'devices' ? html`<label>时间<select name="range">${[['',t('近 30 天')],['24',t('最近 24 小时')],['1',t('最近 1 小时')]].map(([v,n])=>option(v,n,params.get('range'))).join('')}</select></label>` : ''}<button class="primary">筛选</button></form>`;
}
function pager(v) { return html`<div class="pager"><span>共 ${number(v.total)} 条 · 第 ${v.page} / ${Math.max(1,Math.ceil(v.total/v.limit))} 页</span><div><button data-action="page" data-page="${v.page-1}" ${v.page===1?'disabled':''}>上一页</button><button data-action="page" data-page="${v.page+1}" ${v.page*v.limit>=v.total?'disabled':''}>下一页</button></div></div>`; }
function renderList(v, params) {
  let headers, rows, note;
  if (current === 'deliveries') { headers=[t('应用 / 任务'),t('通道'),t('状态'),t('创建时间'),t('尝试 / 原因'),t('最近耗时'),t('操作')]; rows=jobRows(v.items,true); note=t('异步任务由网关重试；兼容接口由业务 Server 重试。未知结果不会由网关自动重发。'); }
  if (current === 'devices') { headers=[t('设备'),t('应用'),t('通道 / 环境'),t('验证状态'),t('凭证到期'),t('操作')]; rows=v.items.map(d=>[html`<strong>${esc(d.device_id)}</strong><small>Server · ${esc(d.server_id)}</small>`,esc(appName(d.app_id)),html`${esc(d.channel.toUpperCase())}<small>${esc(({sandbox:t('开发'),production:t('生产')})[d.environment] || d.environment)}</small>`,badge(d.verified?t('已验证'):t('等待挑战'),d.verified?'green':'amber'),esc(stamp(d.expires)),html`<div class="row-actions">${d.verified?html`<button data-action="test-device" data-id="${esc(d.id)}">测试推送</button>`:''}<button class="quiet danger" data-action="revoke-device" data-id="${esc(d.id)}">撤销</button></div>`]); note=t('设备完成挑战确认后才能发送。撤销会同时取消待发送任务。'); }
  if (current === 'logs') { headers=[t('时间'),t('类型'),t('操作'),t('应用'),t('响应 / 耗时'),t('请求 ID')]; rows=v.items.map(l=>[esc(stamp(l.time)),badge({audit:t('管理审计'),request:t('请求'),error:t('错误')}[l.kind]||l.kind,l.kind==='error'?'red':''),html`<code>${esc(l.action)}</code>`,esc(appName(l.app_id)||'—'),html`${l.status} · ${l.duration} ms`,html`<button class="quiet" data-action="view-log" data-id="${l.id}"><code>${esc(l.request_id.slice(0,8))}</code> ↗</button>`]); note=t('记录请求结果与配置变更，不记录私钥、凭证、设备 token 或消息正文。'); }
  return heading(titles[current],note) + filters(params,current) + panel(t('记录列表'),html`每页 ${v.limit} 条`, table(headers,rows) + pager(v));
}
function chart(samples,key,label,color){return renderChart(samples,key,label,color);}
function renderMonitor(v) {
  const resultSeries=[{key:'accepted',label:'已接受',color:'var(--chart-green)'},{key:'failed',label:'失败',color:'var(--chart-red)'},{key:'unknown',label:'结果未知',color:'var(--chart-amber)'}];
  const queueSeries=[{key:'queued',label:'等待',color:'var(--chart-blue)'},{key:'retrying',label:'重试中',color:'var(--chart-amber)'},{key:'sending',label:'发送中',color:'var(--chart-green)'}];
  const start=Math.floor((v.time-86400000)/3600000)*3600000;
  const results=Array.from({length:25},(_,i)=>({time:start+i*3600000,accepted:0,failed:0,unknown:0}));
  for(const b of v.buckets){const row=results.find(r=>r.time===b.time);if(row)row[b.state]=b.count;}
  const q=v.queueStatus,backup=v.backupSummary;
  const channelRows=['apns','fcm'].map(channel=>{
    const counts=Object.fromEntries(v.results.filter(r=>r.channel===channel).map(r=>[r.state,r.count]));
    const total=(counts.accepted||0)+(counts.failed||0)+(counts.unknown||0);
    return [channel.toUpperCase(),number(counts.accepted||0),number(counts.failed||0),number(counts.unknown||0),total?(100*(counts.accepted||0)/total).toFixed(1)+'%':t('暂无数据')];
  });
  const names={ok:'按时成功',failed:'失败',overdue:'备份逾期',unverified:'尚无成功备份',disabled:'未启用'};
  const backupCard=(label,item)=>html`<div class="health-row"><div>${t(label)}<p>${item.lastSuccess?esc(stamp(item.lastSuccess)):t('尚无成功备份')}</p></div>${badge(t(names[item.status]),item.status==='ok'?'green':item.status==='disabled'?'':'amber')}</div>`;
  const samples=v.samples.map(s=>({...s,rss:s.rss/1048576}));
  return heading(t('运行监控'),t('关注推送结果、队列处理和备份；服务可用性由外部 Uptime 监控。'))+
    panel(t('推送结果 · 最近 24 小时'),t('按结果更新时间统计；厂商接受不代表设备送达。'),html`<div class="panel-body">${renderStackedChart(results,resultSeries,'推送结果')}${table([t('通道'),t('已接受'),t('失败'),t('结果未知'),t('接受率')],channelRows)}${v.failures.length?html`<details data-disclosure="monitor-failures"><summary>${t('失败原因')}</summary>${table([t('通道'),t('原因'),t('数量')],v.failures.map(r=>[esc(r.channel.toUpperCase()),esc(r.reason),number(r.count)]))}<a href="#deliveries">${t('查看推送记录')}</a></details>`:''}</div>`)+
    panel(t('队列处理'),t('等待、重试与发送中使用相同统计口径；计划中的重试不算调度逾期。'),html`<div class="panel-body"><div class="metrics">${metric(t('待处理任务'),number(q.queued+q.retrying+q.sending),t('等待 / 重试 / 发送中'))}${metric(t('最老等待时间'),duration(q.oldestWaitSeconds*1000),t('包含重试等待时间'))}${metric(t('调度逾期'),number(q.overdue),t('超过计划执行时间 5 分钟'))}${metric(t('发送超时'),number(q.stuck),t('发送中超过 2 分钟'))}</div>${(!v.diagnostics.lastSampleAt||v.time-v.diagnostics.lastSampleAt>120000)?html`<p class="callout">${t('监控采样已过期')}</p>`:''}${q.workerError?html`<p class="callout">${t('队列轮询失败，请检查日志。')}</p>`:''}${renderStackedChart(v.queueSamples,queueSeries,'队列处理',60000)}<p class="help">${t('采样间隔一分钟；缺失采样不表示队列为空。')}</p></div>`)+
    panel(t('备份状态'),t('按备份周期加 1 小时宽限判断逾期；成功备份不代表已验证恢复。'),html`<div class="panel-body">${backupCard('本地备份',backup.local)}${backupCard('异地备份',backup.remote)}${!backup.workerOnline?html`<p class="callout">${t('备份进程未连接')}</p>`:''}</div>`,html`<a href="#backups">${t('备份与恢复')} →</a>`)+
    html`<details class="panel diagnostics-panel" data-disclosure="monitor-diagnostics"><summary><span>${t('诊断详情')}</span><span class="disclosure-chevron" aria-hidden="true"></span></summary><div class="panel-body"><dl class="summary-stats summary-stats-detail"><div><dt>${t('本次 Uptime')}</dt><dd>${duration(v.uptime)}</dd></div><div><dt>${t('进程驻留内存 MB')}</dt><dd>${(v.memory.rss/1048576).toFixed(1)}</dd></div><div><dt>${t('最近成功采样')}</dt><dd>${esc(stamp(v.diagnostics.lastSampleAt))}</dd></div><div><dt>${t('采样失败次数')}</dt><dd>${number(v.diagnostics.sampleFailures)}</dd></div><div><dt>${t('队列轮询失败次数')}</dt><dd>${number(q.workerFailures)}</dd></div></dl>${chart(samples,'rss',t('进程驻留内存 MB'))}${table([t('启动时间'),t('最后心跳'),t('停止时间')],v.runs.map(r=>[esc(stamp(r.started)),esc(stamp(r.heartbeat)),esc(stamp(r.stopped))]))}</div></details>`;
}
async function load(quiet = false) {
  if (!token) return;
  const [requested,query=''] = location.hash.slice(1).split('?');
  current = titles[requested] ? requested : 'overview';
  const route = current, turn = ++navigation, generation = epoch, params = new URLSearchParams(query);
  $('breadcrumb').textContent=titles[current];
  document.querySelectorAll('[data-page]').forEach(a=>{if(a.tagName==='A'){ a.classList.toggle('active',a.dataset.page===current); if(a.dataset.page===current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current'); }});
  if(!quiet) $('content').innerHTML=t('<div class="loading">正在加载…</div>');
  try {
    const listing=await api('/admin/apps');
    if(turn!==navigation || generation!==epoch)return;
    apps=listing.applications; catalog=listing.channels;
    let markup;
    if(route==='access') { const id=params.get('appId')||apps[0]?.id; markup=id?renderAccess({policy:await api('/admin/apps/'+encodeURIComponent(id)+'/access'),quotas:await api('/admin/apps/'+encodeURIComponent(id)+'/quotas')},apps,id):empty(t('请先添加应用'),''); }
    else if(route==='servers') markup=renderServers(await api('/admin/servers'));
    else if(route==='alerts') markup=renderAlerts(await api('/admin/alerts'));
    else if(route==='abuse') { lastData=await api('/admin/abuse'); markup=renderAbuse(lastData); }
    else if(route==='backups') { lastData=await api('/admin/backups'); markup=renderBackups(lastData); }
    else if(route==='settings') { lastData=await api('/admin/settings'); markup=renderMaintenance(lastData); }
    else if(route==='security') { lastData=await api('/admin/security'); markup=renderSecurity(lastData); }
    else if(route==='apps') markup=renderApps();
    else if(route==='apns'||route==='android') markup=renderChannels(route==='apns'?'apns':'fcm');
    else {
      const endpoint={overview:'overview',monitor:'monitor',deliveries:'jobs',devices:'devices',logs:'logs'}[route];
      const apiParams=new URLSearchParams(params);
      if(params.get('range')) apiParams.set('from',Date.now()-Number(params.get('range'))*3600000);
      const data=await api('/admin/'+endpoint+'?'+apiParams);
      if(turn!==navigation || generation!==epoch)return;
      lastData=data;
      markup=route==='overview'?renderOverview(data):route==='monitor'?renderMonitor(data):renderList(data,params);
    }
    if(turn===navigation && generation===epoch) {
      // Capture the latest user choice, including a toggle while the request was in flight.
      for(const detail of $('content').querySelectorAll('details[data-disclosure]'))
        disclosureState.set(detail.dataset.disclosure,detail.open);
      $('content').innerHTML=markup;
      for(const detail of $('content').querySelectorAll('details[data-disclosure]'))
        detail.open=disclosureState.get(detail.dataset.disclosure)??false;
    }
  } catch(error) {
    if(turn!==navigation || generation!==epoch)return;
    if(!quiet) $('content').innerHTML=empty(t('无法加载页面'),esc(translateError(error.message))+t('<p><button data-action="refresh">重试</button></p>'));
    notice(error.name==='AbortError'?t('连接超时，请重试。'):error.message,true);
  }
}
function modal(title, content, submit, button=t('保存'), danger=false) {
  $('modal').innerHTML=html`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="quiet modal-close" data-action="close-modal" aria-label="关闭"><svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg></button></div><form id="modal-form">${content}<div class="modal-actions"><button type="button" data-action="close-modal">取消</button><button type="submit" class="${danger?'danger':'primary'}">${esc(button)}</button></div></form>`;
  $('modal-form').onsubmit=event=>{event.preventDefault();void action(async()=>{await submit(event.target); $('modal').close(); $('modal').replaceChildren(); await load();});};
  $('modal').showModal();
}
function appModal(id) {
  const a=apps.find(a=>a.id===id);
  const config=a?.notifications ?? {kinds:['sync'],fallback:{title:'Notification',body:'Open the app to view the update.',sound:true}};
  const capabilities=html`<fieldset class="notification-capabilities" aria-describedby="capability-help"><legend>通知能力 <span class="capability-hint">可多选</span></legend><div class="capability-options">${[['sync',t('后台更新提醒'),t('无横幅、无声音')],['alert',t('普通通知'),t('直接显示标题和内容')],['encrypted_alert',t('加密通知'),t('由客户端解密内容')]].map(([kind,label,description])=>html`<label class="check capability-option"><input type="checkbox" name="capability" value="${kind}" ${kind==='encrypted_alert'?'aria-controls="encrypted-settings"':''} ${config.kinds.includes(kind)?'checked':''}><span><strong>${label}</strong><small>${description}</small></span></label>`).join('')}</div><p class="help" id="capability-help">选择此应用允许使用的能力，每次推送只使用一种类型。</p><p class="help">后台更新提醒不显示通知、不播放声音，系统允许时触发同步。APNs 支持全部能力；FCM 支持后台更新提醒和普通通知。新增能力需客户端申请相应授权；关闭能力仅停止该类型推送，不影响其他推送。</p></fieldset><fieldset class="encrypted-settings" id="encrypted-settings"><details><summary>高级设置 · 加密通知兜底文案</summary><p class="help">客户端未能解密时显示以下通用文案，请勿填写敏感内容。可保留默认值。</p><label>兜底标题<input name="fallbackTitle" maxlength="120" value="${esc(config.fallback.title)}"></label><label>兜底内容<input name="fallbackBody" maxlength="400" value="${esc(config.fallback.body)}"></label><p class="help">加密通知默认请求系统通知音，可在手机系统设置中关闭声音。修改兜底文案无需重新登记设备。</p></details></fieldset>`;
  modal(a?t('编辑应用'):t('添加应用'),html`<label>应用名称<input name="name" maxlength="100" value="${esc(a?.name||'')}" required></label>${a?html`<p class="help">应用 ID：${esc(a.id)}</p><label class="check"><input name="enabled" type="checkbox" ${a.enabled?'checked':''}>启用推送</label><p class="help">切换启停状态将撤销现有设备登记，重新启用后设备需重新登记。</p>`:html`<label>应用 ID<input name="id" maxlength="100" pattern="[A-Za-z0-9_-]{1,100}" placeholder="my-app" required></label><p class="help">ID 创建后不可修改，客户端与业务 Server 使用此 ID 接入。</p>`}${capabilities}`,async form=>{
    const notifications={kinds:[...form.querySelectorAll('[name="capability"]:checked')].map(el=>el.value),fallback:{title:form.elements.fallbackTitle.value,body:form.elements.fallbackBody.value}};
    const body={notifications,name:form.elements.name.value,...(a?{enabled:form.elements.enabled.checked}:{id:form.elements.id.value})};
    await api('/admin/apps'+(a?'/'+encodeURIComponent(a.id):''),a?'PUT':'POST',body);notice(a?t('应用已保存'):t('应用已创建，请配置推送通道。'));
  },a?t('保存修改'):t('创建应用'));
  const encryptedToggle=$('modal-form').querySelector('[name="capability"][value="encrypted_alert"]');
  const syncEncryptedSettings=()=>{
    const settings=$('encrypted-settings');
    settings.hidden=!encryptedToggle.checked;
    settings.disabled=!encryptedToggle.checked;
    encryptedToggle.setAttribute('aria-expanded',String(encryptedToggle.checked));
  };
  encryptedToggle.addEventListener('change',syncEncryptedSettings);
  syncEncryptedSettings();
}
function configure(id,kind) {
  const a=apps.find(a=>a.id===id);if(!a)return;
  const c=a[kind];
  const content=kind==='apns'?html`<div class="form-grid"><label>Key ID<input name="keyId" pattern="[A-Z0-9]{10}" maxlength="10" value="${esc(c.keyId)}" required></label><label>Team ID<input name="teamId" pattern="[A-Z0-9]{10}" maxlength="10" value="${esc(c.teamId)}" required></label></div><label>Bundle ID<input name="topic" value="${esc(c.topic)}" pattern="[A-Za-z0-9.-]{1,255}" required placeholder="com.example.app"></label><label>密钥允许的环境<select name="environment">${[['production',t('生产')],['sandbox',t('开发')],['both',t('开发与生产')]].map(([v,n])=>option(v,n,c.environment)).join('')}</select></label><label>私钥文件（.p8）<input type="file" name="file" accept=".p8" ${c.hasKey?'':'required'}></label>`:html`<dl class="summary-list"><div><dt>当前 Firebase 项目</dt><dd>${esc(c.projectId||t('尚未配置'))}</dd></div><div><dt>服务账号</dt><dd>${esc(c.clientEmail||'—')}</dd></div></dl><label>Firebase 服务账号 JSON<input type="file" name="file" accept=".json,application/json" ${c.hasKey?'':'required'}></label>`;
  modal(html`${kind.toUpperCase()} · ${a.name}`,content+html`<label class="check"><input name="enabled" type="checkbox" ${!c.hasKey||c.enabled?'checked':''}>启用通道</label><p class="help">${c.hasKey?t('文件留空保留已有私钥。'):''}凭据加密保存，不会回显。配置变更会撤销本应用现有设备登记及未完成任务。</p>`,async form=>{
    const body={enabled:form.elements.enabled.checked}, file=form.elements.file.files[0];
    if(file && file.size>16384)throw Error(t('密钥文件不能超过 16 KiB'));
    if(kind==='apns') { for(const name of ['keyId','teamId','topic','environment'])body[name]=form.elements[name].value; if(file)body.privateKey=await file.text(); }
    else if(file) { try { body.serviceAccount=JSON.parse(await file.text()); } catch { throw Error(t('无法解析服务账号 JSON 文件')); } }
    await api(html`/admin/apps/${encodeURIComponent(id)}/channels/${kind}`,'PUT',body);notice(t('通道配置已保存。若配置发生变化，设备需重新登记。'));
  });
}
function inspect(title, pairs, extra = '') {
  $('modal').innerHTML=html`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="quiet modal-close" data-action="close-modal" aria-label="关闭"><svg class="icon" aria-hidden="true"><use href="#icon-close"></use></svg></button></div><div class="kv">${pairs.map(([label,value])=>html`<span>${esc(label)}</span><strong>${esc(value)}</strong>`).join('')}</div>${extra}<div class="modal-actions"><button data-action="close-modal">关闭</button></div>`;
  $('modal').showModal();
}
function confirmAction(title, description, path, method='DELETE', body) {
  modal(title,html`<p class="help">${description}</p>`,async()=>{await api(path,method,body);notice(method==='POST'?t('测试任务已入队，可在推送记录查看结果。'):t('操作已完成。'));},method==='POST'?t('发送同步提示'):t('确认'),method!=='POST');
}
$('login').onsubmit=event=>{event.preventDefault();void action(async()=>{
  const result=await api('/auth/login','POST',{token:$('admin-token').value.trim(),code:$('login-code').value.trim()});
  if(result.requiresSecondFactor){$('login-factor').hidden=false;$('login-code').required=true;$('login-code').focus();return;}
  token=result.session;$('admin-token').value='';$('login-code').value='';
  $('management').hidden=false;$('login-panel').hidden=true;await load();
});};
$('logout').onclick=()=>void action(async()=>{await api('/admin/logout','POST',{});lock();});
window.addEventListener('hashchange',()=>{if($('modal').open)$('modal').close();void load();});
document.addEventListener('submit',event=>{if(event.target.id!=='filters')return;event.preventDefault();const params=new URLSearchParams();for(const [key,value]of new FormData(event.target))if(value)params.set(key,value);const hash='#'+current+'?'+params;if(location.hash===hash)void load();else location.hash=hash;});
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button || button.disabled)return;
  const {action:kind,id,kind:channel}=button.dataset;
  if(kind==='close-modal'){if(!busy){$('modal').close();$('modal').replaceChildren();}return;}
  if(busy)return;
  if(kind==='refresh')void load();
  if(kind==='new-app')appModal();
  if(kind==='edit-app')appModal(id);
  if(kind==='app-channels')location.hash='apns?appId='+encodeURIComponent(id);
  if(kind==='view-app') {
    const a=apps.find(a=>a.id===id);if(a)inspect(a.name,[[t('应用 ID'),a.id],[t('状态'),a.enabled?t('已启用'):t('已停用')],[t('设备登记'),a.registrations],['APNs Bundle ID',a.apns.topic||t('未配置')],[t('FCM 项目'),a.fcm.projectId||t('未配置')],[t('通道已接受'),a.counts.accepted],[t('失败 / 未知'),a.counts.failed]],html`<p class="help"><a href="#apns?appId=${encodeURIComponent(id)}">配置 APNs →</a> · <a href="#android?appId=${encodeURIComponent(id)}">配置 Android →</a><br><a href="#deliveries?appId=${encodeURIComponent(id)}">查看推送记录 →</a> · <a href="#devices?appId=${encodeURIComponent(id)}">查看设备登记 →</a></p>`);
  }
  if(kind==='view-job') {
    const j=lastData?.items?.find(j=>j.id===id);if(j)inspect(t('推送任务详情'),[[t('任务 ID'),j.id],[t('应用'),appName(j.app_id)],[t('设备'),j.device_id],[t('登记 ID'),j.registration_id],[t('通道'),j.channel],[t('状态'),states[j.state]?.[0]||j.state],[t('重试负责人'),j.mode==='legacy'?t('业务 Server（兼容接口）'):t('本网关')],[t('尝试次数'),j.attempts],[t('通道响应'),j.status||t('无响应')],[t('原因'),j.reason||'—'],[t('创建时间'),stamp(j.created)],[t('更新时间'),stamp(j.updated)],[t('下次尝试'),j.state==='retrying'?stamp(j.next_at):'—'],[t('最近耗时'),j.duration+' ms']]);
  }
  if(kind==='view-log') {
    const l=lastData?.items?.find(l=>String(l.id)===id);if(l)inspect(t('日志详情'),[[t('请求 ID'),l.request_id],[t('时间'),stamp(l.time)],[t('类型'),l.kind === 'audit' ? t('管理审计') : l.kind === 'error' ? t('错误') : t('请求')],[t('操作'),l.action],[t('应用'),appName(l.app_id)||'—'],[t('通道'),l.channel||'—'],[t('HTTP 状态'),l.status],[t('耗时'),l.duration+' ms']]);
  }
  if(kind==='configure')configure(id,channel);
  if(kind==='delete-app')confirmAction(t('删除应用'),html`删除 <strong>${esc(appName(id))}</strong>，同时删除通道密钥和设备登记，取消未完成任务。历史投递与审计记录保留至保留期结束。此操作不可撤销。`,'/admin/apps/'+encodeURIComponent(id));
  if(kind==='remove-channel')confirmAction(t('移除通道'),html`移除 ${esc(appName(id))} 的 ${esc(channel.toUpperCase())} 密钥，撤销该应用现有设备登记并取消未完成任务。`,'/admin/apps/'+encodeURIComponent(id)+'/channels/'+channel);
  if(kind==='revoke-device')confirmAction(t('撤销设备登记'),t('撤销后，该设备的投递凭证立即失效，未完成的推送任务会被取消。'),'/admin/devices/'+encodeURIComponent(id));
  if(kind==='test-device')confirmAction(t('发送测试同步提示'),t('向这台已验证设备发送后台同步提示，不包含邮件内容，不显示横幅。通道接受不代表设备已收到。'),'/admin/devices/'+encodeURIComponent(id)+'/test','POST',{requestId:crypto.randomUUID()});
  if(kind==='test-channel') { location.hash='devices?appId='+encodeURIComponent(id)+'&channel='+channel;notice(t('选择一台已验证设备，点击“测试推送”。')); }
  if(kind==='cancel-job')confirmAction(t('取消待发送任务'),t('取消后不会继续发送或重试。已发送到通道的请求无法撤回。'),'/admin/jobs/'+encodeURIComponent(id));
  if(kind==='page'){const params=new URLSearchParams(location.hash.split('?')[1]);params.set('page',button.dataset.page);location.hash=current+'?'+params;}
});
$('modal').addEventListener('cancel',event=>{if(busy||$('modal').querySelector('#finish-recovery'))event.preventDefault();else $('modal').replaceChildren();});
setInterval(()=>{if(token&&!busy&&!$('modal').open&&!document.hidden&&!document.querySelector('.time-chart:hover, .history-chart:focus')&&['overview','monitor'].includes(current))void load(true);},30000);

function localizeShell() {
  document.documentElement.lang = locale();
  document.title = 'Kookaburra Relay';
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => el.placeholder = t(el.dataset.i18nPlaceholder));
  document.querySelectorAll('[data-i18n-label]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  document.querySelectorAll('[data-language]').forEach(el => el.setAttribute('aria-checked',String(el.dataset.language===language)));
  syncThemeControls();
  $('breadcrumb').textContent = titles[current];
}
function closeLanguages(){document.querySelectorAll('.language-menu').forEach(menu=>menu.hidden=true);document.querySelectorAll('[data-language-trigger]').forEach(el=>el.setAttribute('aria-expanded','false'));}
document.querySelectorAll('[data-language-trigger]').forEach(button=>button.addEventListener('click',()=>{
  openSelect?.close(); closeThemes();
  const menu=button.nextElementSibling,opening=menu.hidden;closeLanguages();if(opening){menu.hidden=false;button.setAttribute('aria-expanded','true');menu.querySelector('[aria-checked="true"]').focus();}
}));
document.addEventListener('click',event=>{if(!event.target.closest('.language-picker'))closeLanguages();});
document.addEventListener('keydown',event=>{
  const picker=event.target.closest('.language-picker');if(!picker)return;
  if(event.key==='Escape'){closeLanguages();picker.querySelector('[data-language-trigger]').focus();event.preventDefault();}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
    event.preventDefault();const items=[...picker.querySelectorAll('[data-language]')],index=items.indexOf(document.activeElement);
    picker.querySelector('.language-menu').hidden=false;picker.querySelector('[data-language-trigger]').setAttribute('aria-expanded','true');
    items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
  }
  if(event.key==='Tab')closeLanguages();
});
document.querySelectorAll('[data-language]').forEach(control=>control.addEventListener('click',async()=>{
  if(busy)return;
  const savedFilters=$('filters')?[...new FormData($('filters'))]:[];
  setLanguage(control.dataset.language);titles=getTitles();states=getStates();localizeShell();closeLanguages();control.closest('.language-picker').querySelector('[data-language-trigger]').focus();$('message').hidden=true;
  if(token){await load();for(const [name,value]of savedFilters)if($('filters')?.elements[name]){ $('filters').elements[name].value=value; $('filters').elements[name].syncDropdown?.(); }}
}));

function syncThemeControls() {
  const preference = window.relayTheme.preference;
  const label = t({system:'跟随系统',light:'浅色',dark:'深色'}[preference]);
  document.querySelectorAll('[data-theme-option]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.themeOption === preference)));
  document.querySelectorAll('[data-theme-trigger]').forEach(button => {
    button.querySelector('use').setAttribute('href', '#icon-theme-' + preference);
    button.title = t('外观') + ' · ' + label;
    button.setAttribute('aria-label', button.title);
  });
}
function closeThemes() {
  document.querySelectorAll('.theme-menu').forEach(menu => menu.hidden = true);
  document.querySelectorAll('[data-theme-trigger]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
window.addEventListener('themechange', syncThemeControls);
document.querySelectorAll('[data-theme-trigger]').forEach(button => button.addEventListener('click', () => {
  const menu = button.nextElementSibling, opening = menu.hidden;
  closeThemes(); closeLanguages(); openSelect?.close();
  if (opening) { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); menu.querySelector('[aria-checked="true"]').focus(); }
}));
document.querySelectorAll('[data-theme-option]').forEach(button => button.addEventListener('click', () => {
  window.relayTheme.set(button.dataset.themeOption);
  closeThemes(); button.closest('.theme-picker').querySelector('[data-theme-trigger]').focus();
}));
document.addEventListener('click', event => { if (!event.target.closest('.theme-picker')) closeThemes(); });
document.addEventListener('keydown', event => {
  const picker = event.target.closest('.theme-picker'); if (!picker) return;
  const trigger = picker.querySelector('[data-theme-trigger]');
  if (event.key === 'Escape') { closeThemes(); trigger.focus(); event.preventDefault(); }
  if (event.key === 'Tab') closeThemes();
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault(); closeLanguages(); openSelect?.close();
    const items = [...picker.querySelectorAll('[data-theme-option]')], index = items.indexOf(document.activeElement);
    picker.querySelector('.theme-menu').hidden = false; trigger.setAttribute('aria-expanded', 'true');
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
});

initializeSecurity({t,html,esc,api,action,notice,lock,load});
localizeShell();

// Keep native form values, but render every select with the shared menu appearance.
let openSelect = null, selectId = 0;
function enhanceSelects() {
  document.querySelectorAll('select:not([data-enhanced])').forEach(select => {
    select.dataset.enhanced = 'true';
    const label = select.closest('label');
    const labelText = label ? [...label.childNodes].filter(n => n !== select).map(n => n.textContent).join('').trim() : select.name;
    const wrapper = document.createElement('div'); wrapper.className = 'select-picker';
    select.before(wrapper); wrapper.append(select); select.hidden = true;
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'select-trigger';
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-label', labelText);
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'select-menu'; menu.id = 'select-menu-' + ++selectId;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', labelText); menu.setAttribute('popover', 'manual');
    trigger.setAttribute('aria-controls', menu.id); wrapper.append(trigger, menu);
    let active = select.selectedIndex, search = '', searchTimer;
    const choices = [...select.options].map((option, index) => {
      const item = document.createElement('div'); item.className = 'select-option'; item.id = menu.id + '-' + index;
      item.setAttribute('role', 'option'); item.setAttribute('aria-disabled', String(option.disabled));
      item.textContent = option.text; item.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); choose(index); });
      menu.append(item); return item;
    });
    function sync() {
      trigger.textContent = select.selectedOptions[0]?.text || ''; trigger.disabled = select.disabled;
      choices.forEach((item, i) => item.setAttribute('aria-selected', String(i === select.selectedIndex)));
    }
    select.syncDropdown = sync; sync();
    function highlight(index) {
      active = index; choices.forEach((item, i) => item.classList.toggle('highlighted', i === index));
      if (choices[index]) { trigger.setAttribute('aria-activedescendant', choices[index].id); choices[index].scrollIntoView({block:'nearest'}); }
    }
    function close(focus = false) {
      if (menu.matches(':popover-open')) menu.hidePopover();
      trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
      if (openSelect?.trigger === trigger) openSelect = null;
      if (focus) trigger.focus();
    }
    function open() {
      if (trigger.disabled) return;
      openSelect?.close(); closeLanguages(); closeThemes();
      const rect = trigger.getBoundingClientRect(), viewport = window.visualViewport;
      const height = viewport?.height || innerHeight, width = viewport?.width || innerWidth;
      const below = height - rect.bottom - 12, above = rect.top - 12;
      const upwards = below < 180 && above > below;
      menu.style.width = Math.min(Math.max(rect.width, 200), width - 24) + 'px';
      menu.style.maxHeight = Math.max(60, Math.min(280, upwards ? above : below)) + 'px';
      menu.style.left = Math.max(12, Math.min(rect.left, width - Math.max(rect.width, 200) - 12)) + 'px';
      menu.style.top = upwards ? 'auto' : rect.bottom + 6 + 'px';
      menu.style.bottom = upwards ? innerHeight - rect.top + 6 + 'px' : 'auto';
      menu.showPopover(); trigger.setAttribute('aria-expanded', 'true');
      openSelect = {trigger, menu, close}; highlight(select.selectedIndex);
    }
    function choose(index) {
      if (select.options[index]?.disabled) return;
      select.selectedIndex = index; sync(); close(true);
      select.dispatchEvent(new Event('input', {bubbles:true})); select.dispatchEvent(new Event('change', {bubbles:true}));
    }
    trigger.addEventListener('click', () => menu.matches(':popover-open') ? close() : open());
    trigger.addEventListener('keydown', event => {
      const key = event.key, shown = menu.matches(':popover-open');
      if (key === 'Escape' && shown) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (key === 'Tab') { close(); return; }
      if (['ArrowDown','ArrowUp','Home','End'].includes(key)) {
        event.preventDefault(); if (!shown) { open(); if (key.startsWith('Arrow')) return; }
        const enabled = choices.map((_,i)=>i).filter(i=>!select.options[i].disabled), at = enabled.indexOf(active);
        highlight(key==='Home'?enabled[0]:key==='End'?enabled.at(-1):enabled[(at+(key==='ArrowDown'?1:-1)+enabled.length)%enabled.length]); return;
      }
      if ((key === 'Enter' || key === ' ') && shown) { event.preventDefault(); choose(active); return; }
      if (key.length === 1 && !event.ctrlKey && !event.metaKey && key !== ' ') {
        event.preventDefault(); if (!shown) open(); clearTimeout(searchTimer); search += key.toLocaleLowerCase();
        searchTimer = setTimeout(()=>search='',700);
        const index = [...select.options].findIndex(o=>!o.disabled && o.text.toLocaleLowerCase().startsWith(search));
        if (index >= 0) highlight(index);
      }
    });
    select.addEventListener('change', sync);
    select.form?.addEventListener('reset', () => queueMicrotask(sync));
  });
}
new MutationObserver(() => {
  if (openSelect && !openSelect.trigger.isConnected) openSelect.close();
  enhanceSelects();
}).observe(document.body, {childList:true, subtree:true});
document.addEventListener('pointerdown', event => {
  if (openSelect && !openSelect.trigger.contains(event.target) && !openSelect.menu.contains(event.target)) openSelect.close();
});
window.addEventListener('resize', () => openSelect?.close());
document.addEventListener('scroll', event => { if (openSelect && !openSelect.menu.contains(event.target)) openSelect.close(); }, true);
enhanceSelects();

initializeCharts({t,esc,stamp});
initializeMaintenance({t,esc,api,action,modal,notice,load});

initializeBackups({t,esc,stamp,api,action,notice,load});

initializeAbuse({t,esc,api,action,notice,load});

initializeAccess({t,esc,api,action,notice,load,modal});
