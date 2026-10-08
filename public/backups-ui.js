let ctx, savedSettings;
const endpointHints={b2:'https://s3.us-west-004.backblazeb2.com',r2:'https://<account-id>.r2.cloudflarestorage.com',aws:'https://s3.ap-southeast-2.amazonaws.com',custom:'https://objects.example.com'};
export function initializeBackups(context){ctx=context;}
const statusNames={enabled:'已启用',queued:'已入队',running:'执行中',retrying:'等待重试',completed:'已完成',failed:'失败',cancelled:'已取消',pending:'待执行',uploading:'上传中',disabled:'未启用',none:'—'};
const reasons={BucketVersioningRequired:'固定文件名需要存储桶开启版本管理',VersioningCheckFailed:'无法读取版本管理状态，请检查存储服务支持和密钥权限',AccessDenied:'对象存储权限不足，请检查访问密钥',BucketOrObjectNotFound:'存储桶或对象不存在',EncryptionFailed:'加密失败，请检查公钥',BackupTooLarge:'备份超过单次上传上限',RemoteObjectConflict:'远端同名对象不匹配',LocalBackupMissing:'本机备份已不存在，请创建新备份',LocalBackupFailed:'本机备份失败，请检查磁盘和数据库',RemoteVerificationFailed:'远端对象校验失败',B2Throttled:'对象存储请求受限',B2Unavailable:'对象存储暂时不可用',StorageThrottled:'对象存储请求受限',StorageUnavailable:'对象存储暂时不可用',BackupOperationFailed:'备份操作失败，请检查网络与服务日志',Interrupted:'任务因服务重启中断',ConfigurationChanged:'配置已变更，旧任务已取消'};
export function renderBackups(v){
 const {t,esc,stamp}=ctx,s=v.settings;
 savedSettings={...s};
 const check=v.remoteCheck;
 const remoteState=!s.enabled?'未启用':!v.workerOnline?'离线':!check||Date.now()-check.finished>900000?'待验证':check.remote_status==='completed'?'在线':'离线';
 const auth=()=>`<hr><label>${t('当前管理令牌')}<input type="password" name="currentToken" autocomplete="current-password" required></label>${v.twoFactorEnabled?`<label>${t('验证码或恢复码')}<input name="code" autocomplete="one-time-code" required></label>`:''}<button class="primary">${t('保存修改')}</button>`;
 const badge=value=>`<span class="badge ${['completed','enabled'].includes(value)?'green':['failed'].includes(value)?'red':['queued','running','uploading'].includes(value)?'blue':''}">${t(statusNames[value]||value)}</span>`;
 return `<div class="page-heading"><div><h1>${t('备份与恢复')}</h1><p>${t('本机定时备份，异地加密保存。')}</p></div><button data-backup-action="refresh">${t('↻ 刷新')}</button></div>
 <div class="metrics"><div class="metric"><div class="metric-label">${t('本地备份')}</div><div class="metric-value">${t(v.workerOnline?'在线':'离线')}</div><div class="metric-note">${t('最近本机备份')}：${esc(stamp(v.lastLocalSuccess))}</div></div><div class="metric"><div class="metric-label">${t('异地备份')}</div><div class="metric-value">${t(remoteState)}</div><div class="metric-note">${t('最近连接检查')}：${esc(stamp(check?.finished))}</div></div><div class="metric"><div class="metric-label">${t('最近异地备份')}</div><strong>${esc(stamp(v.lastRemoteSuccess))}</strong><div class="metric-note">${t('仅统计当前配置的备份上传')}</div></div><div class="metric"><div class="metric-label">${t('下次自动备份')}</div><strong>${esc(stamp(v.nextAt))}</strong></div></div>
 ${v.workerOnline?'':`<div class="callout">${t('备份服务未在线，已入队操作会在服务恢复后执行。')}</div>`}
 <div class="security-grid"><section class="panel"><div class="panel-head"><h2>${t('本地备份设置')}</h2></div><div class="panel-body"><form data-backup-settings="local">
 <div class="retention-fields"><label>${t('执行间隔（小时）')}<input name="intervalHours" type="number" min="1" max="168" value="${s.intervalHours}" required></label><label>${t('本机保留天数')}<input name="retentionDays" type="number" min="1" max="365" value="${s.retentionDays}" required></label></div>
 ${auth()}</form><hr><button class="primary" data-backup-action="run">${t('立即备份')}</button></div></section>
 <section class="panel"><div class="panel-head"><h2>${t('异地备份设置')}</h2>${badge(s.enabled?'enabled':'disabled')}</div><div class="panel-body"><form data-backup-settings="remote">
 <label class="check"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}>${t('启用异地备份')}</label>
 <label>${t('存储服务')}<select name="provider">${[['b2','Backblaze B2'],['r2','Cloudflare R2'],['aws','AWS S3'],['custom',t('自定义 S3 兼容服务')]].map(([value,label])=>`<option value="${value}" ${s.provider===value?'selected':''}>${label}</option>`).join('')}</select></label>
 <label>Endpoint<input name="endpoint" type="url" placeholder="${esc(endpointHints[s.provider]||endpointHints.b2)}" value="${esc(s.endpoint)}" maxlength="250"></label>
 <label>Region<input name="region" value="${esc(s.region)}" maxlength="63" placeholder="us-east-1 / auto"></label>
 <label class="check"><input type="checkbox" name="forcePathStyle" ${s.forcePathStyle?'checked':''}>${t('使用路径式寻址')}</label><p class="help">${t('B2 区域取自 Endpoint；R2 使用 auto；其他服务填写存储桶区域。')}</p>
 <label>Bucket<input name="bucket" value="${esc(s.bucket)}" maxlength="63" autocomplete="off"></label>
 <label>${t('对象目录前缀')}<input name="prefix" value="${esc(s.prefix)}" maxlength="200" required></label>
 <label class="check"><input type="checkbox" name="fixedFileName" ${s.fixedFileName?'checked':''}>${t('固定文件名（使用对象版本管理）')}</label><p class="help">${t('开启后每次上传到同一个 archives/backup.tar.age；上传前检查版本管理，历史备份通过版本 ID 区分。')}</p>
 <label>Access Key ID<input name="keyId" value="${esc(s.keyId)}" maxlength="128" autocomplete="off"></label>
 <label>Secret Access Key<input name="applicationKey" type="password" autocomplete="new-password" maxlength="256" placeholder="${t(s.hasApplicationKey?'已保存，留空保留原密钥':'尚未配置')}"></label>
 <label>${t('加密公钥')}<textarea name="recipient" rows="3" maxlength="100" placeholder="age1…">${esc(s.recipient)}</textarea></label>
 <label>${t('从公钥文件导入')}<input type="file" data-backup-public-key accept=".txt,.pub"></label>
 <p class="help">${t('仅填写 age1 开头的公钥。解密私钥必须离线保管，切勿上传。')}</p>
 ${auth()}</form><hr><button type="button" data-backup-action="test" ${s.hasApplicationKey?'':'disabled'}>${t('测试连接')}</button>
 <p class="help">${t('连接测试使用已保存的异地设置；修改后请先保存。')}</p><p class="help">${t('在线表示最近 15 分钟内连接检查或上传成功，超时后显示待验证。')}</p>
 <details><summary>${t('对象存储配置要求')}</summary><p class="help">${t('使用私有存储桶和限定该桶及目录的应用密钥，授予读取与写入文件权限。无需删除权限。')}</p><p class="help">${t('远端保留期请在存储服务控制台配置生命周期规则。本机清理不会删除远端备份。')}</p>
 </details><details><summary>${t('准备加密公钥')}</summary><p class="help">${t('在你自己的电脑安装 age 并生成密钥，妥善保存私钥文件，仅将输出的公钥填入此页。')}</p><pre>age-keygen -o backup-identity.txt</pre></details>
 <details><summary>${t('恢复与校验')}</summary><p class="help">${t('下载 .age 备份，在持有私钥的电脑解密，再用运维脚本恢复到临时数据库验证。页面不会覆盖当前数据库。')}</p><pre>age -d -i backup-identity.txt -o backup.tar backup.tar.age</pre><p class="help">${t('本机与远端副本都包含敏感运行数据，请私密保管。')}</p></details>
 </div></section></div>
 <section class="panel"><div class="panel-head"><h2>${t('备份记录')}</h2><small>${t('最近 30 次操作')}</small></div><div class="table-wrap"><table><thead><tr>${['时间','类型','状态','本机备份','异地上传','详情','操作'].map(x=>`<th>${t(x)}</th>`).join('')}</tr></thead><tbody>${v.jobs.length?v.jobs.map(j=>`<tr><td>${esc(stamp(j.created))}</td><td>${t(j.kind==='test'?'连接测试':'备份')}<small>${t(j.source==='manual'?'手动':'自动')}</small></td><td>${badge(j.state)}</td><td>${j.kind==='test'?'—':badge(j.local_status)}</td><td>${badge(j.remote_status)}</td><td><small>${esc(j.remote_key||j.local_file||j.id)}</small>${j.remote_version?`<small>${t('版本 ID')}：${esc(j.remote_version)}</small>`:''}${j.error?`<small>${esc(t(reasons[j.error]||'备份操作失败，请检查网络与服务日志'))}</small>`:''}${j.state==='retrying'?`<small>${t('下次重试')}：${esc(stamp(j.next_at))}</small>`:''}</td><td>${['failed','retrying'].includes(j.state)&&j.config_revision===s.revision?`<button data-backup-retry="${esc(j.id)}">${t('重试')}</button>`:''}</td></tr>`).join(''):`<tr><td colspan="7">${t('暂无记录')}</td></tr>`}</tbody></table></div></section>`;
}
document.addEventListener('change',event=>{
 const field=event.target,form=field.form;
 if(form?.dataset.backupSettings==='remote'&&['provider','endpoint'].includes(field.name)){
  const provider=form.elements.provider.value;
  if(field.name==='provider'){form.elements.endpoint.placeholder=endpointHints[provider];form.elements.forcePathStyle.checked=provider!=='aws';form.elements.region.value=provider==='r2'?'auto':provider==='b2'?'':'us-east-1';}
  if(provider==='b2'){const region=/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/.exec(form.elements.endpoint.value.trim())?.[1];if(region)form.elements.region.value=region;}
 }

 if(!event.target.matches('[data-backup-public-key]'))return;
 const input=event.target,file=input.files[0];if(!file)return;
 void ctx.action(async()=>{try{if(file.size>200)throw Error(ctx.t('只接受单行 age 公钥文件'));const key=(await file.text()).trim();if(!/^age1[0-9a-z]{58}$/.test(key))throw Error(ctx.t('只接受单行 age 公钥文件'));input.form.elements.recipient.value=key;}finally{input.value='';}});
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!form.matches('[data-backup-settings]'))return;event.preventDefault();
 void ctx.action(async()=>{
  const f=new FormData(form),settings={...savedSettings};
  if(form.dataset.backupSettings==='local'){for(const key of ['intervalHours','retentionDays'])settings[key]=Number(f.get(key));}
  else{settings.enabled=f.has('enabled');settings.forcePathStyle=f.has('forcePathStyle');settings.fixedFileName=f.has('fixedFileName');for(const key of ['endpoint','bucket','prefix','keyId','recipient','provider','region'])settings[key]=String(f.get(key)||'');}
  try{await ctx.api('/admin/backups','PUT',{settings,revision:savedSettings.revision,applicationKey:f.get('applicationKey')||undefined,currentToken:f.get('currentToken'),code:f.get('code')});if(form.elements.applicationKey)form.elements.applicationKey.value='';ctx.notice(ctx.t('备份设置已保存'));await ctx.load();}
  finally{form.elements.currentToken.value='';if(form.elements.code)form.elements.code.value='';}
 });
});
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-backup-action],[data-backup-retry]');if(!button)return;
 void ctx.action(async()=>{const action=button.dataset.backupAction;if(action==='refresh')return ctx.load();await ctx.api(button.dataset.backupRetry?'/admin/backups/'+button.dataset.backupRetry+'/retry':'/admin/backups/'+action,'POST',{});ctx.notice(ctx.t('操作已入队，请刷新查看执行结果'));await ctx.load();});
});
