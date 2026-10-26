# 部署说明

## 开发线 / 发行版怎么同步

**同一份源码，不分开分支**，区别只在构建标签：

| | 构建命令 | 产物 | 包含 |
|---|---|---|---|
| 发行版 | `.\tools\build.ps1` | `bin/qixinbot.exe` | 常规功能 |
| 开发线 | `.\tools\build.ps1 -Line dev` | `bin/qixinbot-dev.exe` | 常规功能 + 休眠/唤醒实验 |

规则：

1. **框架的普通改动默认两边都有**，不存在"只改了一边"的问题
2. 只有休眠/唤醒这类实验功能放进 `//go:build dev` 的文件（`internal/plugin/experimental_*.go`）
3. 实验功能要在运行时区分插件行为时，用环境变量 `QIXIN_EXPERIMENTAL=1`（开发线自动注入）
4. 提交前跑 `.\tools\check.ps1`：发行版和开发线的 vet/test 都必须过
5. 部署发行版照旧 `.\tools\deploy.ps1`；开发线产物是另一个文件名，不会覆盖发行版

## 内存怎么省（2G 小机器）

实测：框架本身约 22 MB，每个 Node 插件常驻 10~40 MB（取决于插件和运行时长）。

小内存机器建议：

```toml
[plugin]
# 限制每个 Node 插件的堆上限，防止跑一天后涨到几十 MB
node_options = "--max-old-space-size=96"
```

- 只启用真正要用的插件（`/plugins` 页可直接禁用）
- canvas / fortune 这类带大资源的插件最占内存，不用就禁
- 实在不够就只能加内存：23 个 Node 插件全开不适合 2G 机器
- 每晚重启一次也能把 Node 堆释放回基线

## 安全边界（部署前必读）

- **安装插件 = 授予代码执行权限**：插件是独立进程，但以机器人进程的系统权限运行，能读环境变量和 data 目录；只安装可信来源的 `.anzu`。
- 签名：配置了 `[plugin] trusted_keys` 后，没有可信公钥或公钥格式错误会**拒绝安装**，不会静默跳过校验。
- 聊天图片代理：只允许公网 http/https（80/443），拒绝本机/内网/元数据地址，只返回嗅探为图片的内容并带 `nosniff`。
- WebUI：默认密码务必修改；会话令牌使用系统随机数，随机数不可用时登录直接禁用。
- CSRF：所有写操作校验同源 Origin + 会话绑定的 CSRF Token（表单 `_csrf` / 请求头 `X-CSRF-Token`）；退出登录会立即落盘删除会话，改密码会撤销其他会话。
- 控制台 HTTP：ReadHeaderTimeout 5s、ReadTimeout 30s、IdleTimeout 120s、请求头上限 1MB。
- 配置保存：多个管理页面同时保存会串行化（独立临时文件 + 原子替换），不会互相截断。
- 非消息事件（notice/request）走有界队列（256）异步处理：**极端情况下会丢弃**并记录 `dropped` 计数；需要不丢事件的业务请用插件轮询做补偿。
- `config.toml` 保存为仅所有者可读写（0600），里面可能有账号凭据。

## 发行版 / 开发线

```powershell
# 发行版（默认）：不含休眠与定时唤醒
go build -o bin/qixinbot.exe ./cmd/bot

# 开发线：开启休眠/定时唤醒实验功能
go build -tags dev -o bin/qixinbot.exe ./cmd/bot
```

发行版：插件常驻，定时全部由插件自己管理（`setInterval` / `setTimeout`）。框架**不注册** `[[schedule]]`。
开发线：额外的「休眠」页、闲置回收、到点唤醒，属于实验功能，手册见 PLUGIN-DEV.md。

## 目标机器

| 项 | 值 |
|---|---|
| 主机 | `10.0.0.58`（DESKTOP-P2U69JJ，Windows 10 19045，AMD64） |
| 登录 | SSH，用户 `server` |
| 部署目录 | `C:\qqbot` |
| 协议端 | SnowLuma，`C:\Users\server\Desktop\SnowLuma`，WS `127.0.0.1:3001` |
| 令牌 | `<你的 OneBot 令牌>`（WS 和 HTTP 都用这个） |
| 控制台 | `http://<服务器>:7801`，账号密码在 `config.toml` 的 `[web]` 里 |

### mock 协议端的手动推送

`mock-onebot` 除了按 `-text` 自动推，还有个 HTTP 端点可以随时推：

```powershell
# 推到默认群
curl "http://127.0.0.1:3001/push?text=/help"

# 指定群和用户（测多群并发用）
curl "http://127.0.0.1:3001/push?text=/echo+hi&group=1001&user=10001"
curl "http://127.0.0.1:3001/push?text=/echo+hi&group=2002&user=10002"

# 带 @ 或图片
curl "http://127.0.0.1:3001/push?text=你好&at=1"
curl "http://127.0.0.1:3001/push?text=&image=https://example.com/a.png"

# 私聊
curl "http://127.0.0.1:3001/push?text=/help&private=1"
```

**用途**：`qixinpack verify` 就是靠这个端点推消息的。

## 远端目录

```
C:\qqbot\
├── bin\qixinbot.exe      主程序
├── bin\qixinpack.exe     打包工具
├── plugins\              投放区：只放 .anzu
│   ├── echo.anzu
│   └── weather.anzu
├── sdk\node\qixin.mjs    Node 适配器（框架会复制进每个插件的 _sdk/）
├── data\
│   ├── plugins\<id>\     运行区（解压后的插件）
│   │   ├── app\          本体
│   │   ├── deps\         依赖
│   │   ├── data\         运行时数据（升级保留）
│   │   ├── web\          设置页
│   │   └── install.json  安装元信息
│   ├── plugins-state.json 启用/禁用状态
│   ├── overrides.json     权限与 /help 覆盖
│   ├── audit\             审计日志（按天 JSONL）
│   ├── chat.json          聊天面板的最近消息（重启保留）
│   ├── bot.log
│   └── stderr.log
├── config.toml
└── start.bat
```

新装的插件**默认未启用**，需要在 WebUI 里点「启用」。

## 进程管理

用 Windows 计划任务 **QixinBot**（`ONSTART`，以 `server` 身份运行，最高权限）。

```powershell
# 远端执行（ssh 上去或 RDP 打开 PowerShell）
schtasks /Run   /TN "QixinBot"     # 启动（已在跑会直接退出）
schtasks /End   /TN "QixinBot"     # 停止
Stop-Process -Name qixinbot -Force # 强杀
Get-Process qixinbot               # 看状态
Get-Content C:\qqbot\data\stderr.log -Encoding UTF8 -Tail 30   # 看日志
```

> 注意：`Get-Content` 必须加 `-Encoding UTF8`，否则中文乱码。

**为什么用计划任务**：通过 SSH 用 `Start-Process` 起的进程，在 SSH 会话结束时会被一起杀掉（Windows OpenSSH 的作业对象行为）。计划任务不依赖会话。

## 一键部署（本地执行）

```powershell
$env:QQBOT_PASS = '1230'
cd C:\Users\anzu\Documents\xin\onebot-framework
.\tools\deploy.ps1                 # 编译 + 上传 + 重启
.\tools\deploy.ps1 -SkipBuild      # 只上传 + 重启
.\tools\deploy.ps1 -PluginsOnly    # 只更新插件
.\tools\deploy.ps1 -WithConfig     # 连 config.toml 一起覆盖（默认不动远端配置）
```

> 默认**不覆盖远端 `config.toml`**。因为 WebUI 的「连接设置」也会写这个文件，
> 每次部署都冲掉会把线上改的 ws_url/token 弄丢。要强制同步本地配置时加 `-WithConfig`。

脚本做四件事：本地编译 → SFTP 上传 → 远程杀旧进程 → 跑计划任务。

## 手动操作

```powershell
# 执行远端命令
$env:QQBOT_PASS = '1230'
C:\Python314\python.exe tools\ssh_exec.py "Get-Process qixinbot"

# 传单个文件
C:\Python314\python.exe tools\ssh_put.py plugins\echo\index.js C:/qqbot/plugins/echo/index.js
```

密码从 `QQBOT_PASS` 环境变量读，不落盘。

## 配置

`deploy/config.toml` 是生产配置源，改完重新上传：

```powershell
C:\Python314\python.exe tools\ssh_put.py deploy\config.toml C:/qqbot/config.toml
```

关键项：

```toml
[[accounts]]
id = "main"
ws_url = "ws://127.0.0.1:3001"
access_token = "<你的 OneBot 令牌>"

[owner]
users = []        # 填自己 QQ 号后可用 /plugins（列插件状态），且不受权限限制
```

只有一个 QQ，所以只写一组 `[[accounts]]`。

## 控制台

工具面板已移到插件详情页（声明 `use_tools = true` 的插件才显示），框架导航里不再有单独的「工具」页。

浏览器打开 `http://10.0.0.58:7801`，用账号密码登录（配置在 `deploy/config.toml` 的 `[web]`）：

```toml
[web]
addr = "0.0.0.0:7801"
username = "admin"
password = "<控制台密码>"
```

登录后是 7 天有效的 cookie 会话，右上角可退出。密码留空时每次启动会生成临时密码并打印到日志。

八个板块：

| 板块 | 内容 |
|---|---|
| 概览 | 运行时长、**运行时环境**（Node/Python 装没装）、连接状态、**服务插件**、普通插件、最近错误 |
| 连接 | 改 OneBot 地址/令牌，保存后重启生效 |
| 权限 | **主人 QQ**（框架级）、每个插件的 QQ/群白名单、前缀和 @ 下限、角色要求 |
| 插件 | 重载/启用/禁用/删除、**优先级**、上传 .anzu |
| 审计 | 谁在什么时候、对哪个会话做了什么 |
| 指令 | 控制 /help 里显示哪些插件和命令 |
| 日志 | 最近 1000 条，按级别过滤，2 秒刷新 |
| 聊天 | 看消息流、发消息、图片代理 |

### 运行时环境

概览页顶部显示 Node.js / Python 版本和**来源**（框架自带 / 系统 PATH）。
框架自带的运行时从「依赖」页上传 `runtime-*.anzu` 安装，自带共享依赖和字体。

```
Node.js 24.20.0      Python 3.12.10
来源：框架自带        来源：框架自带
```

本机用不了的平台包会被拒绝安装，启动时也会清掉 `data/runtimes` 里的残留。

**Windows 应用商店的 python 是占位符**——文件存在、`where` 能查到，
但真的执行会返回 9009。框架会试跑 `python --version` 来识别这种情况。

Python 插件加载时如果环境不满足，状态会是 `missing_runtime`，错误信息里写明原因和修法。

权限和指令显示的修改存在 `data/overrides.json`，优先级高于 `plugin.toml` 里的声明。

改密码：进「连接」页下方的「登录密码」表单，改完立即生效（会写回 config.toml）。
忘了密码就看远端 `C:\qqbot\config.toml` 的 `[web] password`。

### 断电/重启自启

58 这台机器现在的自启链：

1. Windows 开机 → 自动登录 `server`（`AutoAdminLogon=1`，密码存在 Winlogon 注册表）
2. `QixinBot` 计划任务（开机启动）拉起 `C:\qqbot\bin\qixinbot.exe`
3. 用户启动目录 `Startup\qixin-autostart.cmd`：启动 QQ → 等 45 秒 → 启动 SnowLuma
4. SnowLuma 登录 QQ 后监听 `3001`，QixinBot 自动重连

旧的 `onebot-bot` 计划任务已禁用，避免抢 `7801`。

SnowLuma 必须开自动注入：`config/runtime.json` 里 `hookAutoLoad: true`，启动脚本里也设 `SNOWLUMA_HOOK_AUTOLOAD=1`；否则开机后要手动「进程注入」，3001 不会自己起来。

断电后主板 RTC 可能漂移，`w32time` 已设为自动并同步 `ntp.aliyun.com` / `time.windows.com`；定时类插件（催睡等）依赖本地时间，时间不对会提前/错时触发。

**QQ 必须勾选「自动登录」**。Windows 自动登录只负责进入桌面，不会替 QQ 登录账号；
没勾选的话，断电后 QQ 会停在登录窗口，SnowLuma 就不会监听 3001。

## 更新插件的流程

1. 本地改 `plugins/<name>/`
2. `.\tools\deploy.ps1 -PluginsOnly`
3. 脚本会自动重启

### 发版用脚本，别手工推

```powershell
.\tools\push-release.ps1 -Message "说明"
```

- 二进制 **SHA256 没变** → 直接跳过，不会产生空提交
- 变了 → 复制、写 `release/SOURCE.md`（标明对应源码提交）、提交、推送
- 任何时候都能从 `SOURCE.md` 查到"这个 exe 是哪份代码编的"

### 让 Gitea 公开仓库免登录可看（像 GitHub）

TrueNAS 上的 Gitea 应用默认注入 `GITEA__service__REQUIRE_SIGNIN_VIEW=true`，
即使是公开仓库，网页也要登录（git clone / raw 不受影响）。

在 NAS 上执行（或跑 `tools/gitea_public.py`，密码走 `NAS_PASS` 环境变量）：

```bash
k3s kubectl set env deployment/gitea-ix-chart -n ix-gitea \
  GITEA__service__REQUIRE_SIGNIN_VIEW=false
```

**应用更新/重新部署后可能被还原**，再执行一次即可。
想永久生效：在 TrueNAS「应用 → gitea → 编辑」里把这个环境变量改成 `false`。

### release 仓库只装本体

```
QixinBot-go          框架源码
QixinBot-go-plugins  插件（源码 + 签名包）
QixinBot-release     发行包：bin/ + sdk/ + config.toml + 启动脚本
```

**插件不在 release 里**。用户装插件从插件仓库拿，或在控制台上传。
`package.ps1` 默认不打包插件；确实要做"全家桶"压缩包时才加 `-WithPlugins`。

### 解释器来源

首页只显示来源，不再让用户手填路径：

- 框架自带：从「依赖」页上传 `runtime-node-*.anzu` / `runtime-python-*.anzu`
- 系统 PATH：没有框架运行时时的兜底
- 插件会拿到 `QIXIN_NODE` / `QIXIN_PYTHON` 环境变量，用同一个解释器

需要手工指定时仍可编辑 `data/runtime.json`，但正常使用不需要碰它。

### 升级时的目录占用

升级要先把旧运行目录改名再解压新的。Windows 上插件进程刚停、句柄没释放时
rename 会失败，所以装器会**重试（12 次递增等待）**；旧目录统一用
`.old-<id>-<时间戳>`（**点开头**），管理器扫描时会跳过，不会被当成新插件加载。

### 并发回归测试（-race）

Go 的竞态检测需要 cgo + gcc。本机已装便携版：

```
C:\Users\anzu\Documents\xin\tools\w64devkit\w64devkit\bin\gcc.exe
```

`tools/go-env.ps1` 会自动把它加进 PATH，并设置 `CGO_ENABLED=1`、`GOTMPDIR`。

```powershell
. ..\tools\go-env.ps1
go test -race ./internal/... -count=1
```

**所有 internal 包通过**（含休眠统计并发用例 `TestIdleStatsConcurrent`）。
没有 gcc 时 `-race` 会直接报 "requires cgo"。

### 上传与安装的竞态

部署脚本会边传边被安装器扫到，Windows 上可能撞"文件被占用"。
安装器现在会**重试 6 次（递增等待）**，所以偶发占用不再算失败；
真失败才写 ERROR。

### 只改插件时，别用全量部署

| 改了什么 | 命令 | 会不会重启机器人 |
|---|---|---|
| **只改插件**（app/ panel.html manifest） | `tools\deploy.ps1 -PluginsOnly` | **不会**（热重载 2 秒内生效） |
| 改了 Go 框架 | `tools\deploy.ps1` | 会（要换二进制） |
| 改了 SDK | `tools\deploy.ps1 -PluginsOnly`（SDK 走同一批热重载） | 不会 |

**为什么**：全量部署会先停进程再上传——插件改动根本不需要停，
而且 Windows 上还容易撞上"文件被占用"导致上传失败。

**release 仓库什么时候推**：**框架代码（Go）改了、二进制变了，就推**；只改插件不推。
插件小改只推 `QixinBot-go-plugins`。

热插拔默认开启：更新插件包后 2 秒内自动生效，不用重启；关掉 `hot_reload` 时才需要重启。

## Linux 部署

框架本身跨平台，**代码里没有 Windows 专用逻辑**（WSL 实测可运行）。

### 构建

```powershell
# Windows 上交叉编译
.\tools\build.ps1                       # 同时出 windows + linux
.\tools\build.ps1 -OS linux             # 只出 linux
.\tools\build.ps1 -OS linux -Arch arm64 # 树莓派 / ARM 服务器
```

产物：

```
bin/qixinbot.exe          Windows
bin/linux/qixinbot        Linux
bin/linux/qixinpack       Linux
bin/linux/mock-onebot     Linux
```

Linux 上也可以直接 `go build`，不需要 PowerShell。

### 部署目录

```
/opt/qqbot/
├── config.toml
├── plugins/*.anzu
├── sdk/node/qixin.mjs
├── bin/qixinbot
├── start.sh
└── data/
```

### 启动

```bash
cd /opt/qqbot
chmod +x bin/qixinbot start.sh
./start.sh
```

### systemd

```bash
sudo cp deploy/qixinbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qixinbot
sudo journalctl -u qixinbot -f
```

`qixinbot.service` 里按实际用户改 `User` / `Group` / 路径。

### Linux 上的两个注意点

1. **`node` 必须在 PATH 里**。缺了插件状态会显示 `missing_runtime` 并给出安装提示，不会静默失败。插件的 `exec = ["node", "app/index.js"]` 靠 PATH 找。用 `nvm` 装的要注意 systemd 不读 shell 的 profile，最好用绝对路径或装到系统级。
2. **插件 `exec` 不要写 `.exe`**。跨平台的写法是 `exec = ["node", "app/index.js"]`，让宿主按平台找。

外部命令同理，见 `PLUGIN.md` §6.8 的查找顺序（设置项 → 环境变量 → PATH）。

## 备份与恢复

```powershell
# 打包整个运行目录（config + plugins/*.anzu + data/）
cd C:\qqbot
.\bin\qixinbot.exe -backup C:\backup\qqbot-2026-10-24.zip

# 恢复到当前目录（必须 -force 才覆盖已有 data/）
.\bin\qixinbot.exe -restore C:\backup\qqbot-2026-10-24.zip -force
```

打包内容：`config.toml`、`plugins/*.anzu`、`data/` 全部（含插件运行区、`overrides.json`、`plugins-state.json`、`audit/`）。不含 `bin/`。

恢复后检查 `config.toml` 的 `[web] password`——可能还是备份时的旧密码。

## 排错

### 机器人不理我

按顺序查：

1. 日志里有没有 `收到消息`？没有 → 协议端没把消息推过来
2. 有 `收到消息` 但没 `已处理` → 被门禁或权限拦了
3. 打开 `[log] gate_debug = true` 再看，会有：

```
level=DEBUG msg=门禁拦截 plugin=weather reason=需要命令前缀 text="probe order"
level=DEBUG msg=门禁拦截 plugin=weather reason=权限不足 text="/weather 北京"
```

排查完记得关掉，否则每条消息都会刷 5 条日志。



| 现象 | 看哪里 |
|---|---|
| 进程没起来 | `data\stderr.log` 最后 20 行 |
| 起来了但没反应 | 日志里有没有 `已连接上游` / `登录账号` |
| 连不上 SnowLuma | SnowLuma 是否在跑（`Get-Process node`）、端口 3001 是否监听 |
| 命令不响应 | 日志里 `收到消息` 之后有没有 `已处理` |
| 插件加载失败 | 日志里 `插件清单无效` / `插件启动失败` |

调试时可以直接用 mock 替代 SnowLuma：

```powershell
# 远端
C:\qqbot\bin\mock-onebot.exe -addr 127.0.0.1:3001
```

但要注意 SnowLuma 也占着 3001，必须先停它。


> **删除插件要删两处**：控制台删除只删服务器上的包和运行区；
> 本地 `plugins/<id>.anzu` 还在的话，下次 `deploy.ps1` 会把它重新上传安装。
> 永久删除要同时删本地包和插件仓库里的包。
