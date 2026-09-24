let ctx;
const fields = {
  registrationGlobalMinute: ['全局登记 / 分钟', 10000], registrationAppMinute: ['每应用登记 / 分钟', 10000],
  challengeGlobalDay: ['全局挑战 / 日', 10000000], challengeAppDay: ['每应用挑战 / 日', 10000000],
  pendingGlobal: ['全局待确认登记', 100000], pendingApp: ['每应用待确认登记', 100000],
  challengeConcurrency: ['挑战发送并发', 32], taskGlobalDay: ['全局新任务 / 日', 10000000],
  taskAppDay: ['每应用新任务 / 日', 10000000], taskDeviceDay: ['每设备新任务 / 日', 10000000],
  attemptGlobalDay: ['全局投递尝试 / 日', 10000000], attemptAppDay: ['每应用投递尝试 / 日', 10000000],
};
export function initializeAbuse(context) { ctx = context; }
export function renderAbuse(v) {
  const { t, esc } = ctx;
  return `<div class="page-heading"><div><h1>${t('资源保护')}</h1><p>${t('限制登记与投递资源；暂停登记不影响已有设备确认和投递。')}</p></div></div>
    <section class="panel"><div class="panel-body"><form data-abuse-settings>
    <label class="check"><input type="checkbox" name="registrationEnabled" ${v.settings.registrationEnabled ? 'checked' : ''}>${t('允许新设备登记')}</label>
    <div class="retention-fields">${Object.entries(fields).map(([key, [label, max]]) => `<label>${t(label)}<input type="number" name="${key}" min="1" max="${max}" value="${v.settings[key]}" required></label>`).join('')}</div>
    <p class="help">${t('日额度按 UTC 零点重置；修改设置不会清空已用额度。每应用使用相同的独立额度。')}</p>
    <button class="primary" type="submit">${t('保存')}</button></form></div></section>
    <section class="panel"><div class="panel-head"><h2>${t('本次运行的保护统计')}</h2></div><div class="panel-body">
    <dl class="summary-stats">${[['正在处理请求',v.activeRequests],['正在发送挑战',v.activeChallenges],['省略的请求日志',v.droppedLogs],['资源清理失败',v.cleanupFailures]].map(([label,value])=>`<div><dt>${t(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
    <p class="help">${t('请求日志最多每分钟 120 条，最多并行写入 8 条；管理审计独立保留。统计在重启后归零。')}</p>
    <div class="table-wrap"><table><thead><tr><th>${t('拒绝原因')}</th><th>${t('数量')}</th></tr></thead><tbody>
    ${Object.entries(v.rejections).map(([key, count]) => `<tr><td>${esc(t(key))}</td><td>${count}</td></tr>`).join('') || `<tr><td colspan="2">${t('暂无记录')}</td></tr>`}
    </tbody></table></div></div></section>`;
}
document.addEventListener('submit', event => {
  const form = event.target;
  if (!form.matches('[data-abuse-settings]')) return;
  event.preventDefault();
  void ctx.action(async () => {
    const data = new FormData(form), settings = { registrationEnabled: data.has('registrationEnabled') };
    for (const key of Object.keys(fields)) settings[key] = Number(data.get(key));
    await ctx.api('/admin/abuse', 'PUT', settings);
    ctx.notice(ctx.t('设置已保存')); await ctx.load();
  });
});
