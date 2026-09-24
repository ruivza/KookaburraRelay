# 接入加固与客户端协议

代码默认保持兼容：新建应用不强制 App Attest、Play Integrity 或服务器审批，告警默认关闭。管理控制台新增「接入与验证」「服务器接入」「异常告警」。**这些功能不依赖 APNs 私钥；最终设备登记仍包含原有 APNs/FCM 接收挑战，因此完整推送验收需要相应通道和真机。**

## 建议启用顺序

1. 更新网关、业务 Server 和 iOS；先保持强制验证关闭，确认原有登记与推送正常。
2. 为各应用设置独立额度。空值继承资源保护默认值；全局总量和全局暂停始终生效，修改额度不重置当日用量。
3. 在「服务器接入」登记业务 Server 的实际 `serverId` 和允许的应用 ID，批准后保存只显示一次的凭证。在业务 Server 配置 `GATEWAY_SERVER_CREDENTIAL` 及 `GATEWAY_SERVER_CREDENTIAL_URL=https://实际网关`。后者必须与当前网关根地址一致；不填时使用官方网关地址。凭证不返回给客户端，不写入客户端源码。选择其他网关不会转发此凭证。
4. 验证新版客户端能拿到票据并完成登记后，为目标应用启用「只允许已批准的服务器」。未经批准、缺少票据或没有专用服务器凭证的调用被拒绝。未启用此开关时仍允许旧式自报 Server ID，因此单靠兼容模式下的封禁不能阻止攻击者换 ID；要按可信身份限制必须开启此开关。
5. 配置并测试平台真实性验证，再逐应用开启强制验证。保存策略会撤销该应用的全部设备登记和待发任务。轮换或封禁服务器也会撤销其登记、票据和待发任务，客户端需要重新登记。已交给推送厂商的请求不能撤回。
6. 配置 HTTPS Webhook 和阈值后开启告警，确认接收端支持下述通用 JSON 协议。不是所有聊天机器人 Webhook 都直接接受此格式，可能需要转换服务。

无需为了部署准备先填写真实 APNs 密钥。本次代码验证使用隔离数据库和厂商替身，没有改变现有线上策略、配置真实 Webhook 或发送真实告警。

## 服务器身份与登记票据

- 管理员通过 `POST /admin/servers {id,name,apps:[appId]}` 登记待审批服务器。
- `POST /admin/servers/:id {action:"approve"|"rotate"|"block"}` 批准、轮换或封禁。批准与轮换产生随机 256 位凭证，数据库仅保存其 SHA-256。状态列表不包含凭证。
- 业务 Server 使用 `Authorization: Bearer <服务器凭证>` 调用 `POST /v1/server-tickets {appId,serverId,deviceId}`，得到 `{ticket,expiresAt}`。票据有效期五分钟，绑定应用、服务器、设备和当前凭证版本，只能消耗一次。数据库仅保存票据哈希。
- Mohua 的已登录设备调用 `POST /api/client/push/ticket {}` 获取 `{ticket,expiresAt?,revision}`；设备身份来自登录会话，客户端不能指定其他设备。未配置服务器凭证时返回 `ticket:null`。
- 客户端把非空票据放入登记请求的 `serverTicket`。业务 Server 向 `/v1/validate`、`/v1/notify`、`/v1/jobs` 及任务查询请求同时携带设备投递 Bearer 凭证和 `X-Relay-Server-Credential`。iOS 确认接收挑战不需要长期服务器凭证。
- 目录最多 1,000 个服务器；有效票据最多 2,000 个。票据签发限全局每日 20,000、每服务器每日 5,000。过期记录每分钟清理。

## App Attest（iOS）

Apple Team ID、Bundle ID 与客户端签名必须匹配。Debug 构建使用 development，Release 使用 production；网关按应用配置一个严格匹配的 App Attest 环境。TestFlight / App Store 验收使用生产环境。Apple 签名配置需包含 App Attest entitlement。App Attest 的环境独立于 APNs token 环境。

新版 iOS 使用 `DCAppAttestService`：首次生成密钥并提交 attestation，后续登记使用 assertion。私钥由系统管理，本地仅保存按网关和应用隔离的 key ID。服务不支持、Apple 请求失败或证明被拒绝时停止登记，遵循现有重试冷却，不跳过验证。模拟器可以编译和运行普通测试，不能证明真实 App Attest 链路可用。

网关验证 Apple 证书链、证书有效期、App ID、环境、key ID、挑战绑定和签名；assertion 计数器在事务内严格递增，阻止并发重放。验证库固定版本 `node-app-attest`，外层补充严格 CBOR 结构、证书时间和请求绑定检查。公钥最长保留 90 天，每次成功验证延期；全球上限 100,000 个。策略修改会清空该应用公钥。

官方说明：[Apple App Attest 验证流程](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)。真机还需验收首次证明、再次 assertion、失效密钥、策略切换及 Apple 服务暂时不可用的场景。

## 平台证明公共协议

1. 准备完整登记对象 `registration`：`appId,platform,channel,deviceId,serverId,deviceToken,environment,nonce,purpose`，以及可选 `kinds`、`serverTicket`。nonce 至少 32 字符。获取证明后不得再修改这些字段。
2. `POST /v1/integrity/challenges {registration,keyId?}`。未强制验证返回 `{required:false}`。否则返回 `{required:true,id,payload,expiresAt,keyKnown,requestHash,cloudProjectNumber}`，有效期五分钟。
3. Apple 取 `SHA256(UTF8(payload))` 作为 clientDataHash。网关已知密钥用 assertion，否则生成新密钥并 attest。提交登记时附加 `integrity:{challengeId:id,keyId,attestation:<标准Base64>}` 或 `{challengeId:id,keyId,assertion:<标准Base64>}`。
4. Android 使用下面的 Standard Integrity 协议，提交 `integrity:{challengeId:id,integrityToken}`。
5. 验证成功后仍执行原有推送接收挑战、确认及凭证签发流程。HTTP 登记响应不会返回接收挑战。

挑战绑定整个登记参数（包括 token、nonce、能力与服务器票据）。验证失败也会消耗已匹配的挑战；超时或失败重试需重新申请挑战，票据已消耗时也需重新获取。旧网关挑战端点返回 404 时 iOS 兼容旧协议，但已启用强制策略的网关不会因此放行缺少证明的登记。

有效挑战上限 2,000；挑战申请每来源每分钟 20、全局 300。密码学/远程验证并发上限 4、每来源每分钟 20、全局 120；每日全局 10,000、每应用 5,000，失败尝试也计数。限流与临时故障提供 Retry-After。

## Play Integrity（Android 网关端）

当前工作区没有 Android 客户端。本次实现网关验证端与接入协议，未编译或修改 Android App。

需在 Google Play Console 关联 Cloud 项目、启用 Play Integrity API 并配置有权限的服务账号。管理页面填写包名、Cloud Project **Number**（不是项目字符串 ID）、允许的签名证书 SHA-256（无 padding 的 Base64URL）及服务账号 JSON。服务账号私钥加密保存，管理 API 不回显。

Android 客户端接入步骤：

1. 使用官方 Play Integrity SDK 的 `IntegrityManagerFactory.createStandard(context)`。
2. 使用 `PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(number).build()` 预热 StandardIntegrityTokenProvider，缓存 provider，按官方要求处理过期与重新预热。
3. 取得网关 challenge 后，用其 `requestHash` 调用 `StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build()`。`requestHash` 是网关 payload 的 SHA-256 Base64URL；不能改成另一个业务请求的 hash。
4. 取响应 `token()`，放入上节登记请求的 `integrityToken`。服务账号私钥只放在网关。
5. 网关向 Google 固定端点解码并要求包名/请求 hash/签名证书匹配、时间在五分钟内、`PLAY_RECOGNIZED`、`MEETS_DEVICE_INTEGRITY` 和 `LICENSED`。因此侧载、未获许可或修改签名的安装不会满足当前强制策略。

官方说明：[Standard Integrity 请求](https://developer.android.com/google/play/integrity/standard)、[验证结果字段](https://developer.android.com/google/play/integrity/verdicts)。上线前需要通过 Play 分发的真实 Android App 验收；本地合成 verdict 测试不能代替平台验证。

## 独立额度

`GET/PUT /admin/apps/:id/quotas` 管理覆盖项：`registrationEnabled,registrationAppMinute,challengeAppDay,pendingApp,taskAppDay,taskDeviceDay,attemptAppDay`。PUT 传 `{}` 清除覆盖；未传字段继承全局默认。不能覆盖全局额度和并发上限。每日额度保存在 PostgreSQL，重启、重新登记、修改配置不会清零。

## 自动告警

每分钟检查最近五分钟资源拒绝次数、待发/重试队列总量、最老任务等待时间、最近五分钟 failed/unknown 任务数。首次越线、恢复及持续异常超过冷却期时入队。默认阈值依次为 100、1,000、300 秒、10，重复告警间隔 900 秒。拒绝计数每分钟持久化，异常退出可能丢失最后一分钟尚未写入的计数。

请求 POST 到配置的公网 HTTPS 443 地址，无重定向；DNS 的所有答案必须是公网地址，连接锁定已验证 IP。地址和可选 HMAC 密钥加密保存，管理 API 仅返回主机名和配置状态。修改地址且不填签名密钥会清除旧密钥；仅修改阈值且地址/密钥留空则保留。

```json
{"id":"事件UUID","kind":"queue_depth","state":"firing","value":1001,"time":1780000000000,"text":"Kookaburra Relay: queue_depth firing (1001)"}
```

恢复时 `state:"resolved"`。请求头 `X-Relay-Event-ID` 与 JSON id 相同；配置签名密钥后，`X-Relay-Signature: sha256=<原始HTTP请求体的HMAC-SHA256十六进制>`。接收端应校验签名并持久化去重，成功返回 2xx。

告警投递是至少一次，超时可能实际已送达。失败按 60、120、240、480、960 秒重试，合计最多六次，事件 ID 不变；重启保留待发任务。队列最多 1,000 条，非待发记录保留七天。关闭/修改配置取消旧待发告警，无法撤回已经发出的请求。此功能无法在网关自身完全停机时发送通知，停机监控仍需独立外部 Uptime 服务。
