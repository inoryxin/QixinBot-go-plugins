# 催睡（sleep-guard）

移植自旧 bot 的 sleep-guard。

- 每天 05:00 检查状态页，主人手机/电脑还亮着就通过 `ai.chat` 私聊催睡
- 30 分钟后还没睡，再催一次（语气更凶）
- 主人已经息屏/锁屏就跳过
- 手动命令「催睡」只允许配置的主人 QQ 使用

## 设置

| key | 说明 |
|---|---|
| `enabled` | 总开关 |
| `hour` / `minute` | 检查时间，默认 05:00 |
| `retryMinutes` | 二次催促间隔，默认 30 |
| `userId` | 主人 QQ |
| `statusUrl` | 状态页地址 |
| `deviceKeywords` | 设备关键词，逗号分隔 |
| `timeoutMs` | 状态页超时 |

## 工具

`get_sleep_guard_status`：返回今天是否催过、最近一次时间。
