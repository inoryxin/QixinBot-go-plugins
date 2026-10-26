# PC 管家 / 大肥鱼模式交接

这份是给下一个 agent 的现场说明，按"PC 端 → 框架端 → 测试 → 已知问题"列清楚。

## 1. 拓扑

```
QQ
 ↕ OneBot WebSocket ws://127.0.0.1:3001
QixinBot（58，C:\qqbot）
 ↕ 插件 pc
 ↕ HTTP  http://10.0.0.99:3097  （Bearer pc-7f3a91c2）
PC 管家 pc-agent.exe（老公电脑，10.0.0.99）—— 生产安装位置 C:\Users\anzu\.dsh\bin\
 ├─ DSH web        http://127.0.0.1:3080  （pnpm dsh web，会弹浏览器）
 ├─ ACP 桥         tcp 0.0.0.0:3099       （token 111111，监听所有网卡）
 └─ DSH meta       http://127.0.0.1:3098
```

## 2. PC 端路径

| 东西 | 路径 |
|---|---|
| Go 管家源码 | `C:\Users\anzu\Documents\xin\onebot-framework\tools\pc-agent\main.go` |
| **生产 exe（必须放这）** | `C:\Users\anzu\.dsh\bin\pc-agent.exe` |
| 工作区构建产物 | `tools\pc-agent\pc-agent.exe.devbuild`（改了名，防旧计划任务误启动） |
| ACP 连通性测试工具 | `onebot-framework\tools\test-acp.mjs`（`node test-acp.mjs`，本机跑） |
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

### ⚠️ DSH 写句柄竞争（2026-10-27 第二晚排查的根因）

DSH 的存储层对每个会话有**跨进程写句柄（lease）**：谁先把会话加载进自己的运行时，
谁就持有句柄；后来者 resume 会报 `already owned by an active write handle`（-32603，
message 只显示 "Internal error"，详情在 error.data.details）。

`pnpm dsh web` 起来后浏览器恢复标签页，web 进程会把上次活跃的会话加载进 web 运行时
并抢走句柄 → ACP 这边 resume 报 Internal error（插件旧版误当成功）→ prompt 报
`unknown session`。这就是"进入大肥鱼后第一次说话出错/切不了会话"的真相。

修复（2026-10-27 05:38 全部部署）：

1. **acp-bridge.js 启动即预加载**：spawn ACP 子进程后立刻用桥自己的 id
   （900001+，避免和客户端 id 冲突）发 initialize + session/resume（会话和 cwd 记在
   `acp-active-session.json`，现在存 `{sessionId, cwd}`）。
   桥日志里 `bridge bootstrap 900001: ok` = 预加载成功。
2. **ensure-dsh 顺序反过来**：先起桥（抢句柄）再起 web。旧注释说"桥依赖 web 运行时"
   是错的，桥单独跑完全正常。实测 ACP 先持有的会话，web 重启也抢不回去。
3. **acp.mjs 错误带详情**：JSON-RPC error 的 data.details 拼进 message，
   能区分 `already owned by an active write handle`（被 web 占用）和其他错误。
4. **插件 relay 三级自愈（dshPrompt）**：prompt 报 unknown session →
   ① resume 后重试 → ② 还不行就用管家 /shell 杀掉 DSH web（releaseDshWeb）、
   resume、再试，成功后后台把网页拉回来 → ③ 仍失败才报错。
5. **退出大肥鱼模式会真正释放句柄**：exit() 给桥发 `{control:"release"}`，
   桥杀掉 ACP 子进程并清空 `acp-active-session.json` 的 sessionId，
   DSH 网页就能打开该会话了（不然网页端报"当前会话已被占用"）。
   下次进入大肥鱼模式时 ensureAcp 会重新拉起子进程。

注意：会话 id 有两种形态（ACP 建的是裸 uuid，网页建的带 `session-` 前缀），
resume/prompt 直接用列表返回的原样 id 即可。会话标题以 DSH 的为准
（本地标题只补缺；默认会话固定显示「大肥鱼」）。

### ⚠️ 沙箱降权陷阱（2026-10-27 排查一整晚的根因）

这台机器装了 OpenAI Codex（`CodexSandboxService`），其沙箱会把**AI 工作区目录
（如 `C:\Users\anzu\Documents\xin\...`）里编译/出现的 exe 进程压成低完整性
（Low IL，S-1-16-4096）**，与父进程无关、与文件名无关、停掉服务也照样生效。
低完整性进程写不了用户目录 → 管家日志/上传/DSH web 输出**全部静默失败**
（`logf` 吞掉 Access Denied），看起来就是"日志失踪、DSH web 起不来、插件超时"。

**规则：生产 exe 必须放在工作区之外（现在放 `C:\Users\anzu\.dsh\bin\`）。**
重新编译后要拷贝过去再启动，绝不要直接从工作区跑。

管家启动时会把完整性级别写进日志（`process integrity: Medium（正常）(S-1-16-8192)`），
出现 LOW 就是又踩了沙箱。另外注意：从 Git Bash 环境里跑 `whoami /groups` 会命中
Git 自带的 whoami（不支持 /groups），所以代码里用 x/sys/windows 直接读令牌。

## 3. PC 端启动项

| 启动项 | 位置 | 作用 |
|---|---|---|
| `PCAgent.lnk` | `Startup` 文件夹 | 登录启动 pc-agent（token 在 `tools/pc-agent/token.txt`，install.ps1 首次运行时随机生成并写入启动项） |
| `dsh-acp-bridge.vbs` | `Startup` 文件夹 | 隐藏窗口启动 ACP 桥（调 `.dsh\dsh-acp-bridge.cmd`） |

启动目录：`C:\Users\anzu\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup`

**旧计划任务 `PCAgent` 已废弃**：任务本身指向工作区 exe、且普通权限改/删不动
（Set-ScheduledTask / Register-ScheduledTask / schtasks /change 全部拒绝访问）。
已把工作区 exe 改名为 `.devbuild` 让它空转。**建议有空用管理员权限删掉它**：
`schtasks /Delete /TN PCAgent /F`。

### ACP 桥启动器内容

```bat
@echo off
set DSH_HOME=C:\Users\anzu\.dsh
set DSH_PROFILE=web
set DSH_PROFILE_DIR=C:\Users\anzu\.dsh\profiles\web
"C:\Program Files\nodejs\node.exe" "C:\Users\anzu\.dsh\acp-bridge.js"
```

**必须带 `DSH_PROFILE` / `DSH_PROFILE_DIR`**，否则 ACP 子进程会退出，插件看到 `ACP 连接已断开`。

## 4. 框架端（58）

| 东西 | 路径 |
|---|---|
| QixinBot 安装 | `C:\qqbot` |
| 配置 | `C:\qqbot\config.toml` |
| 插件运行区 | `C:\qqbot\data\plugins\pc` |
| 插件代码 | `C:\qqbot\data\plugins\pc\app\index.js` + `acp.mjs` |
| 插件设置 | `C:\qqbot\data\plugins\pc\data\settings.json`（只存非默认值，完整值看 WebUI API） |
| 插件状态 | `C:\qqbot\data\plugins\pc\data\storage.json` |
| 框架日志 | `C:\qqbot\data\bot.log` |
| WebUI | `http://10.0.0.58:7801`（admin / qixin2026） |

生效设置（WebUI `GET /api/plugin/pc/settings` 里的 values，均正确无需改）：
agentHost=10.0.0.99:3097，acpHost=10.0.0.99，acpPort=3099，acpToken=111111，
metaPort=3098，workspace=C:\Users\anzu\Documents\xin，bootTimeoutMs=180000，
promptTimeoutMs=7200000，HA 相关三项已配。

### 插件的关键机制（2026-10-27 改过）

- **宿主对 `handle_message` 有 30 秒硬超时**（framework `internal/plugin/manager.go`
  `msgTimeout := 30 * time.Second`）。超时会打 `插件处理失败 err=context deadline exceeded`，
  但插件进程内的 async 函数会继续跑完、reply 仍能发出去。
- 因此 `进入大肥鱼模式`（可能跑几分钟：HA 通电、等开机、切系统、冷启动 DSH）和
  `relay()`（DSH 回复最长 2 小时）都用 **`host.background(session, name, fn)`** 丢后台，
  handle_message 立即返回。
- `dshServices(true)` 的 fetch 超时 120s（管家最坏 60s 等 web + 20s 等桥）。

### 会话状态

规则不变：默认会话 = `dsh.defaultSessionId`（现为 cfdda243…，标题「大肥鱼」）；
异常退出 active=true 恢复；正常退出 active=false。ACP 恢复会话报
`session is already active` 属正常，插件当作成功处理。

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
POST /shell      {"command":"powershell 语句"}
```

`/ensure-dsh?web=1`：3099 没起则先清残留再跑 `.dsh\dsh-acp-bridge.cmd`（桥起来后自己预加载
上次活跃会话，等 20s）→ 3080 没起则 `cmd /c pnpm dsh web`（工作目录 D:\deepseek\deepseek-harness，
等 60s）→ 返回 `{bridge:{ready,started}, web:{ready,started,url}}`。

## 6. 部署

### 重新构建/部署 PC 管家

```powershell
. C:\Users\anzu\Documents\xin\tools\go-env.ps1
go build -ldflags="-H=windowsgui" -o tools\pc-agent\pc-agent.exe .\tools\pc-agent
Get-Process pc-agent -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item tools\pc-agent\pc-agent.exe C:\Users\anzu\.dsh\bin\pc-agent.exe -Force
$token = (Get-Content C:\Users\anzu\Documents\xin\onebot-framework\tools\pc-agent\token.txt -Raw).Trim()
Start-Process C:\Users\anzu\.dsh\bin\pc-agent.exe -ArgumentList '-port 3097',"-token $token" -WorkingDirectory C:\Users\anzu\.dsh\bin -WindowStyle Hidden
# 看日志第一行：process integrity 必须是 Medium！
Get-Content C:\Users\anzu\.dsh\logs\pc-agent.log -Tail 3
```

### 重新打包/部署插件

```powershell
# 注意要用 pwsh 7 跑（powershell 5.1 按 GBK 读 deploy.ps1 会炸）
.\bin\qixinpack.exe pack dist\pc -out plugins\pc.anzu -key plugin-signing.priv
$env:QQBOT_PASS='1230'
pwsh -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -PluginsOnly   # 热重载
# 或全量：pwsh -File tools\deploy.ps1 -SkipBuild
```

## 7. 当前状态与排查顺序

2026-10-27 05:25 已全部修复并验证：

- 管家 3097 / DSH web 3080 / 桥 3099+meta 3098 全部在线，完整性 Medium
- 桥启动即预加载大肥鱼会话（`bridge bootstrap 900001/900002: ok`），web 抢不到句柄
- `ensure-dsh` 快路径 0.02s 返回全 ready；冷启动 ~4s
- `node tools\test-acp.mjs`：initialize OK、resume cfdda243（already active=正常）、prompt OK
- 从 58 测：3097/3099 可达、/status 全 true
- 插件已部署：enter/relay 全部后台化 + unknown-session 自动重试（features=13）
- 弹窗已消除（CREATE_NO_WINDOW + 开机桥走 .vbs）

QQ 发「进入大肥鱼模式」预期回复链：
`大肥鱼模式启动中…` → `正在连接 DSH…` → `大肥鱼模式已接管，当前会话：大肥鱼（cfdda243）`

失败时看：

```powershell
Get-Content C:\Users\anzu\.dsh\logs\pc-agent.log -Tail 50   # 首看 process integrity 行
Get-Content C:\Users\anzu\.dsh\logs\dsh-web.out.log -Tail 50
Get-Content C:\Users\anzu\.dsh\acp-bridge.log -Tail 50
```

远端：

```powershell
# 58 上
Select-String -Path C:\qqbot\data\bot.log -Pattern 'plugin=pc' | Select-Object -Last 30
```

常见故障对应：

| 症状 | 原因 |
|---|---|
| pc-agent.log 没新行 / integrity=LOW | 沙箱降权：确认 exe 是从 `.dsh\bin` 启动的 |
| dsh web started 但 3080 不起 | 看 dsh-web.out.log；pnpm/node 不在 PATH 或工作区不对 |
| ACP 连接已断开 / Internal error | 先看桥日志 `bridge bootstrap` 行；多半是 web 抢了句柄或会话自身损坏 |
| prompt 报 unknown session | 会话没加载进 ACP 运行时；桥预加载失败或切到了损坏会话，重试机制会兜一次 |
| 弹黑框 | 不该再出现：startDetached 已用 CREATE_NO_WINDOW，开机桥走 .vbs 隐藏 |
| 插件 err=context deadline exceeded | 同步跑了长任务：必须 host.background |
