# 电脑管家（PC Agent + 电脑插件）

把原来的 `pc-status`（状态/截图）和 `dsh-mode`（唤醒 DSH、接管 QQ）合并成：

```
PC 上一个程序：tools/pc-agent/pc-agent.js
框架一个插件：dist/pc
```

## PC 端

安装/更新（不需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\pc-agent\install.ps1
```

它会：

- 写入 `Startup\pc-agent.vbs`，登录自启
- 如果 agent 退出，5 秒后自动拉起
- 监听 `0.0.0.0:3097`

默认 token：`pc-7f3a91c2`，可用环境变量 `PC_AGENT_TOKEN` 改。

## Agent 接口

```text
GET  /healthz
GET  /status          CPU/内存/磁盘/电池/DSH 状态
GET  /screen          当前屏幕 JPEG
GET  /dsh-url         DSH 带 token 的地址
POST /ensure-dsh?web=1   启动 ACP 桥（3099）和 DSH web（3080）
POST /open?url=...       打开浏览器
POST /action?action=shutdown|restart|sleep|hibernate|lock|logoff
POST /shell              token 保护的 PowerShell（插件默认不调用）
POST /upload?name=...    上传图片到 PC
GET  /file?path=...      读取 PC 文件
```

## QQ 命令

```text
电脑                     状态
截图                     截屏
电脑操作 关机/重启/睡眠/休眠/锁屏/注销
进入大肥鱼模式           唤醒 DSH，连接 ACP，接管私聊
退出大肥鱼模式 [并关机]
新会话 / 会话列表 / 切换 n / 切换大肥鱼
```

工具：`get_pc_status`、`pc_screenshot`、`pc_action`、`get_dsh_status`。

## 和旧插件的区别

- 不再需要单独跑 `pc-hub`、`pc-agent`、`dsh-watchdog`、`dsh-mode`
- 一个 agent 负责状态、截图、PC 操作、DSH 唤醒
- 一个插件负责 QQ 命令和 DSH 接管
- DSH 重连状态存 `host.storage`，框架重启后自动尝试接回

## 注意

- `进入大肥鱼模式` 只接管**私聊**，群聊仍走普通插件
- `电脑操作` 和 `进入大肥鱼模式` 只允许主人（`QIXIN_OWNER`）使用
