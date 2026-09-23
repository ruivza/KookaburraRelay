// Only developer-authored strings and template literal segments are translated.
// Values interpolated into html (application names, IDs, logs) remain untouched.
const english = Object.fromEntries(`
外观|Appearance
跟随系统|System
浅色|Light
深色|Dark
本地备份|Local backups
异地备份|Off-site backups
本地备份设置|Local backup settings
异地备份设置|Off-site backup settings
最近连接检查|Last connection check
待验证|Unverified
连接测试使用已保存的异地设置；修改后请先保存。|Connection tests use saved off-site settings. Save changes before testing.
在线表示最近 15 分钟内连接检查或上传成功，超时后显示待验证。|Online means a connection check or upload succeeded within 15 minutes; older results are shown as unverified.
备份设置已保存|Backup settings saved
存储服务|Storage provider
自定义 S3 兼容服务|Custom S3-compatible service
使用路径式寻址|Use path-style addressing
B2 区域取自 Endpoint；R2 使用 auto；其他服务填写存储桶区域。|B2 derives its region from the endpoint; R2 uses auto; for other services enter the bucket region.
对象存储权限不足，请检查访问密钥|Storage access denied; check the access key
对象存储请求受限|Storage request throttled
对象存储暂时不可用|Storage temporarily unavailable
测试连接|Test connection
对象存储配置要求|Object storage requirements
远端保留期请在存储服务控制台配置生命周期规则。本机清理不会删除远端备份。|Configure retention with lifecycle rules in your storage console. Local cleanup does not delete remote backups.
固定文件名需要存储桶开启版本管理|Fixed filenames require bucket versioning to be enabled
无法读取版本管理状态，请检查存储服务支持和密钥权限|Cannot read versioning status; check storage support and key permissions
固定文件名（使用对象版本管理）|Fixed filename (use object versioning)
开启后每次上传到同一个 archives/backup.tar.age；上传前检查版本管理，历史备份通过版本 ID 区分。|Uploads use the same archives/backup.tar.age key. Versioning is checked before upload; version IDs identify historical backups.
版本 ID|Version ID
使用左右方向键查看采样值|Use arrow keys to inspect samples
无采样数据|No sample data
峰值|Peak
备份与恢复|Backup & recovery
本机定时备份，异地加密保存。|Scheduled local backups with encrypted off-site copies.
备份服务|Backup worker
在线|Online
离线|Offline
由独立备份容器执行|Runs in the dedicated backup container
最近本机备份|Last local backup
最近异地备份|Last remote backup
仅统计当前配置的备份上传|Backup uploads for the current configuration
下次自动备份|Next scheduled backup
备份服务未在线，已入队操作会在服务恢复后执行。|The backup worker is offline. Queued operations will run when it returns.
启用异地备份|Enable off-site backups
对象目录前缀|Object prefix
已保存，留空保留原密钥|Saved; leave blank to keep the key
尚未配置|Not configured
加密公钥|Encryption public key
从公钥文件导入|Import a public key file
仅填写 age1 开头的公钥。解密私钥必须离线保管，切勿上传。|Enter only an age1 public key. Keep the decryption identity offline; never upload it.
本机保留天数|Local retention (days)
修改配置需要重新验证身份。B2 密钥加密保存，不会回显。|Changes require reauthentication. The B2 key is encrypted and never returned.
备份操作|Backup operations
操作使用已保存的配置。本机备份不受异地开关影响。|Operations use the saved configuration. Local backups run even when off-site backups are disabled.
立即备份|Back up now
测试 B2 连接|Test B2 connection
连接测试会上传加密的小测试文件并检查结果，不上传数据库。|The connection test uploads and verifies a small encrypted test file, without a database backup.
B2 配置要求|B2 requirements
使用私有存储桶和限定该桶及目录的应用密钥，授予读取与写入文件权限。无需删除权限。|Use a private bucket and an application key restricted to its bucket and prefix with read and write file permissions. Delete permission is not required.
远端保留期请在 B2 控制台配置生命周期规则，建议先保留 30 天。本机清理不会删除远端备份。|Set lifecycle rules in B2, initially retaining 30 days. Local cleanup does not delete remote backups.
准备加密公钥|Prepare an encryption public key
在你自己的电脑安装 age 并生成密钥，妥善保存私钥文件，仅将输出的公钥填入此页。|Install age on your own computer and generate a key. Keep the identity file safe and enter only the public key here.
恢复与校验|Restore and verify
下载 .age 备份，在持有私钥的电脑解密，再用运维脚本恢复到临时数据库验证。页面不会覆盖当前数据库。|Download the .age backup and decrypt it on the computer holding your identity. Use the operations script to verify it in a disposable database. This page never overwrites the live database.
本机与远端副本都包含敏感运行数据，请私密保管。|Both local and remote copies contain sensitive operational data. Keep them private.
备份记录|Backup history
最近 30 次操作|Latest 30 operations
类型|Type
本机备份|Local backup
异地上传|Remote upload
连接测试|Connection test
备份|Backup
下次重试|Next retry
只接受单行 age 公钥文件|Only a single-line age public key file is accepted
操作已入队，请刷新查看执行结果|Operation queued. Refresh to view the result.
执行中|Running
待执行|Pending
上传中|Uploading
B2 权限不足，请检查应用密钥|B2 access denied; check the application key
存储桶或对象不存在|Bucket or object not found
加密失败，请检查公钥|Encryption failed; check the public key
备份超过单次上传上限|Backup exceeds the single-upload limit
远端同名对象不匹配|Remote object with the same name does not match
本机备份已不存在，请创建新备份|Local backup no longer exists; create a new backup
本机备份失败，请检查磁盘和数据库|Local backup failed; check disk and database availability
远端对象校验失败|Remote object verification failed
B2 请求受限|B2 request throttled
B2 暂时不可用|B2 temporarily unavailable
备份操作失败，请检查网络与服务日志|Backup operation failed; check network and service logs
任务因服务重启中断|Operation interrupted by restart
配置已变更，旧任务已取消|Configuration changed; old operation cancelled
来源|Source
存储与清理|Storage & cleanup
请求日志|Request logs
错误日志|Error logs
审计日志|Audit logs
已完成推送|Finished deliveries
监控采样|Metrics
探测记录|Probe records
运行历史|Run history
过期登记与会话|Expired registrations & sessions
按需保留记录，让网关轻装运行。|Keep the history you need.
自动清理|Automatic cleanup
启用自动清理|Enable automatic cleanup
执行间隔（小时）|Run every (hours)
保留天数|Retention days
预览并保存|Preview & save
预览设置|Preview settings
以下记录将符合新的清理规则，保存后在下次计划执行。预览有效期为 5 分钟。|These records qualify under the new policy. Saving schedules cleanup for the next run. This preview expires in 5 minutes.
保存后将停用自动清理，不会执行下方预览的清理。预览有效期为 5 分钟。|Saving disables automatic cleanup; the previewed cleanup will not run. This preview expires in 5 minutes.
手动清理|Manual cleanup
清理范围|Cleanup scope
按当前保留周期|Use current retention policy
指定日期之前|Before a specific date
截止日期|Cutoff date
仅清理历史记录及过期数据，保留配置、密钥和未完成任务。|Only history and expired data are removed. Settings, keys and unfinished jobs are preserved.
预览清理|Preview cleanup
数据库占用|Database size
下次自动清理|Next scheduled cleanup
清理状态|Cleanup status
正在清理|Running
空闲|Idle
删除后的数据库空间可被重新使用，磁盘文件不一定立即缩小。|Deleted space can be reused by PostgreSQL; files may not shrink immediately.
清理历史|Cleanup history
删除记录数|Deleted records
手动|Manual
自动|Automatic
已完成|Completed
部分完成|Partially completed
确认保留周期|Confirm retention policy
确认清理|Confirm cleanup
以下记录将符合新的清理规则，保存后在下次计划执行。|These records will qualify under the new policy at the next scheduled cleanup.
以下记录将被永久删除。预览有效期为 5 分钟。|These records will be permanently deleted. The preview is valid for 5 minutes.
我已确认清理范围|I have reviewed the cleanup scope
设置已保存|Settings saved
清理已开始，可刷新查看结果|Cleanup started. Refresh to see the result.
开始清理|Start cleanup

总览|Overview
应用管理|Applications
APNs 通道|APNs channels
Android 通道|Android channels
推送记录|Deliveries
设备登记|Devices
运行监控|Monitoring
日志与审计|Logs & audit
已入队|Queued
等待重试|Retry scheduled
发送中|Sending
通道已接受|Provider accepted
发送失败|Failed
结果未知|Unknown outcome
已取消|Cancelled
会话已结束|Your session has ended.
管理令牌不正确或已失效，请使用网关 admin.token 中的令牌。|The token is incorrect or expired. Use the token from the gateway’s admin.token file.
请求失败，请稍后重试|The request failed. Please try again.
请求超时，请刷新确认操作结果。|The request timed out. Refresh to check whether it completed.
↻ 刷新|Refresh
暂无记录|No records yet
符合筛选条件的数据会显示在这里。|Records matching your filters will appear here.
尚未发送|Not sent yet
详情|Details
取消|Cancel
网关总览|Gateway overview
应用、通道与投递状态，一目了然。|Your applications, channels, and deliveries in one place.
＋ 添加应用|Add application
添加应用|Add application
应用|Application
个已启用|enabled
有效设备|Verified devices
已完成设备接收验证|Device verification completed
通道已接受 · 24h|Accepted · 24h
不代表设备已收到|Acceptance is not a delivery receipt
待处理任务|Pending tasks
24h 失败 / 未知|Failed or unknown · 24h
应用概况|Your applications
每个应用独立配置推送通道|Independent channels for each application
配置状态|Configuration
设备|Device
已配置|Configured
待配置|Not configured
已停用|Disabled
还没有应用|No applications yet
创建应用后配置 APNs 或 Android 通道。|Create an application to configure its APNs or Android channel.
查看全部 →|View all →
当前运行|Service status
当前实例的实时状态|Live information from this instance
网关服务|Gateway
已连接管理 API|Management API connected
运行中|Running
本次运行时长|Current uptime
启动于|Started
内存占用|Memory usage
进程驻留内存 RSS|Resident memory (RSS)
运行监控 →|View monitoring →
最近推送|Recent deliveries
真实投递记录 · 不包含消息正文或设备 token|Delivery history without message content or device tokens
应用 / 任务|Application / task
通道|Channel
状态|Status
时间|Time
响应|Response
尚无推送记录|No deliveries yet
完成设备登记并发送同步提示后，这里会显示处理结果。|Register a device and send a sync hint to see its result here.
管理应用名称、启停状态和通道配置。|Manage application details, availability, and push channels.
全部应用|All applications
个应用 · 配置变更会撤销该应用现有设备登记|applications · Configuration changes revoke that application’s device registrations
接受 / 失败¹|Accepted / failed¹
操作|Actions
已启用|Enabled
编辑|Edit
删除|Delete
点击“添加应用”，建立你的第一个推送应用。|Choose “Add application” to get started.
¹ 保留期内的任务统计，失败包含结果未知。重命名不影响设备登记；停用、更新或删除通道后需重新登记。|¹ Counts cover the retention period; failures include unknown outcomes. Renaming preserves registrations. Disabling, updating, or removing channels requires devices to register again.
通过 Firebase Cloud Messaging 发送 Android 后台同步提示。|Send Android background sync hints through Firebase Cloud Messaging.
管理 Apple 推送密钥、Bundle ID 和开发 / 生产环境。|Manage Apple push credentials, bundle IDs, and environments.
FCM 通道已实现，需上传 Firebase 服务账号 JSON。Android 客户端需接入挑战确认协议；本项目尚未提供 Android App。|Upload a Firebase service account JSON file to configure FCM. Android clients must implement challenge verification. An Android app is not included.
私钥加密保存，不会回显。开发环境与生产环境需要匹配设备 token；保存配置仅校验格式，不代表 Apple 已授权或真机已送达。|Private keys are encrypted and never displayed. Match the environment to your device token. Saving validates the configuration format, not Apple authorization or device delivery.
← 显示全部应用|← All applications
应用已停用|Application disabled
通道已停用|Channel disabled
Firebase 项目|Firebase project
环境|Environment
生产|Production
开发 + 生产|Sandbox + production
开发与生产|Sandbox and production
开发|Sandbox
已验证设备|Verified devices
（应用总计）|(application total)
编辑配置|Edit configuration
配置通道|Configure channel
移除|Remove
测试|Test
请先创建应用|Create an application first
前往应用管理 →|Go to applications →
其他厂商通道|More providers
以下通道尚未实现，不接受设备登记或推送。|These providers are not connected yet.
尚未接入|Not available
需要独立适配厂商认证、设备登记和发送接口。|Provider authentication, registration, and delivery support are required.
全部通道|All channels
全部状态|All statuses
全部类型|All types
类型|Type
管理审计|Audit
请求|Request
错误|Error
近 30 天|Last 30 days
最近 24 小时|Last 24 hours
最近 1 小时|Last hour
筛选|Filter
共|Total
条 · 第|items · Page
页|
上一页|Previous
下一页|Next
创建时间|Created
尝试 / 原因|Attempts / reason
最近耗时|Last latency
异步任务由网关重试；兼容接口由业务 Server 重试。未知结果不会由网关自动重发。|The gateway retries async tasks. Your server retries legacy requests. Unknown outcomes are not retried automatically by the gateway.
通道 / 环境|Channel / environment
验证状态|Verification
凭证到期|Credentials expire
已验证|Verified
等待挑战|Awaiting verification
测试推送|Test push
撤销|Revoke
设备完成挑战确认后才能发送。撤销会同时取消待发送任务。|Devices must complete verification before receiving pushes. Revoking a device cancels its pending tasks.
响应 / 耗时|Response / latency
请求 ID|Request ID
记录请求结果与配置变更，不记录私钥、凭证、设备 token 或消息正文。|Request results and configuration changes. No private keys, credentials, device tokens, or message content.
记录列表|Records
每页|Per page:
条|items
正在采集运行数据|Collecting data
每分钟采样一次，尚无历史数据。|Samples are collected every minute. History will appear here.
峰值|Peak
最后采样|Last sampled
探针活跃|Probe active
探针数据过期|Probe data stale
已采样请求成功率 ·|Sampled request success rate ·
个样本|samples
过去24小时探针状态|Probe observations over the last 24 hours
成功|successful
未知 / 未采样|Unknown / not sampled
未知|Unknown
真实采样与独立探测，区分运行时长、可用性和推送结果。|Understand uptime, availability, and delivery performance.
本次 Uptime|Current uptime
进程内存|Process memory
RSS · 当前实例|RSS · Current instance
排队、重试与发送中|Queued, retrying, and sending
外部探针|External probes
过去 24 小时有上报的探针|Probes reporting in the last 24 hours
可用性 · 最近 24 小时|Availability · Last 24 hours
每格 1 小时 · 红色表示该小时至少一次探测失败|Each block is one hour. Red indicates at least one failed check.
尚未接入独立探针|No external probe connected
当前不能计算历史可用率。部署 uptime-probe.mjs 后开始积累数据。|Run uptime-probe.mjs to start collecting availability history.
采样成功|Successful checks
存在失败|Failed checks
成功率仅针对已采样请求，不将缺失样本视为正常运行。建议在另一台机器运行探针，才能观测网关主机故障。|Success rates cover observed requests only. Missing samples do not count as uptime. Run the probe on a separate host to detect gateway host outages.
探针接入说明|Connect a probe
在独立主机运行|Run on a separate host:
。设置 GATEWAY_URL、GATEWAY_MONITOR_TOKEN_FILE 和 PROBE_DATA_DIR；专用令牌来自网关数据目录的 monitor.token。探针断线时本地保存采样，恢复后补报。不要使用管理令牌。|. Set GATEWAY_URL, GATEWAY_MONITOR_TOKEN_FILE, and PROBE_DATA_DIR. Use the dedicated monitor.token from the gateway data directory. Samples are stored locally during outages and uploaded on recovery. Do not use the admin token.
内存历史|Memory history
每分钟采样 · 最近 24 小时|One sample per minute · Last 24 hours
进程驻留内存 MB|Resident memory in MB
接口耗时|Request latency
一分钟内完成请求的平均耗时|Average latency of requests completed each minute
平均请求耗时 ms|Average request latency in ms
请求量|Request volume
每分钟完成的 HTTP 请求|HTTP requests completed per minute
每分钟请求数|Requests per minute
队列积压|Queue depth
采样时等待发送与重试的任务|Tasks waiting to send or retry at each sample
等待任务数|Pending tasks
实例运行历史|Instance history
异常退出只保留最后心跳；最后心跳之后的时段不视为在线|After an unexpected exit, the last heartbeat is retained. Time after it is not counted as uptime.
启动时间|Started
最后心跳|Last heartbeat
停止时间|Stopped
当前实例|Current instance
正常停止|Stopped gracefully
未记录正常停止|No graceful shutdown recorded
正在加载…|Loading…
无法加载页面|Unable to load this page
重试|Try again
连接超时，请重试。|The connection timed out. Please try again.
保存|Save
关闭|Close
编辑应用|Edit application
应用名称|Application name
应用 ID：|Application ID:
应用 ID|Application ID
启用推送|Enable push notifications
切换启停状态将撤销现有设备登记，重新启用后设备需重新登记。|Changing availability revokes existing registrations. Devices must register again when re-enabled.
ID 创建后不可修改，客户端与业务 Server 使用此 ID 接入。|The ID cannot be changed later. Clients and your server use it to identify the application.
应用已保存|Application saved.
应用已创建，请配置推送通道。|Application created. Configure a push channel to continue.
保存修改|Save changes
创建应用|Create application
密钥允许的环境|Allowed environments
私钥文件（.p8）|Private key (.p8)
当前 Firebase 项目：|Current Firebase project:
尚未配置|Not configured
服务账号：|Service account:
Firebase 服务账号 JSON|Firebase service account JSON
启用通道|Enable channel
文件留空保留已有私钥。|Leave the file empty to keep the existing private key.
凭据加密保存，不会回显。配置变更会撤销本应用现有设备登记及未完成任务。|Credentials are encrypted and never displayed. Configuration changes revoke this application’s registrations and cancel pending tasks.
密钥文件不能超过 16 KiB|The key file must be no larger than 16 KiB.
无法解析服务账号 JSON 文件|Unable to parse the service account JSON file.
通道配置已保存。若配置发生变化，设备需重新登记。|Channel saved. Devices must register again if the configuration changed.
测试任务已入队，可在推送记录查看结果。|Test queued. Check Deliveries for the result.
操作已完成。|Done.
发送同步提示|Send sync hint
确认|Confirm
未配置|Not configured
FCM 项目|FCM project
失败 / 未知|Failed / unknown
配置 APNs →|Configure APNs →
配置 Android →|Configure Android →
查看推送记录 →|View deliveries →
查看设备登记 →|View devices →
推送任务详情|Task details
任务 ID|Task ID
登记 ID|Registration ID
重试负责人|Retry owner
业务 Server（兼容接口）|Your server (legacy API)
本网关|This gateway
尝试次数|Attempts
通道响应|Provider response
无响应|No response
原因|Reason
更新时间|Updated
下次尝试|Next attempt
日志详情|Log details
HTTP 状态|HTTP status
耗时|Latency
删除应用|Delete application
，同时删除通道密钥和设备登记，取消未完成任务。历史投递与审计记录保留至保留期结束。此操作不可撤销。|. This also removes channel credentials and device registrations, and cancels pending tasks. Historical deliveries and audit records remain until their retention period ends. This cannot be undone.
移除通道|Remove channel
的|/
密钥，撤销该应用现有设备登记并取消未完成任务。|credentials. This revokes the application’s device registrations and cancels pending tasks.
撤销设备登记|Revoke device registration
撤销后，该设备的投递凭证立即失效，未完成的推送任务会被取消。|Revoking immediately invalidates this device’s credentials and cancels pending tasks.
发送测试同步提示|Send a test sync hint
向这台已验证设备发送后台同步提示，不包含邮件内容，不显示横幅。通道接受不代表设备已收到。|Send a background sync hint to this verified device. It contains no email content and shows no banner. Provider acceptance is not proof of device delivery.
选择一台已验证设备，点击“测试推送”。|Choose a verified device and select “Test push”.
取消待发送任务|Cancel pending task
取消后不会继续发送或重试。已发送到通道的请求无法撤回。|The task will no longer be sent or retried. Requests already sent to the provider cannot be recalled.
次|attempts
天|d
小时|h
分|m
秒|s
工作空间|Workspace
推送服务|Push services
可观测性|Observability
私有网关|Private gateway
管理工作空间|Management workspace
管理员|Administrator
退出登录|Sign out
主要导航|Main navigation
管理控制台|Management console
欢迎回来|Welcome back
使用网关管理令牌登录。|Sign in with your gateway admin token.
管理令牌|Admin token
输入管理令牌|Enter your admin token
进入控制台|Sign in
统一推送。|One gateway.
清晰掌控。|Everything in view.
管理应用与推送通道，查看投递记录。|Manage your applications, channels, and deliveries.
让每一次连接，都有迹可循|Every connection, accounted for
令牌保存在网关数据目录的 admin.token 文件中，与邮件服务器管理员密码不同。|Find your token in admin.token in the gateway data directory. This is separate from your mail server password.
令牌仅保留在当前页面内存中。|Your token stays in this page’s memory only.
通道接受不等于设备送达 · 运行记录保留 30 天|Provider acceptance is not device delivery · 30-day history
推送网关|Push gateway
安全设置|Security
管理登录凭据与两步验证。|Manage sign-in credentials and two-step verification.
修改管理令牌|Change admin token
当前管理令牌|Current admin token
新管理令牌|New admin token
确认新令牌|Confirm new token
使用 32–256 位无空格字符。保存后所有会话退出。|Use 32–256 characters without spaces. Saving signs out all sessions.
两步验证|Two-step verification
未启用|Not enabled
支持 Apple 密码、Google Authenticator、1Password 等验证器。|Works with Apple Passwords, Google Authenticator, 1Password, and other authenticators.
剩余恢复码|Recovery codes remaining
关闭两步验证|Turn off two-step verification
绑定验证器|Set up authenticator
使用验证器扫描二维码，或手动输入密钥。|Scan with your authenticator, or enter the setup key manually.
验证器二维码|Authenticator QR code
验证码|Verification code
验证码或恢复码|Verification or recovery code
验证并启用|Verify and enable
两次输入的令牌不一致|The tokens do not match
保存恢复码|Save recovery codes
每个恢复码只能使用一次。请保存在安全的位置；关闭后不再显示。|Each recovery code can be used once. Store them somewhere safe; they will not be shown again.
我已保存恢复码|I have saved my recovery codes
返回登录|Back to sign in
安全设置已更新，请重新登录。|Security settings updated. Please sign in again.
登录已失效，请重新登录|Your session has expired. Please sign in again.
`.trim().split('\n').map(line => { const at = line.indexOf('|'); return [line.slice(0, at), line.slice(at + 1)]; }));
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(Object.keys(english).sort((a,b) => b.length - a.length).map(escapeRegex).join('|'), 'g');
export function translate(source, target) {
  return target === 'en' ? source.replace(pattern, match => english[match]) : source;
}
function initialLanguage() {
  try { const saved = localStorage.getItem('perch.gateway.language'); if (['zh','en'].includes(saved)) return saved; } catch { /* Storage may be unavailable. */ }
  return typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('zh') ? 'en' : 'zh';
}
export let language = initialLanguage();
export const locale = () => language === 'zh' ? 'zh-CN' : 'en-US';
export const t = source => translate(String(source), language);
export function html(strings, ...values) {
  return strings.reduce((result, segment, i) => result + t(segment) + (i < values.length ? values[i] : ''), '');
}
export function setLanguage(next) {
  if (!['zh','en'].includes(next)) return;
  language = next;
  try { localStorage.setItem('perch.gateway.language', next); } catch { /* Switching still works without storage. */ }
}
const errors = {
"Invalid age public key":"请填写有效的 age 公钥，不要上传私钥",
"Use an HTTPS S3 endpoint":"请填写 HTTPS S3 Endpoint，不含账号、路径或查询参数",
"Invalid storage provider":"存储服务类型无效",
"Use a Cloudflare R2 S3 endpoint":"请填写 Cloudflare R2 S3 Endpoint",
"Use an AWS S3 endpoint":"请填写 AWS S3 Endpoint",
"Invalid S3 region":"S3 Region 无效",
"B2 region must match endpoint":"B2 Region 必须与 Endpoint 匹配",
"R2 region must be auto":"R2 Region 必须为 auto",
"Invalid S3 addressing style":"S3 寻址方式无效",
"Invalid S3 bucket name":"S3 存储桶名称无效",
"Invalid S3 Access Key ID":"S3 Access Key ID 无效",
"Invalid S3 Secret Access Key":"S3 Secret Access Key 无效",
"Enter a new Secret Access Key when changing the storage destination":"更换存储服务、目标或 Access Key ID 时，请重新填写 Secret Access Key",
"S3 Secret Access Key is required":"请填写 S3 Secret Access Key",
"Save storage credentials and public key first":"请先保存存储凭据和加密公钥",
"Use a Backblaze B2 HTTPS S3 endpoint":"请填写 Backblaze B2 的 HTTPS S3 Endpoint",
"Invalid B2 bucket name":"B2 存储桶名称无效",
"Invalid backup prefix":"备份目录前缀无效",
"Invalid B2 Key ID":"B2 Key ID 无效",
"Invalid backup settings":"备份设置无效",
"Invalid backup schedule":"备份间隔或保留天数无效",
"Invalid B2 Application Key":"B2 Application Key 无效",
"Backup settings changed; refresh and try again":"备份配置已变更，请刷新后重试",
"Backup worker is busy; wait before changing settings":"备份正在执行，请完成后再修改配置",
"Enter a new Application Key when changing the B2 destination":"修改 B2 目标或 Key ID 时，请重新填写 Application Key",
"B2 Application Key is required":"请填写 B2 Application Key",
"Save B2 credentials and public key first":"请先保存 B2 凭据和加密公钥",
"A backup operation is already pending":"已有同类操作等待执行",
"This backup cannot be retried":"此备份当前无法重试",
"Backup target changed; create a new backup":"备份目标已改变，请创建新备份",

  'Invalid retention settings':'保留周期无效，请检查输入范围',
  'Invalid cleanup selection':'请选择至少一种清理类型',
  'Invalid cleanup cutoff':'截止日期无效或晚于当前时间',
  'Cleanup preview expired; preview again':'预览已过期，请关闭弹窗后重新预览',
  'Cleanup is already running':'清理正在运行，请稍后再试',
  'Invalid or already used verification code':'验证码无效或已使用，请使用新的验证码或恢复码',
  'Invalid current token':'当前管理令牌不正确',
  'New token must contain 32–256 characters without spaces':'新令牌须为 32–256 位无空格字符',
  'New token must differ from current token':'新令牌不能与当前令牌相同',
  'Two-step verification is already enabled':'两步验证已经启用',
  'Setup expired; start again':'绑定已过期，请重新开始',

  'Application ID already exists':'应用 ID 已存在',
  'Invalid application ID or name':'应用 ID 或名称无效',
  'Invalid application settings':'应用配置无效',
  'Application not found':'应用不存在',
  'Invalid APNs configuration':'APNs 配置无效',
  'Invalid P-256 private key':'请上传有效的 P-256 私钥',
  'Invalid RSA private key':'请上传有效的 RSA 私钥',
  'Invalid FCM service account':'FCM 服务账号无效',
  'Invalid service account JSON':'服务账号 JSON 无效',
  'Apple topic and environment already assigned':'该 Apple Bundle ID 与环境已分配给其他应用',
  'Firebase project already assigned':'该 Firebase 项目已分配给其他应用',
  'Invalid channel state':'通道状态无效',
  'Invalid channel configuration':'通道配置无效',
  'Push channel not implemented':'该推送通道尚未接入',
  'Application disabled':'应用已停用',
  'Application channel not configured or disabled':'应用通道未配置或已停用',
  'Device rate limit':'设备请求过于频繁，请稍后重试',
  'Too many requests':'请求过于频繁，请稍后重试',
  'Queue capacity reached':'队列已满，请稍后重试',
  'Gateway shutting down':'网关正在停止，请稍后重试',
  'Workers busy':'发送服务繁忙，请稍后重试',
  'Task not found':'任务不存在',
  'Registration not found':'设备登记不存在或已过期',
  'Device has not completed verification':'设备尚未完成验证',
  'Only waiting tasks can be cancelled':'只能取消等待发送或重试的任务',
  'Gateway request failed':'网关请求失败，请稍后重试',
  'Unauthorized':'登录已失效，请重新登录',
  'Request too large':'请求内容过大',
  'Invalid page':'页码无效',
  'Invalid date filter':'时间筛选无效',
};
export const translateError = message => language === 'zh' ? (errors[message] || message) : t(message);
