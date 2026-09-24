# 通用通知协议

网关负责应用与设备授权、路由、限流、重试及厂商适配。业务含义、密钥交换及解密属于业务 Server 和客户端。网关没有 Mohua 专用发送分支。

| kind | 用途 | APNs | FCM |
| --- | --- | --- | --- |
| sync | 静默同步提示，不保证后台运行 | 支持 | 支持 |
| alert | 可读的标题和内容 | 支持 | 支持 |
| encrypted_alert | 密文与通用兜底提醒 | 支持 | 不支持，登记返回 501 |

## 应用管理和授权

应用编辑界面可分别勾选三种能力；加密通知的兜底标题、内容位于默认收起的高级设置。加密通知始终请求系统通知音，用户可在手机系统设置中关闭声音。旧配置中的 fallback.sound:false 在读取时归一为 true，无需重新保存。普通通知仍保留每条消息的 sound 参数。修改兜底文案不会撤销登记或取消队列任务；修改通知能力保留已有登记。应用配置的 `notifications` 示例：

```json
{"kinds":["sync","alert","encrypted_alert"],"fallback":{"title":"Notes","body":"You have an update"}}
```

旧应用和新应用默认只有 sync。状态接口仅公布应用和渠道共同支持的能力。新增能力不会扩大旧凭证权限，客户端需为新能力申请授权；关闭能力后，对应请求返回 403，仅取消该类型未完成任务并清除其待确认登记，已确认登记及其他类型任务保留。重新开启后，未过期且原本包含该能力的凭证可继续使用；已取消任务不会恢复。已交给 APNs/FCM 的推送无法撤回。应用启停和通道凭据变更仍撤销登记；名称及兜底文案变更不影响登记。

沿用设备证明登记流程，请求增加 `kinds:["sync","alert"]` 等明确的能力集合；或用 `purpose:"encrypted_alert"` 便捷申请 sync 与 encrypted_alert，两者不能同时传入。省略时仅 sync。确认响应返回授权 kinds。发送时同时检查凭证授权及应用当前能力。旧 sync 凭证不能发送可见提醒。

## 发送内容

沿用 `/v1/notify` 或 `/v1/jobs` 的设备 Bearer 凭证和 appId/deviceId/serverId；jobs 另需 requestId。普通提醒的附加字段：

```json
{"kind":"alert","alert":{"title":"会议提醒","body":"会议即将开始","sound":false}}
```

标题和内容均为字符串，最多 120 和 400 个 Unicode 字符，不能同时为空，不接受控制字符。sound 为布尔值，默认 true。普通提醒的内容对网关和推送厂商可读；队列中使用网关密钥加密存储，不属于端到端加密。

加密提醒使用 `kind:"encrypted_alert"` 和 `encryptedNotification:{version:1,keyId,id,expires,ephemeralKey,ciphertext}`。信封仅支持当前 P-256 / HKDF-SHA256 / AES-256-GCM profile，公钥为 65 字节 X9.63 标准 Base64，keyId 为 64 位小写 hex，id 为 UUID 形式，expires 为未来最多 24 小时的 Unix 毫秒，ciphertext 为 28–2400 字节的标准 Base64（nonce + 密文 + tag）。网关校验结构但不解密；业务两端须约定 HKDF、AAD 和明文结构。Mohua 使用自己的 sender/subject 内容和 mohua-notification-v1 域分隔，其他应用可约定自己的内容。

加密通知可省略信封，仅显示应用配置的兜底文案。APNs 设置 mutable-content:1，由应用 Notification Service Extension 解密替换。解密失败或扩展未运行时保留兜底。普通 alert 不启动解密扩展。

APNs 可见提醒携带通用 `relay:{version:1,appId,deviceId,serverId,kind}`；加密提醒另有 encryptedNotification。FCM 普通提醒将 relay 作为 JSON 字符串放在 data 中。客户端应校验作用域。旧静默 perch、设备证明 perchRegistration 字段保留兼容。

sync 禁止附加可见内容，普通和加密内容不能混用。任务响应不返回内容；同一 requestId 更换内容返回 409。任务完成或取消清除内容，重试保留受保护内容。APNs 最终 payload 超过 4096 字节拒绝发送。

## Mohua 迁移

更新网关、Mohua Server/mail-worker、iOS app 和通知扩展；在网关 Mohua 应用启用 sync + encrypted_alert 并设置“你有新邮件”的兜底文案，然后由客户端重新登记和上传通知公钥。内部 new_mail 邮件事件由 Mohua Server 转换为通用 encrypted_alert。网关不接收可读邮件头或正文。没有给既有同步凭证自动提升权限。

上述是代码能力，不代表已部署或完成真实厂商送达验证。FCM 加密通知需要后续实现 Android 解密客户端和对应适配。
