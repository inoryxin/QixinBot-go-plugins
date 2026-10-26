# PC 管家 / 大肥鱼模式交接

这份是给下一个 agent 的现场说明，按“PC 端 → 框架端 → 测试 → 已知问题”列清楚。

## 1. 拓扑

```
QQ
 ↕ OneBot WebSocket ws://127.0.0.1:3001
QixinBot（58，C:\qqbot）
 ↕ 插件 pc
 ↕ HTTP  http://10.0.0.99:3097  （Bearer pc-7f3a91c2）
PC 管家 pc-agent.exe（老公电脑，10.0.0.99）
 ├─ DSH web        http://127.0.0.1:3080  （pnpm dsh web，会弹浏览器）
 ├─ ACP 桥         tcp 127.0.0.1:3099     （token 111111）
 └─ DSH meta       http://127.0.0.1:3098
```

## 2. PC 端路径

| 东西 | 路径 |
|---|---|
| Go 管家源码 | `C:\Users\anzu\Documents\xin\onebot-framework\tools\pc-agent\main.go` |
| Go 管家程序 | `C:\Users\anzu\Documents\xin\onebot-framework\tools\pc-agent\pc-agent.exe` |
| 安装脚本 | `C:\Users\anzu\Documents\xin\onebot-framework\tools\pc-agent\install.ps1` |
| 管家日志 | `C:\Users\anzu\.dsh\logs\pc-agent.log` |
| DSH 仓库 | `D:\deepseek\deepseek-harness` |
| DSH web 启动 | `cd /d D:\deepseek\deepseek-harness` → `pnpm dsh web` |
| DSH web 日志 | `C:\Users\anzu\.dsh\logs\dsh-web.out.log` |
| DSH 带 token 地址 | `C:\Users\anzu\.dsh\web-url.txt` |
| ACP 桥源码 | `C:\Users\anzu\.dsh\acp-bridge.js` |
| ACP 桥启动器 | `C:\Users\anzu\.dsh\dsh-acp-bridge.cmd` |
| ACP 桥日志 | `C:\Users\anzu\.dsh\acp-bridge.log` |
| ACP 当前会话 | `C:\Users\anzu\.dsh\acp-active-session.json` |
| 旧启动项备份 | `C:\Users\anzu\.dsh\old-startup-backup` |

### ACP 桥启动器内容

```bat
@echo off
set DSH_HOME=C:\Users\anzu\.dsh
set DSH_PROFILE=web
set DSH_PROFILE_DIR=C:\Users\anzu\.dsh\profiles\web
"C:\Program Files\nodejs\node.exe" "C:\Users\anzu\.dsh\acp-bridge.js"
```

**必须带 `DSH_PROFILE` / `DSH_PROFILE_DIR`**，否则 ACP 子进程会退出，插件看到 `ACP 连接已断开`。

## 3. PC 端启动项

| 启动项 | 位置 | 作用 |
|---|---|---|
| `PCAgent` 计划任务 | 任务计划程序 | 登录运行 Go 管家 `pc-agent.exe -port 3097 -token pc-7f3a91c2` |
| `dsh-acp-bridge.cmd` | `Startup` | 登录启动 ACP 桥（调用 `.dsh\dsh-acp-bridge.cmd`） |

启动目录：

```
C:\Users\anzu\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
```

## 4. 框架端（58）

| 东西 | 路径 |
|---|---|
| QixinBot 安装 | `C:\qqbot` |
| 配置 | `C:\qqbot\config.toml` |
| 插件运行区 | `C:\qqbot\data\plugins\pc` |
| 插件代码 | `C:\qqbot\data\plugins\pc\app\index.js` |
| 插件 ACP 客户端 | `C:\qqbot\data\plugins\pc\app\acp.mjs` |
| 插件设置 | `C:\qqbot\data\plugins\pc\data\settings.json` |
| 插件状态（默认会话） | `C:\qqbot\data\plugins\pc\data\storage.json` |
| 框架日志 | `C:\qqbot\data\bot.log` |
| WebUI | `http://10.0.0.58:7801`（admin / qixin2026） |

### 插件设置

`GET/POST http://10.0.0.58:7801/api/plugin/pc/settings`：

```json
{
  "agentHost": "10.0.0.99:3097",
  "agentToken": "pc-7f3a91c2",
  "acpHost": "10.0.0.99",
  "acpPort": 3099,
  "acpToken": "111111",
  "metaPort": 3098,
  "workspace": "C:\\Users\\anzu\\Documents\\xin",
  "haUrl": "https://10.0.0.123:8123",
  "haEntity": "switch.lemesh_cn_1117316460_sw0a04_on_p_2_1",
  "archPort": 22222,
  "archLaunchUrl": "http://10.0.0.99:22222/launch?token=111111&app=reboot",
  "bootTimeoutMs": 180000
}
```

### 会话状态

`C:\qqbot\data\plugins\pc\data\storage.json`：

```json
{
  "dsh": {
    "active": false,
    "defaultSessionId": "cfdda243-90c0-4dda-910d-663168e1d695",
    "sessionId": ""
  },
  "sessionTitles": { "...": { "title": "大肥鱼" } }
}
```

规则：

- 默认会话 = `dsh.defaultSessionId`
- 异常退出：`active` 仍为 true、`sessionId` 还在 → 启动/重连时恢复它
- 正常退出：`active=false`、`sessionId=''`，但 `defaultSessionId` 保留
- `新会话` / `切换 n` 只改 `sessionId`，不改 `defaultSessionId`

## 5. Agent API

头：`Authorization: Bearer pc-7f3a91c2`

```text
GET  /healthz
GET  /status
GET  /screen
GET  /dsh-url
POST /ensure-dsh?web=1
POST /open?url=...
POST /action?action=shutdown|restart|sleep|hibernate|lock|logoff
POST /upload?name=...
GET  /file?path=...
POST /shell
```

`/ensure-dsh?web=1` 当前行为：

1. 若 3080 没起：`cmd /c pnpm dsh web`（工作目录 `D:\deepseek\deepseek-harness`）
2. 等 3080
3. 若 3099 没起：清掉残留 `--profile acp` 进程，再运行 `C:\Users\anzu\.dsh\dsh-acp-bridge.cmd`
4. 返回 `{bridge:{ready,started}, web:{ready,started,url}}`

## 6. 关闭 DSH 后测唤醒

在 PC 上手动模拟“DSH 关了”：

```powershell
# 1. 关 DSH web
Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 2. 关 ACP 桥
Get-NetTCPConnection -LocalPort 3099 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

# 3. 确认都关了
Get-NetTCPConnection -LocalPort 3080,3099 -State Listen -ErrorAction SilentlyContinue

# 4. 确认 Go 管家活着
Get-Process pc-agent
Invoke-RestMethod http://127.0.0.1:3097/status -Headers @{Authorization='Bearer pc-7f3a91c2'} | ConvertTo-Json -Depth 4
```

在 QQ（主人号）发：

```
进入大肥鱼模式
```

预期：

```
大肥鱼模式启动中，先检查你电脑开没开…
正在连接 DSH…
大肥鱼模式已接管，当前会话：大肥鱼（cfdda243）
```

失败时看：

```powershell
Get-Content C:\Users\anzu\.dsh\logs\pc-agent.log -Tail 50
Get-Content C:\Users\anzu\.dsh\logs\dsh-web.out.log -Tail 50
Get-Content C:\Users\anzu\.dsh\acp-bridge.log -Tail 50
```

远端看：

```powershell
Get-Content C:\qqbot\data\bot.log -Tail 100
```

## 7. 当前已知问题

最后一次测试（2026-10-27 04:xx）：

- Go 管家 `3097` 在线
- DSH web `3080` 在线
- ACP 桥 `3099` 曾掉线
- 进入大肥鱼模式报 `The operation was aborted due to timeout`
- 之前出现 `ACP 连接已断开`、`Internal error`

排查顺序：

1. `3099` 是否在听 → 不在就运行 `.dsh\dsh-acp-bridge.cmd`
2. 看 `acp-bridge.log` 有没有 `acp spawned` / `acp exited`
3. 如果 ACP 子进程退出，确认启动桥时带了 `DSH_PROFILE=web`、`DSH_PROFILE_DIR`
4. 清理所有 `node --profile acp` 残留再起桥
5. 确认默认会话 `cfdda243` 在 DSH 会话缓存里

## 8. 重新构建/部署 PC 管家

```powershell
. C:\Users\anzu\Documents\xin\tools\go-env.ps1
go build -ldflags="-H=windowsgui" -o tools\pc-agent\pc-agent.exe .\tools\pc-agent
Get-Process pc-agent | Stop-Process -Force
Start-ScheduledTask -TaskName PCAgent
```

## 9. 重新打包/部署插件

```powershell
. C:\Users\anzu\Documents\xin\tools\go-env.ps1
.\bin\qixinpack.exe pack dist\pc -out plugins\pc.anzu -key plugin-signing.priv
.\tools\deploy.ps1 -SkipBuild
```

## 10. 相关提交

```
QixinBot-go          8e35e8f ... 后续
QixinBot-go-plugins  b1e43cc ... 后续
```
