# Kookaburra Relay

独立的 APNs / FCM 推送网关，包含中英文管理控制台、PostgreSQL 存储与 Docker 部署。此目录不依赖邮箱项目。公开源码前请选择开源许可证并确认品牌素材授权；不要提交 `.env`、数据目录或密钥。

## Docker 启动

在本项目目录运行：

```sh
./install.sh
```

程序与 PostgreSQL 均运行在 Docker 中。默认访问 http://127.0.0.1:3220 。首次登录令牌可通过 `docker compose exec gateway cat /app/data/admin.token` 查看。管理令牌修改后，以新令牌为准。

更新源码后执行 `docker compose up -d --build --wait`。项目名称固定为 `kookaburra-relay`，重新创建容器保留现有数据卷；不要使用 `down -v`，该选项会删除数据。迁移主机必须同时迁移 PostgreSQL 数据与网关 `/app/data` 中的密钥，并保存 `.env`。

本地直接运行需要 Node.js 24、PostgreSQL 18，执行 `npm ci`，设置 `GATEWAY_DATABASE_URL` 后运行 `node server.js`。

先在页面创建或选择应用，再填写 Apple Team ID、Key ID、Bundle ID、密钥允许的环境并上传 `.p8`；再次保存可留空私钥来保留已有密钥。数据库加密保存私钥及 APNs token，页面/API 不回显私钥。加密主密钥在 data/master.key，必须与数据库共同保护并一起备份。管理页面显示配置状态和保留期内的持久化任务统计，不代表真机已经收到通知。

环境变量：`GATEWAY_HOST`、`GATEWAY_PORT`、`GATEWAY_DATA_DIR`、`GATEWAY_DATABASE_URL`、`GATEWAY_DATABASE_SCHEMA`（默认 public）、可选的 `GATEWAY_ADMIN_TOKEN`（至少 32 字符）。管理令牌在「安全设置」中修改；令牌文件和环境变量只在数据库首次初始化时导入，之后不会覆盖数据库中的令牌。新令牌不会写回文件。数据目录默认权限 0700，密钥和令牌文件 0600。

## 独立部署

将本目录单独复制到私有部署位置，先运行 `npm ci` 并配置数据库连接，再运行 `node server.js`。公网前面必须有 HTTPS 反向代理；Node 监听仅供代理访问。建议限制管理页面和 `/admin/*` 的访问来源。客户端 `PERCH_GATEWAY_URL` 与 Server 的 `OFFICIAL_PUSH_GATEWAY_URL` 都使用同一真实 HTTPS 根地址。

APNs 是网关主动出站连接；Server 通过 HTTPS 主动调用网关；网关不回连用户自部署 Server，无需开放用户 Server 的额外入站端口。Server 持有设备投递凭证；启用服务器审批时还持有独立的服务器凭证，不持有 Apple 私钥或注销凭证。

来源限流默认使用 socket IP，不信任任何转发头。反向代理部署时设置 `GATEWAY_TRUSTED_PROXIES` 为实际代理的 IP / CIDR（逗号分隔），才会从右向左解析 `X-Forwarded-For`，遇到首个不可信节点即停止。不支持信任任意来源或固定跳数。代理需正确设置 / 追加来源地址，Node 端口只能由代理访问。Docker 转发下填写网关实际看到的代理地址，不要直接照抄 `127.0.0.1` 或信任整个私网。

登记限制为每应用每来源 60 次/小时、每 token 6 次/小时；确认限制为每来源 120 次/小时。投递与验证按来源 12000 次/小时、已认证应用 60000 次/小时、已认证登记 1200 次/小时分别限制，同设备入队仍最短 60 秒。不同来源的用户不再因为同一个可信代理而共用限额。来源总额度仍用于防滥用，业务 Server 共用出口时需要结合容量规划。登录 / 管理接口也使用同一可信来源解析。

首次登记需收到 APNs 中的挑战值；HTTP 登记响应不包含挑战或投递凭证。初次静默校验可能被系统延迟，需真机验收。这证明 token 的接收能力；额外的 App Attest / Play Integrity 和服务器审批可在「接入与验证」中按应用开启。配置步骤、客户端协议与验收边界见 [接入加固说明](ACCESS_SECURITY.md)。

## 定向验证

```sh
GATEWAY_DATABASE_URL=postgresql://... node --test test/*.test.js
```

使用模拟 APNs / FCM、模拟 HTTP 和临时 PostgreSQL schema，不会联系 Apple 或 Google。测试不等于签名真机送达验收。

## 多应用复用

默认应用 ID 为 `perch-mail`。其他 App 在页面“添加应用”，使用独立且固定的 ID；客户端的 `PerchGatewayAppID` 和业务 Server 的投递 `appId` 与之匹配。Perch Mail Server 固定使用 `perch-mail`，其他业务使用公开协议接入。

同一 `.p8` 在权限允许时可用于多个应用，分别上传并填写各自 Bundle ID。每个应用目前配置一把 APNs key 及允许的环境；选择“开发与生产”要求该 key 本身同时具有两种环境权限。更改名称保留登记，更改推送配置或停用应用清理该应用的登记；其他应用不受影响。

`applications.js` 管理应用生命周期；`channel-store.js` 独立保存各应用的通道和加密凭据；`channels.js` 提供能力目录及 APNs 适配接口，`apns.js` 负责 Apple HTTP/2，`fcm.js` 负责 FCM HTTP v1。当前支持 APNs / FCM 的后台 `sync`；拒绝 `alert`。华为、小米、OPPO、vivo、荣耀尚未实现，页面明确标注。

旧的单应用 SQLite 数据库须先用旧版升级到多应用表结构，再执行显式 PostgreSQL 导入。新版不自动打开或修改 SQLite 主数据库。


## 管理控制台（2026-09 更新）

页面采用 hash 路由，可直接收藏：`/#overview`、`/#apps`、`/#apns`、`/#android`、`/#deliveries`、`/#devices`、`/#monitor`、`/#logs`、`/#security`。无需前端构建或第三方 CDN。登录会话只保存在页面内存，刷新页面需重新登录；退出会清除表单与已加载数据。

- 应用：创建、详情、重命名、启停、删除。删除不会在重启后重新创建默认应用；历史任务与审计保留至到期。
- 通道：每应用一条 APNs 和一条 FCM 配置，可分别启停、更新或移除。APNs 留空私钥保留原密钥；FCM 上传 Firebase 服务账号 JSON，留空文件保留已存密钥。保存时校验格式与密钥类型，不对真实设备发请求。
- 应用停用或任何通道凭据 / 启停变更，会撤销该应用全部设备登记、取消待处理任务；改名不影响登记。其他应用不受影响。
- 测试：通道页进入已验证设备列表，人工点击测试发送后台同步提示。所有结果进入推送记录；没有可验证设备时不能冒充发送成功。
- 记录：按应用、通道、状态 / 类型、时间筛选，30 条分页，可查看完整任务 / 请求 ID 和处理详情。保留周期在「存储与清理」中设置。
- 鉴权：保留现有应用作用域的设备投递凭证；不向业务 Server 下发管理员令牌或厂商私钥。此版本仍是单管理员控制台，没有多管理员角色系统。

管理 API 要求 `Authorization: Bearer <session>`。先 `POST /auth/login` 提交 `{token, code?}`；启用两步验证时，缺少 code 只返回 `requiresSecondFactor:true`，不签发会话。退出调用 `POST /admin/logout` 撤销会话。

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/admin/apps` | GET / POST | 列表 / 创建 |
| `/admin/apps/:id` | GET / PUT / DELETE | 详情 / 修改 / 删除 |
| `/admin/apps/:id/channels/apns` | PUT / DELETE | APNs 配置 / 移除 |
| `/admin/apps/:id/channels/fcm` | PUT / DELETE | FCM 配置 / 移除 |
| `/admin/overview`, `/admin/monitor` | GET | 概览 / 历史采样 |
| `/admin/jobs`, `/admin/devices`, `/admin/logs` | GET | 筛选分页查询 |
| `/admin/devices/:id` | DELETE | 撤销登记和待处理任务 |
| `/admin/devices/:id/test` | POST | `{requestId}` 创建测试任务 |
| `/admin/jobs/:id` | DELETE | 取消等待中或退避中的任务 |

列表通用参数：`appId`、`channel`、`page`（从 1 开始）；任务另有 `state`，日志另有 `kind` / `status`；`from` / `to` 为 Unix 毫秒。设备时间过滤对应凭证到期时间。已删除应用的历史数据仍可通过 `appId` API 参数查询。

## 投递队列与兼容策略

`delivery.js` 使用 PostgreSQL 持久化任务，最多 10000 个未完成任务、4 个并发 worker，每秒检查队列。

**现有 `/v1/notify` 保持同步语义。** 200 仍表示厂商通道已接受。此次新增持久记录，但网关不重试此接口的失败任务；由现有 Perch Mail Server 的持久队列负责重试，因此没有双重重试。客户端和邮件 Server 不需要同时升级。

**新增 `/v1/jobs` 为可选异步接口。** 使用同一个设备投递凭证，正文为原有 `{appId,deviceId,serverId,kind:"sync"}` 加 `requestId`（16–100 个字母、数字、下划线或连字符）。202 只表示入队；调用方必须保留 requestId，遇到响应丢失可用同一个 ID 重试入队，也可 `GET /v1/jobs/:id` 查询。不能对同一任务另外调用 `/v1/notify`。

- 幂等范围：同一登记 + requestId，任务记录保留期 30 天；记录清理后不再保证旧 ID 去重。
- 一个登记同时只允许一个未完成同步任务；不同任务最短入队间隔 60 秒。
- 异步 429 / 5xx 指数退避，初始至少 60 秒、带抖动，遵守有上限的 Retry-After，最多 6 次尝试，任务期限最多 24 小时。
- 永久无效设备错误删除对应登记；认证 / 参数错误直接失败，不进行无效重试。
- 网络断开、超时或进程在发送中退出，可能已经被厂商接收，记为 `unknown`，不自动重放。等待 / 明确暂时失败的异步任务可在重启后继续。
- 状态：`queued`、`sending`、`retrying`、`accepted`、`failed`、`unknown`、`cancelled`。没有设备送达回执，不显示“已送达”，不声称 exactly-once。
- 正常停机停止调度，等待在途任务与 HTTP 请求完成，再关闭通道和数据库。当前每个数据库 schema 仍限定一个网关进程，由 PostgreSQL advisory lock 强制保证；第二个实例会拒绝启动。尚未引入多实例任务租约。

## Android / FCM 接入

Firebase 项目须启用 FCM HTTP v1 API，服务账号须具有相应发送权限。为应用上传服务账号 JSON；固定 Google OAuth 与 FCM 端点，不使用上传文件中的自定义 token_uri。OAuth 访问令牌在内存缓存，私钥加密保存。当前同一 Firebase 项目限定属于一个网关应用，以防不同应用共用项目时发生设备归属混淆。

登记仍使用 `/v1/registrations`，指定 `platform:"android"`、`channel:"fcm"`、`environment:"production"`，并传入 FCM registration token（大小写保留）。FCM data 消息中的 `perchRegistration` 是 JSON 字符串，客户端解析后使用原有确认 API 完成挑战。同步消息的 `data.perch` 也是 JSON 字符串，包含 version、deviceId、appId。使用 normal priority 的后台同步消息，不发送可见通知；操作系统可能延迟投递。

这是服务端通道接入，没有提供 Android 客户端，也尚未进行真实 FCM 送达验收。

参考：[FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)、[错误分类](https://firebase.google.com/docs/cloud-messaging/error-codes)。实现未引入 Gorush 服务或复制其代码。

## Uptime 与独立探测

- `/healthz`：公开的进程 / PostgreSQL 健康接口，不检查厂商送达，不暴露配置。
- 内部每分钟记录内存、请求数、5xx 数、平均耗时、队列积压和实例心跳。当前页面展示最近 24 小时及最近 30 次进程运行。
- 数据目录自动生成独立 `monitor.token`，只能上报探测和读取 `/metrics`；不能管理应用或发送推送。
- `/metrics` 返回 Prometheus 文本，需携带监控 Bearer token。包含进程 uptime、队列积压、RSS 和最近 24 小时接受 / 失败任务 gauge；可由外部 Prometheus 规则告警。本控制台不内置告警投递渠道。

将 `uptime-probe.mjs` 单独复制到另一台有 Node.js 24 的主机，安全放置监控令牌文件（不是 admin.token），例如：

```sh
GATEWAY_URL=https://push.example.com \
GATEWAY_MONITOR_TOKEN_FILE=/secure/gateway-monitor.token \
PROBE_DATA_DIR=/var/lib/perch-probe \
PROBE_NAME=external-1 \
node uptime-probe.mjs
```

探针每轮完成后等待 60 秒，不跟随重定向；每次请求超时 10 秒。网关不可达时先在探针本地 SQLite 保存失败样本，恢复后每轮最多补报 100 个样本。采样数据保留 30 天。用 systemd 等进程管理器保持探针运行。不同探针必须使用不同名称。不要把监控令牌发给客户端。

页面按已采样成功请求数 / 已采样总数显示成功率。缺失数据保持未知，不虚构 100% uptime。探针和网关同机时只能观察进程级中断，不能证明主机 / 外网可用性；探针本身停止期间同样没有样本。

## 验收与部署边界

自动测试覆盖原协议回归、FCM OAuth 签名和响应映射、应用 / 通道生命周期、队列去重与重启、退避、在途撤销、过期、永久错误、日志脱敏与筛选、独立探针断线补报。浏览器验收可使用隔离 fixture：

```sh
node --env-file=.env test/console-fixture.mjs
```

仅监听 `127.0.0.1:43221`，使用一次性临时数据库与模拟厂商。fixture 的公开测试口令只能用于该模拟服务，不能用于实际网关。生产数据、真实设备不得接入 fixture。

生产使用前仍需真实 HTTPS 域名、正确厂商凭据、真机验证和独立探针部署。升级前备份数据库与主密钥；私有目录及其备份必须保持在公开 Server 导出范围之外。

### 控制台语言与外观

登录页和右上角的地球图标可切换中文 / English，语言选择保存在当前浏览器的 `perch.gateway.language` 中；首次打开跟随浏览器语言。登录会话仅保存在页面内存中。页面、弹窗、状态提示以及日期和数字格式随语言切换，应用名称与提供商错误码保持原值。控制台采用系统字体、灰白配色与统一线性图标，并支持窄屏布局和减少动态效果设置。

## PostgreSQL 迁移与备份

停止旧网关，备份 `gateway.sqlite`（以及存在的 WAL/SHM）、`master.key`、`admin.token` 和 `monitor.token`。为新版准备专用空数据库或 schema，然后运行：

```sh
node --env-file=.env migrate-sqlite.mjs /绝对路径/gateway.sqlite
```

导入在单一事务内完成，逐表校验全部字段并同步日志序列；拒绝覆盖已初始化的目标。原应用 ID、通道密钥、设备凭证、队列和历史记录保持不变。新版必须继续使用同一 `master.key`。迁移后 SQLite 文件仅是旧快照，不再更新；PostgreSQL 已有新写入后不能直接回退旧文件。

Docker PostgreSQL 仅开放容器网络内的 5432，不映射宿主机端口，使用命名数据卷。后续备份使用 `pg_dump` / `pg_restore`，并独立保存主密钥、连接配置和监控令牌。不要删除数据卷。测试采用隔离的 PostgreSQL schema，完成后自动清理；独立外部探针仍使用本地 SQLite 缓冲离线样本。

## 管理员安全

`/#security` 提供令牌修改、验证器绑定和关闭两步验证。敏感操作须重新输入当前令牌；已启用两步验证时还须验证码或恢复码。二维码由服务端本地生成，绑定必须提交有效验证码后才生效。

TOTP 使用 30 秒步长、6 位验证码、SHA-1，接受前后一个时间步但拒绝重复使用。启用时一次性显示 10 个恢复码，每个只能使用一次。恢复码代替第二步，仍需当前令牌。管理员需要本人绑定验证器，升级不会自动启用。

登录后签发最长 8 小时的会话，浏览器仅保存在内存。令牌修改、启用或关闭两步验证均撤销全部会话。数据库只存 scrypt 令牌哈希、加密的 TOTP 密钥、恢复码哈希与会话哈希。登录限流 20 次/分钟/IP，安全操作限流 10 次/分钟/IP。

`admin.token` 是初始凭据备份，不是轮换接口。失去当前令牌时需运营者进行受控恢复，本服务不提供绕过两步验证的公开重置端点。

控制台所有选择控件统一采用自定义弹出菜单（应用、通道、状态、日志类型、时间与 APNs 环境）。保留原生表单值，支持方向键、Home/End、Enter、Escape 与按名称搜索，弹窗内菜单使用顶层弹出层避免裁切。

## 存储与清理

「存储与清理」支持开关自动清理、设置执行间隔（1–168 小时）和各类历史记录保留天数（1–3650 天）。默认每天执行，请求日志 14 天、错误日志 30 天、审计日志 90 天，其余历史数据 30 天。设置持久化在 PostgreSQL，重启后保留。

手动清理可以选择类别，按当前规则或指定日期清理。必须先预览数量并确认，预览有效 5 分钟且只能使用一次。后台每批最多删除 1000 条，每类每轮最多 20 万条；达到上限或关闭服务会显示部分完成，剩余记录可继续清理。排队、重试及发送中的任务、应用配置与密钥不会被清理。有效会话和有效设备登记保留。过期登记、会话和限流记录按各自有效期处理。

页面显示数据库大小、下次执行时间与最近 20 次结果，数据库保存最近 100 次清理历史。删除记录后 PostgreSQL 可通过 autovacuum 重用空间，文件不会保证立即缩小。任务记录清理后不再保证旧 requestId 幂等去重。

Docker 两个服务的标准输出日志都采用 local 驱动，10 MB × 5 文件轮转。数据库清理与容器日志轮转独立。Compose 已提供自动备份服务，说明见下文；清理不替代备份。

GitHub Actions 位于 `.github/workflows/docker.yml`，会测试并发布 gateway 与 backup 的 amd64 / arm64 镜像到 GHCR。发布时选择许可证，并将镜像地址填入 `GATEWAY_IMAGE`；`install.sh` 支持拉取预构建镜像；备份镜像使用 `GATEWAY_BACKUP_IMAGE`，未提供时从源码构建。


## 部署加固与端口

页面、`/auth/login`、`/admin/*`、`/v1/*` 和健康 / 监控接口共用网关端口 **3220**。当前没有独立的管理监听端口。公网使用 HTTPS 反向代理；可按路径限制管理访问，无需修改客户端的 `/v1/*` 路径。备份服务没有入站端口。

同步 `/v1/notify` 在数据库入队前取得执行名额，与异步 worker 共用 4 个名额。超出并发的请求返回 503，不生成永久阻塞该设备的排队任务。入队失败释放名额，正常停机等待已取得名额的请求完成。

丢失 PostgreSQL 独占连接时，网关停止接收新请求、关闭推送通道、释放数据库资源并以非零状态退出，Compose 的重启策略负责重新启动。关闭流程默认有 30 秒期限，命令行进程另有 35 秒退出保护。仍为单实例服务，重启期间存在短暂中断。

主密钥只允许在新数据库首次初始化时生成。已初始化的数据库缺失主密钥会拒绝启动；密钥不匹配也会拒绝启动。旧版本首次升级会分批验证已有加密数据，然后写入加密校验标记；之后每次启动校验数据库与主密钥的绑定关系。错误不会输出密钥、token 或厂商配置。恢复时必须使用同一份备份中的数据库与密钥，不能新建密钥替代旧密钥。

## 本机自动备份与恢复演练

`docker compose up -d --build --wait` 会启动 `backup` 服务：首次启动立即备份，以后默认每 86400 秒执行一次；失败每五分钟重试。备份输出到项目 `backups/`（可用 `GATEWAY_BACKUP_DIR` 指定绝对路径），默认保留约 14 天。首次初始化可配置 `GATEWAY_BACKUP_INTERVAL_SECONDS`（3600–604800，整小时）和 `GATEWAY_BACKUP_RETENTION_DAYS`（1–365）；之后在管理页面设置。目录权限 0700、归档权限 0600；目录已加入 Git 忽略和 Docker 构建排除范围。

每个原子发布的 tar 包含 PostgreSQL `relay` schema 的一致性快照、`master.key`、初始管理员 / 监控令牌、`.env`、格式信息及 SHA-256 清单。备份成功后才清理过期的完整归档，不清理数据库本身。归档包含敏感数据和解密密钥，必须私密保管；未配置异地存储时仅有本机备份，不能抵御整台主机或磁盘丢失；异地配置见下文。

立即创建仅本机备份（后台的「立即备份」会同时执行已启用的异地上传）：

```sh
docker compose run --rm --no-deps --entrypoint sh backup /ops/backup-once.sh
```

查看健康与日志：

```sh
docker compose ps
docker compose logs --tail=20 backup
```

在临时数据库执行恢复演练（不覆盖当前网关）：

```sh
sh ops/verify-backup.sh /绝对路径/backups/relay-时间-标识.tar
```

脚本验证归档文件和校验和，新建一次性 `relay_restore_*` 数据库，完整执行 `pg_restore`，在不监听端口、不调度推送的网关实例中验证主密钥和应用解密，完成后删除临时数据库和临时密钥。恢复演练需要运行中的 PostgreSQL 和更新后的网关容器。实际灾难恢复应在独立部署上恢复数据库、原主密钥和配置，再运行验收；不要在当前生产数据库上尝试覆盖恢复。

## S3 兼容对象存储：管理页面配置

管理后台 `/#backups` 提供「备份与恢复」页面。仍运行 gateway、postgres、backup 三个容器。gateway 只保存配置并入队，backup 容器使用 PostgreSQL 持久任务执行快照、age 加密和 S3 兼容上传。异地备份默认关闭，本机备份继续运行；没有填写真实凭据时不会联系对象存储。

页面中的「存储服务」可选择以下配置，旧 B2 配置自动兼容：

| 服务 | Endpoint 示例 | Region | 路径式寻址 |
| --- | --- | --- | --- |
| Backblaze B2 | `https://s3.us-west-004.backblazeb2.com` | `us-west-004`（自动提取） | 开启 |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | 开启 |
| AWS S3 | `https://s3.ap-southeast-2.amazonaws.com` | `ap-southeast-2` | 关闭 |
| 自定义 S3 | 服务商提供的 HTTPS Endpoint | 服务商指定区域 | 按服务商要求 |

Access Key ID / Secret Access Key 对应 B2 的 Key ID / Application Key。这里只支持长期访问密钥，不支持需要 Session Token 的临时凭据。自定义服务须兼容 SigV4、PutObject（Content-MD5）和 HeadObject（大小及自定义元数据）；具体服务需用「测试连接」验收。更换服务、目标或访问密钥 ID 必须重新填写密钥，避免旧凭据被发送给新服务。配置支持不代表已经完成各云端账号的真实上传验收。

以下以 B2 为例：

1. 在 Backblaze 创建**私有 B2 Bucket**，记录 S3 Endpoint，例如 `https://s3.us-west-004.backblazeb2.com`。使用应用密钥，不能使用主账号 Master Application Key。
2. 创建限定该 Bucket 和备份目录前缀的 Application Key，给予 `readFiles`、`writeFiles`。本实现直接访问对象，不列出所有存储桶，也不删除远端对象。Key ID 对应 S3 Access Key ID，Application Key 对应 Secret Access Key。
3. 在自己的电脑安装 [age](https://github.com/FiloSottile/age)，运行 `age-keygen -o backup-identity.txt`。将输出的 `age1...` **公钥**填入管理页面，或导入只包含该公钥的一行文本文件。私钥 `backup-identity.txt` 必须离线妥善保存，不上传网关；丢失它就无法解密远端备份。
4. 页面填写 Endpoint、Bucket、目录前缀、Key ID、Application Key、公钥、执行间隔和本机保留天数，重新输入当前管理员令牌；已启用两步验证时还需验证码或恢复码。Application Key 加密保存，接口和页面不回显。留空保留已有密钥，更换 Endpoint、Bucket 或 Key ID 时必须重新填写密钥。
5. 点击「测试连接」，等待后刷新记录。测试上传一份小型加密文件至 `<prefix>/_connection-tests/`，再检查对象大小及 SHA-256 元数据。测试文件由 B2 生命周期规则清理，不要求删除权限。
6. 启用异地备份后点击「立即备份」。确认记录中的本机备份、异地上传分别成功。测试连接成功不会被计作一次数据库备份成功。

**保存配置不会自动验证厂商权限。** 备份执行中拒绝修改配置；配置修改后旧的等待 / 重试任务取消，新任务使用新配置。每类操作最多一个待处理任务。设置写入数据库，重启保留；页面中的执行间隔（1–168 小时）、本机保留天数（1–365）优先于初始化环境变量。`GATEWAY_BACKUP_INTERVAL_SECONDS` / `GATEWAY_BACKUP_RETENTION_DAYS` 只在备份设置首次初始化时导入，后续不覆盖后台设置。

远端文件采用标准 `.tar.age` 格式，服务器只使用公钥加密。上传用官方 AWS S3 SDK v3 签名，支持 B2、R2、AWS S3 和自定义 HTTPS S3 Endpoint。Endpoint 不得包含账号、路径、查询参数或 IP 字面量；自定义服务必须有可验证 TLS 证书和 DNS 名称。单次上传上限 5 GiB，超出会明确失败。按任务 ID 使用固定对象名，重试保留同一份密文；先 HEAD 检查既有对象，再上传，防止响应丢失后重复写入。使用 Content-MD5 校验上传，完成后再验证大小及 SHA-256 元数据。

本机成功、远端失败时保留本机成功状态，只重试异地步骤，不反复生成快照。暂时失败最多自动尝试 6 次，间隔从 60 秒指数增加；权限错误等永久错误等待处理。任务详情不保存厂商原始错误文本或凭据。页面保留最近 30 条记录，数据库最多保存 100 条已结束记录；容器健康表示 worker 心跳正常，**不代表 B2 已配置或最近上传成功**，需查看页面的异地状态。

远端保留期需要在 B2 控制台配置生命周期规则，建议从 30 天开始，覆盖归档和测试文件。规则需包括隐藏 / 历史版本的清理；本程序不会修改 Bucket 权限、生命周期或主动删除远端对象。本机备份仍按独立规则保留。

下载远端 `.age` 文件后，在持有私钥的电脑上解密：

```sh
age --decrypt -i backup-identity.txt -o backup.tar backup.tar.age
```

然后在网关部署目录运行 `sh ops/verify-backup.sh /绝对路径/backup.tar`，恢复到一次性数据库验证。验证脚本不会覆盖当前生产库；页面不提供覆盖恢复按钮。务必定期做下载、解密及完整恢复演练。本地测试使用模拟对象存储和 S3 SDK 请求检查；首次真实上传和下载验收需运营者配置自己的 Bucket 与密钥。

参考：[Backblaze S3 SDK v3 接入](https://www.backblaze.com/docs/cloud-storage-use-the-aws-sdk-for-javascript-v3-with-backblaze-b2)、[B2 应用密钥](https://www.backblaze.com/docs/cloud-storage-application-keys)。

S3 参考：[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)、[AWS S3 SDK](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-s3.html)。

### 固定文件名与对象版本管理

异地设置可勾选「固定文件名（使用对象版本管理）」，默认关闭以兼容原有独立文件命名。开启后正式备份固定写入 `<prefix>/archives/backup.tar.age`，连接测试写入独立的 `<prefix>/_connection-tests/connection-test.tar.age`，不会覆盖正式备份。上传前读取 GetBucketVersioning，只有状态 Enabled 才继续；无权限、不支持或暂停版本管理时失败，不会退回无版本覆盖。密钥需允许读取存储桶版本管理状态，以及读取指定对象版本。网关不会替你开启或修改存储桶版本管理。

每次新备份产生新版本，任务记录保留版本 ID；按该 ID 从存储服务下载历史版本后解密恢复。响应丢失重试会识别相同任务与密文，避免重复创建版本。历史版本保留时间应通过存储服务的非当前版本生命周期规则配置。不要让多个网关实例共用同一前缀。

参考：[S3 对象版本](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html)、[B2 版本管理状态](https://www.backblaze.com/apidocs/s3-get-bucket-versioning)。

### 内部监控职责

内部运行监控仅突出推送结果、队列处理和备份。服务可用性由独立部署的 Uptime 负责；原有探针上报接口保留兼容，但不再占用内部页面。

- 推送结果按最近 24 小时的结果更新时间统计 accepted / failed / unknown，包含之前创建、期间完成的任务；按 APNs / FCM 分开计算接受率。重试中、取消和等待不进入结果分母。厂商接受不代表设备送达。
- 队列卡片与新历史采样均包含等待、重试、发送中。最老等待时间包含重试退避；调度逾期指超过 next_at 5 分钟，发送超时指 sending 超过 2 分钟。这些仅提示异常，不自动重发结果不明的任务。升级前没有完整队列状态采样，历史不补造零值。
- 本地、异地备份分别按最近成功时间判断，超过配置周期加 1 小时宽限标为逾期；未成功过显示未验证，异地未启用单独显示。worker 心跳与备份结果分开，成功归档不代表恢复验证通过。恢复验证仍使用 ops/verify-backup.sh。
- 诊断详情保留内存、运行历史、采样新鲜度和后台轮询错误。轮询和采样失败写入不含凭据的服务日志；采样不会清掉写入期间新完成的请求。
- `/metrics` 新增队列最老等待时间、调度逾期、发送超时、worker 错误、最近成功采样，以及本地/异地备份成功时间与异常状态。可由外部规则发送通知；本项目不自动配置通知渠道。

## 资源保护与客户端退避

控制台 `/#abuse`（资源保护）及管理员 `GET /admin/abuse`、`PUT /admin/abuse` 提供独立的资源设置。PUT 提交完整 `settings` 对象；字段未知、非整数、零或超出上限均拒绝。每个应用分别使用同一套每应用上限；目前没有按应用单独覆盖的设置。

默认值：全局 / 每应用每分钟登记 300 / 120 次；每日挑战 10000 / 5000 次；待确认登记 2000 / 1000 条；挑战独立并发 4。每日新任务全局 / 应用 / 设备为 100000 / 50000 / 240，实际投递尝试全局 / 应用为 150000 / 75000。所有日额度按 UTC 零点重置并保存在 PostgreSQL，重启或修改设置不清空已用额度。每设备任务额度绑定应用、通道、环境和 token 的哈希，重新登记同一 token 不会刷新额度。任务去重命中不重复扣减新任务额度；重试投递仍受尝试额度限制，已预留但未完成的厂商请求保守计入消耗。

登记先检查格式与来源限流，再以独立名额进入容量和额度事务，通过后才创建登记、调用厂商。失败挑战清理待确认记录并释放名额，已消耗挑战额度不返还。APNs 流和 FCM HTTP 请求使用已有 10 秒底层超时；FCM 获取授权和发送是两个分别有超时的阶段。客户端断开不提前释放仍在执行的挑战名额。暂停登记仍允许已发出的有效挑战确认、已有设备投递及撤销。

所有 HTTP 请求在业务数据库操作前经过进程内限流：全局 6000 次/分钟、每来源 600 次/分钟、最多 64 个在途处理；内存桶最多 10000 个，数据库来源/设备限流记录最多 20000 条。进程内限制在重启后重置，持久化业务额度不重置。过期额度、限流记录及登记独立于历史清理设置每分钟回收，登记每轮最多删除 1000 条并取消对应未完成任务。请求/错误日志最多每分钟 120 条、同时写入最多 8 条，省略数量和拒绝原因在资源保护页显示；管理员审计不采样。运行计数在重启后归零。

资源拒绝返回 429 或 503、稳定的 `reason` 和 `Retry-After` 秒数。业务 Server 应保留该响应头，以指数退避和抖动重试；验证凭证遇到临时限流不得当成永久失效。iOS 应持久化冷却时间，临时上传失败保留有效设备凭证。旧协议继续兼容，但旧客户端未必遵守冷却，建议两端一起升级。后台同步仍可能被系统延迟；本次未接入 App Attest，也未完成真机送达验收。


## 通用通知能力

每个应用可独立启用静默更新 `sync`、普通提醒 `alert`、加密提醒 `encrypted_alert`，并配置加密提醒的兜底文案。APNs 支持三种；FCM 支持前两种。旧应用默认仅静默更新，已有凭证不会自动获得提醒权限。接入及迁移见 [通知协议](NOTIFICATION_PROTOCOL.md)。
