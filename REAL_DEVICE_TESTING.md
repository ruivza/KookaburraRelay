# 本次部署与 iPhone 联调

2026-09-24 已更新本机 Docker 中的 Kookaburra Relay 网关、备份组件、Mohua Server 和 mail-worker。入口 edge 保持运行。所有服务健康检查通过，网关新增十张数据表已迁移，新管理接口未登录返回 401。

本机后台：网关 http://127.0.0.1:3220 ，Mohua http://127.0.0.1:3210 。这是本机部署，尚未发布到新的公网主机。iOS 源码已接入验证，但本次没有向 iPhone 安装 App。

升级前数据库与配套密钥备份：`backups/pre-access-20260924T130300Z/`（仅本机受限权限）。旧镜像保留 `:pre-access-update` 标签。备份包含敏感密钥，不要上传或分享。数据库 dump 已检查目录可读，未执行生产恢复。

本次检查发现：网关尚无应用，Server 使用 official 模式但没有网关 URL，也没有服务器专用凭证。告警关闭。需要先补这些实际配置，再开始推送验收。

## 1. 先准备地址与签名

- 一个 iPhone 能访问的 Mohua Server 地址，用于登录和同步。
- 一个具有有效 TLS 证书的公网 HTTPS 网关根地址，例如 `https://push.example.com`。iPhone 和 Server 容器都必须能访问它。示例地址需要替换成真实域名。
- 不要把手机里的 `localhost` 当作 Mac；它指向手机自己。业务 Server 的网关出站校验还会拒绝私网、环回 IP 和重定向，因此直接填 `http://192.168...:3220` 或仅在局域网解析的网关域名无法完成当前协议联调。
- Apple Developer 团队、实际 Bundle ID、可用 APNs `.p8`、Key ID、Team ID，以及支持 App Attest 的 iPhone。

公网 TLS/反向代理尚未在本次操作中配置；应将网关域名转发到现有 3220 服务、业务 Server 域名转发到 3210 入口，并按实际代理配置可信来源。不要直接复制一个未经核实的代理 CIDR。

## 2. 先跑通普通推送

在网关后台「应用管理」创建应用：

- 应用 ID：`mohua`（必须与两端代码一致）。
- 配置 APNs Team ID、Key ID、与主 App 签名一致的 Bundle ID，上传 `.p8`。
- Xcode Debug 真机先使用 sandbox APNs；Release/TestFlight 使用 production。需要加密新邮件提醒时，在应用通知能力中启用加密提醒。
- 暂时不勾选强制 App Attest、强制服务器审批。

在 `/Users/ray/Desktop/Mohua/.env` 设置真实地址：

```dotenv
OFFICIAL_PUSH_GATEWAY_URL=https://push.example.com
```

然后在 Mohua 项目目录应用环境变量变更：

```sh
docker compose up -d --no-build --wait server mail-worker edge
```

业务后台「设置 → 推送网关」选择官方网关，保存并测试连接。成功只证明网关协议和配置可用，不代表手机收到通知。

打开 `/Users/ray/Desktop/Mohua-iOS/Mohua.xcodeproj`，选择 Mohua scheme 和连接的 iPhone：

- 主 App 和通知扩展选择自己的 Signing Team，Bundle ID 与 APNs topic 保持对应。
- 确认 Push Notifications、后台 remote notification 配置和签名描述文件有效。
- 在主 App Build Settings 的用户自定义设置中配置 `MOHUA_GATEWAY_URL`，值与 Server 使用的网关 HTTPS 根地址一致。
- 先用 Debug 构建。项目已设 `APS_ENVIRONMENT=development`、`APP_ATTEST_ENVIRONMENT=development`。
- 安装并打开 App，登录业务 Server，保持前台和联网；在「通知与同步」中开启需要的提醒并允许系统通知。

验收：App 显示「后台更新已登记」或「新邮件提醒已登记」；网关「设备登记」出现已验证记录。再使用该设备的「测试推送」检查通道，并给测试邮箱发送一封新邮件，检查前台同步、后台提醒和锁屏显示。静默挑战可能被 iOS 延迟，不要连续反复登记；按 App 冷却提示重试。

## 3. 再验证 App Attest

在网关「接入与验证」选择 `mohua`：填写与主 App 一致的 Team ID、Bundle ID；Debug 选择 development，然后勾选「iOS 必须通过 App Attest」并保存。

保存会撤销这个应用的旧设备登记和待发送任务。让 App 回到前台重新登记，检查：

1. 首次 attestation 成功后设备重新变为已验证。
2. 在网关「设备登记」只撤销该设备登记，再让 App 重新登记，验证已存密钥的 assertion 路径。此时不要再次保存应用验证策略，否则公钥也会被清空，测试又变成首次 attestation。
3. 缺少证明、修改 nonce/设备参数、复用挑战的请求应被拒绝。这些负向场景已做自动测试，真机重点验收系统证明与网络链路。
4. 临时断网后恢复，不应跳过证明；结束冷却后能够重新登记。

TestFlight/App Store 使用 production App Attest，不能继续让该应用策略停在 development。当前每个应用配置一个严格匹配的验证环境，建议开发与生产分别使用测试网关/环境，避免测试策略撤销生产登记。

[Apple 的环境说明](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.devicecheck.appattest-environment)明确指出 TestFlight 等分发构建使用 production；[isSupported](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported) 应在真机检查。App Attest 和 APNs 是两套独立验证，App Attest 通过后仍需完成 APNs 接收挑战。

## 4. 最后开启服务器审批

当前这套 Mohua 实例的 Server ID：

```text
4cb843a7-0d06-40dd-8d1d-b85efe7663d4
```

在网关「服务器接入」登记该 ID，允许的应用填 `mohua`，批准后把只显示一次的凭证保存到 Mohua `.env`：

```dotenv
GATEWAY_SERVER_CREDENTIAL=此处填写批准后生成的凭证
GATEWAY_SERVER_CREDENTIAL_URL=https://push.example.com
```

重新执行上面的 Compose 更新命令。长期凭证只能放在业务 Server，不能发给 iOS，也不要贴进聊天。

再为 `mohua` 开启「只允许已批准的服务器」。回到 App 完成一次新登记及新邮件推送。测试设备票据自动申请、登记和投递。需要验证封禁时，封禁此测试 Server 后旧登记和待发任务应失效；重新批准会生成新凭证，需更新 Server 配置并重新登记。不要用其他生产实例做封禁测试。

## 5. 出错时看哪里

- App 显示「此网关需要配置了相同网关地址的配套客户端」：检查 `MOHUA_GATEWAY_URL` 与 Server 当前网关地址。
- 网关返回应用不存在：确认创建的是 `mohua`。
- `BadDeviceToken` / `DeviceTokenNotForTopic`：核对 APNs 环境、主 App Bundle ID/topic 和 token 所属构建。
- `Application proof required` / `Invalid application proof`：核对新版客户端、签名团队、Bundle ID、App Attest 环境、系统支持和挑战是否过期。
- `Server ticket required` / `Server not authorized`：核对审批状态、允许的应用、Server ID、凭证及绑定的网关根地址。
- 429/503：查看资源额度和 Retry-After，等待冷却；不要立即循环重试。
- 网关「推送记录」显示 accepted 只表示厂商已接受，必须继续确认手机实际行为。

查看运行日志：

```sh
# KookaburraRelay 目录
docker compose logs --since 10m gateway
# Mohua 目录
docker compose logs --since 10m server mail-worker
```

同时结合网关「设备登记」「推送记录」「日志与审计」和 Xcode 真机控制台定位。需要协助时提供发生时间、构建是 Debug 还是 TestFlight、App 状态文案、HTTP 状态/错误原因；不要提供 `.p8`、token、服务器凭证或完整邮箱内容。

独立额度和 Webhook 告警可在上述步骤之外单独验收，见 [接入加固说明](ACCESS_SECURITY.md)。
