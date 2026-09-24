let ctx;
export function initializeAccess(context){ctx=context;}
const options=(apps,id)=>apps.map(a=>`<option value="${ctx.esc(a.id)}" ${a.id===id?'selected':''}>${ctx.esc(a.name)}</option>`).join('');
export function renderAccess(v,apps,id){
  const {t,esc}=ctx,p=v.policy.settings,q=v.quotas;
  const quotaFields={registrationAppMinute:'每分钟登记',challengeAppDay:'每日挑战',pendingApp:'待确认登记',taskAppDay:'每日新任务',taskDeviceDay:'每设备每日任务',attemptAppDay:'每日发送尝试'};
  return `<div class="page-heading"><h1>${t('接入与验证')}</h1></div><label>${t('应用')}<select data-access-app>${options(apps,id)}</select></label>
  <section class="panel"><div class="panel-head"><h2>${t('应用真实性与服务器资格')}</h2></div><div class="panel-body"><form data-access-policy data-app="${esc(id)}">
  <label class="check"><input type="checkbox" name="requireTrustedServers" ${p.requireTrustedServers?'checked':''}>${t('只允许已批准的服务器')}</label>
  <label class="check"><input type="checkbox" name="iosRequired" ${p.iosRequired?'checked':''}>${t('iOS 必须通过 App Attest')}</label>
  <div class="retention-fields"><label>Apple Team ID<input name="teamId" value="${esc(p.teamId)}" maxlength="10"></label><label>Bundle ID<input name="bundleId" value="${esc(p.bundleId)}" maxlength="200"></label>
  <label>${t('App Attest 环境')}<select name="appleEnvironment"><option value="production" ${p.appleEnvironment==='production'?'selected':''}>${t('生产')}</option><option value="development" ${p.appleEnvironment==='development'?'selected':''}>${t('开发')}</option></select></label></div>
  <label class="check"><input type="checkbox" name="androidRequired" ${p.androidRequired?'checked':''}>${t('Android 必须通过 Play Integrity')}</label>
  <div class="retention-fields"><label>${t('Android 包名')}<input name="packageName" value="${esc(p.packageName)}"></label><label>Google Cloud Project Number<input name="cloudProjectNumber" value="${esc(p.cloudProjectNumber)}"></label></div>
  <label>${t('签名证书 SHA-256（Base64URL，每行一个）')}<textarea name="certificateDigests" rows="3" spellcheck="false">${esc(p.certificateDigests.join('\n'))}</textarea></label>
  <label>${t('Google 服务账号 JSON（留空保留）')}<textarea name="googleServiceAccount" rows="6" autocomplete="off" spellcheck="false"></textarea></label>
  <p class="help">${t(v.policy.hasGoogleCredential?'Google 验证凭据已配置':'Google 验证凭据未配置')}</p>
  <p class="callout">${t('保存验证策略会撤销此应用的设备登记和待发送任务，客户端需要重新登记。')}</p>
  <button type="submit" class="primary">${t('保存验证策略')}</button></form></div></section>
  <section class="panel"><div class="panel-head"><h2>${t('此应用的独立额度')}</h2></div><div class="panel-body"><form data-app-quotas data-app="${esc(id)}">
  <label>${t('新登记')}<select name="registrationEnabled"><option value="">${t('继承全局')}</option><option value="true" ${q.overrides.registrationEnabled===true?'selected':''}>${t('允许')}</option><option value="false" ${q.overrides.registrationEnabled===false?'selected':''}>${t('暂停')}</option></select></label>
  <div class="retention-fields">${Object.entries(quotaFields).map(([key,label])=>`<label>${t(label)}<input type="number" min="1" max="${key==='registrationAppMinute'?10000:key==='pendingApp'?100000:10000000}" name="${key}" value="${q.overrides[key]??''}" placeholder="${q.effective[key]}"></label>`).join('')}</div>
  <p class="help">${t('留空继承全局默认值；全局总额度和暂停开关始终生效。修改不会清空已用额度。')}</p><button class="primary">${t('保存额度')}</button></form></div></section>`;
}
export function renderServers(v){const {t,esc}=ctx;return `<div class="page-heading"><h1>${t('服务器接入')}</h1></div>
  <section class="panel"><div class="panel-body"><form data-server-request><label>Server ID<input name="id" required maxlength="100"></label><label>${t('名称')}<input name="name" required maxlength="100"></label><label>${t('允许的应用 ID（逗号分隔）')}<input name="apps" required></label><p class="help">${t('填写业务 Server 已有的 Server ID。登记后处于待审批状态，批准时生成一次性显示的专用凭证。')}</p><button class="primary">${t('登记待审批服务器')}</button></form></div></section>
  <section class="panel"><div class="table-wrap"><table><thead><tr><th>Server ID</th><th>${t('名称')}</th><th>${t('状态')}</th><th>${t('应用')}</th><th>${t('操作')}</th></tr></thead><tbody>${v.servers.map(s=>`<tr><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${t({pending:'待审批',approved:'已批准',blocked:'已封禁'}[s.state])}</td><td>${esc(s.apps.join(', '))}</td><td>${s.state!=='approved'?`<button data-server-action="approve" data-id="${esc(s.id)}">${t('批准')}</button>`:`<button data-server-action="rotate" data-id="${esc(s.id)}">${t('轮换凭证')}</button>`} ${s.state!=='blocked'?`<button class="danger" data-server-action="block" data-id="${esc(s.id)}">${t('封禁')}</button>`:''}</td></tr>`).join('')||`<tr><td colspan="5">${t('暂无记录')}</td></tr>`}</tbody></table></div></section>`;}
export function renderAlerts(v){const {t,esc}=ctx,s=v.settings;const fields={rejections:'五分钟拒绝次数',queueDepth:'队列积压数量',oldestSeconds:'最老任务等待秒数',failures:'五分钟失败次数',cooldownSeconds:'重复告警间隔秒数'};
  return `<div class="page-heading"><h1>${t('异常告警')}</h1></div><section class="panel"><div class="panel-body"><form data-alert-settings>
  <label class="check"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}>${t('启用自动告警')}</label><label>HTTPS Webhook URL<input name="url" type="url" placeholder="${esc(v.host||'https://example.com/webhook')}" autocomplete="off"></label><label>${t('HMAC 签名密钥（可选，留空保留）')}<input type="password" name="signingSecret" autocomplete="new-password"></label>
  <p class="help">${t(v.configured?'Webhook 已配置，留空保留地址':'Webhook 尚未配置')}</p>
  <div class="retention-fields">${Object.entries(fields).map(([key,label])=>`<label>${t(label)}<input name="${key}" type="number" min="${key==='cooldownSeconds'?60:1}" max="${key==='cooldownSeconds'?86400:10000000}" value="${s[key]}" required></label>`).join('')}</div>
  <p class="help">${t('每分钟检查一次，发送异常及恢复通知。失败最多尝试六次；接收方应按事件 ID 去重。修改配置取消旧的待发告警。')}</p><button class="primary">${t('保存')}</button></form></div></section>
  <section class="panel"><div class="panel-head"><h2>${t('最近告警')}</h2></div><div class="panel-body">${v.workerFailed?`<p class="callout">${t('告警检查失败，请检查服务日志')}</p>`:''}<div class="table-wrap"><table><thead><tr><th>${t('时间')}</th><th>${t('类型')}</th><th>${t('状态')}</th><th>${t('尝试次数')}</th></tr></thead><tbody>${v.recent.map(r=>`<tr><td>${esc(new Date(r.created).toLocaleString())}</td><td>${esc(r.kind)}</td><td>${esc(r.state)}</td><td>${r.attempts}</td></tr>`).join('')||`<tr><td colspan="4">${t('暂无记录')}</td></tr>`}</tbody></table></div></div></section>`;
}
document.addEventListener('change',event=>{if(event.target.matches('[data-access-app]'))location.hash='access?appId='+encodeURIComponent(event.target.value);});
document.addEventListener('submit',event=>{
  const form=event.target;if(!form.matches('[data-access-policy],[data-app-quotas],[data-server-request],[data-alert-settings]'))return;
  event.preventDefault();void ctx.action(async()=>{const data=new FormData(form),{api,t,notice,load}=ctx;
    if(form.matches('[data-access-policy]')){
      const settings={};for(const key of ['requireTrustedServers','iosRequired','androidRequired'])settings[key]=data.has(key);
      for(const key of ['teamId','bundleId','appleEnvironment','packageName','cloudProjectNumber'])settings[key]=data.get(key).trim();
      settings.certificateDigests=data.get('certificateDigests').split(/\s+/).filter(Boolean);
      const body={settings},google=data.get('googleServiceAccount').trim();if(google)body.googleServiceAccount=JSON.parse(google);
      await api('/admin/apps/'+encodeURIComponent(form.dataset.app)+'/access','PUT',body);
    }else if(form.matches('[data-app-quotas]')){const body={};for(const [key,value] of data)if(value!=='')body[key]=key==='registrationEnabled'?value==='true':Number(value);await api('/admin/apps/'+encodeURIComponent(form.dataset.app)+'/quotas','PUT',body);
    }else if(form.matches('[data-server-request]'))await api('/admin/servers','POST',{id:data.get('id').trim(),name:data.get('name').trim(),apps:data.get('apps').split(',').map(x=>x.trim()).filter(Boolean)});
    else{const settings={enabled:data.has('enabled')};for(const key of ['rejections','queueDepth','oldestSeconds','failures','cooldownSeconds'])settings[key]=Number(data.get(key));await api('/admin/alerts','PUT',{settings,url:data.get('url').trim(),signingSecret:data.get('signingSecret')});}
    notice(t('设置已保存'));await load();
  });
});
document.addEventListener('click',event=>{const button=event.target.closest('[data-server-action]');if(!button)return;void ctx.action(async()=>{
  const result=await ctx.api('/admin/servers/'+encodeURIComponent(button.dataset.id),'POST',{action:button.dataset.serverAction});
  await ctx.load();if(result.credential)ctx.modal(ctx.t('保存服务器凭证'),`<p>${ctx.t('仅显示一次。放入业务 Server 的 GATEWAY_SERVER_CREDENTIAL，不要发送给客户端。此次操作已撤销该服务器的旧设备登记。')}</p><textarea readonly>${ctx.esc(result.credential)}</textarea>`,async()=>{},ctx.t('关闭'));
  else ctx.notice(ctx.t('服务器已封禁，设备登记已撤销'));
});});
