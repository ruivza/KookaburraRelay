let ctx, setup;
export function initializeSecurity(context){ctx=context;}
export function clearSecurity(){setup=null;}
export function renderSecurity(status){
  const {t,html,esc}=ctx;
  if(setup)return `<div class="page-heading"><div><h1>${t('绑定验证器')}</h1><p>${t('使用验证器扫描二维码，或手动输入密钥。')}</p></div></div><section class="panel security-panel"><div class="panel-body"><img class="totp-qr" src="${esc(setup.qr)}" alt="${t('验证器二维码')}"><code class="setup-secret">${esc(setup.secret)}</code><form data-security="confirm">${reauth(false)}<label>${t('验证码')}<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><div class="row-actions"><button class="primary">${t('验证并启用')}</button><button type="button" data-security-cancel>${t('取消')}</button></div></form></div></section>`;
  return `<div class="page-heading"><div><h1>${t('安全设置')}</h1><p>${t('管理登录凭据与两步验证。')}</p></div></div><div class="security-grid"><section class="panel"><div class="panel-head"><h2>${t('修改管理令牌')}</h2></div><div class="panel-body"><form data-security="token">${reauth(status.twoFactorEnabled)}<label>${t('新管理令牌')}<input name="newToken" type="password" autocomplete="new-password" minlength="32" maxlength="256" required></label><label>${t('确认新令牌')}<input name="confirmToken" type="password" autocomplete="new-password" minlength="32" maxlength="256" required></label><p class="help">${t('使用 32–256 位无空格字符。保存后所有会话退出。')}</p><button class="primary">${t('保存修改')}</button></form></div></section><section class="panel"><div class="panel-head"><h2>${t('两步验证')}</h2><span class="badge ${status.twoFactorEnabled?'green':''}">${t(status.twoFactorEnabled?'已启用':'未启用')}</span></div><div class="panel-body"><p class="help">${t('支持 Apple 密码、Google Authenticator、1Password 等验证器。')}</p>${status.twoFactorEnabled?`<p class="help">${t('剩余恢复码')}：${status.recoveryCodesRemaining}</p>`:''}<form data-security="${status.twoFactorEnabled?'disable':'setup'}">${reauth(status.twoFactorEnabled)}<button class="${status.twoFactorEnabled?'danger':'primary'}">${t(status.twoFactorEnabled?'关闭两步验证':'绑定验证器')}</button></form></div></section></div>`;
}
function reauth(factor){const {t}=ctx;return `<label>${t('当前管理令牌')}<input name="currentToken" type="password" autocomplete="current-password" maxlength="512" required></label>${factor?`<label>${t('验证码或恢复码')}<input name="code" autocomplete="one-time-code" maxlength="64" required></label>`:''}`;}
document.addEventListener('submit',event=>{
  const form=event.target;if(!form.matches('[data-security]'))return;event.preventDefault();
  const {api,action,notice,t,lock,esc}=ctx;
  void action(async()=>{
    const body=Object.fromEntries(new FormData(form)),kind=form.dataset.security;
    if(kind==='token'&&body.newToken!==body.confirmToken)throw Error(t('两次输入的令牌不一致'));
    const result=await api('/admin/security/'+kind,'POST',body);
    form.reset();
    if(kind==='setup'){setup=result;document.getElementById('content').innerHTML=renderSecurity({});return;}
    setup=null;lock();
    if(result.recoveryCodes){
      const dialog=document.getElementById('modal');
      dialog.innerHTML=`<div class="modal-head"><h2 id="modal-title">${t('保存恢复码')}</h2></div><p class="help">${t('每个恢复码只能使用一次。请保存在安全的位置；关闭后不再显示。')}</p><div class="recovery-codes">${result.recoveryCodes.map(c=>`<code>${esc(c)}</code>`).join('')}</div><label class="check"><input type="checkbox" id="saved-recovery">${t('我已保存恢复码')}</label><div class="modal-actions"><button id="finish-recovery" class="primary" disabled>${t('返回登录')}</button></div>`;
      dialog.oncancel=e=>e.preventDefault();dialog.showModal();
      document.getElementById('saved-recovery').onchange=e=>document.getElementById('finish-recovery').disabled=!e.target.checked;
      document.getElementById('finish-recovery').onclick=()=>{dialog.close();dialog.replaceChildren();dialog.oncancel=null;};
    }else notice(t('安全设置已更新，请重新登录。'));
  });
});
document.addEventListener('click',event=>{if(event.target.closest('[data-security-cancel]')){setup=null;void ctx.load();}});
