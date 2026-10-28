# QixinBot

基于 OneBot 11 的机器人框架。**宿主用 Go，插件用任意语言**（独立进程，stdio + JSON-RPC 2.0）。

单二进制部署：`qixinbot.exe` + 一堆 `.anzu` 插件包，拷过去改个配置就能跑。

## 现在能做什么

### 消息与插件

- 连接 OneBot 11 协议端（SnowLuma 已实测），断线自动重连 + 30s 心跳保活（静默掉线秒级感知重连）
- 插件以**独立子进程**运行，崩溃只影响自己，宿主按退避策略重启（1/2/4/8/16 秒，6 次后禁用）
- **热插拔**：丢 `.anzu` 进 `plugins/` 自动装（默认未启用），删掉自动卸（数据保留）
- 插件生命周期：启用 / 禁用 / 重载 / 删除 / 上传 / 改优先级 / 改权限
- 支持 **Node.js 和 Python** 写插件，依赖统一放 `deps/`

### 能力系统

- **服务插件**（`kind = "service"`）只提供能力，不接消息：`sqlite`、`ai-llm`、`ai-life`
- 插件之间通过 `host.capability()` 调用，多提供者按优先级选；**提供者被卸载或不可用时自动切换到下一个**
- 内置能力：数据库、LLM 调用；图片渲染由运行时 `@napi-rs/canvas` + SDK `canvas-kit` 提供

### 控制台

八个页面：概览 · 连接 · 权限 · 插件 · 指令 · 聊天 · 审计 · 日志

- **共享运行时宿主（实验）**：manifest 加 `cohost = true` 的纯 JS 插件共用一个
  Node 进程，内存省 ~50-60%（28 插件实测 1.0GB → ~430MB）；崩溃域 worker 级、
  自动重启重初始化、熔断自动回退独占——详见 COHOST-DESIGN.md 与 PLUGIN.md §0.2
- **主题**：跟随系统 / 浅色 / 深色，右上角切换，存在浏览器本地（localStorage），
  深色用户刷新不闪白。全部页面颜色走 CSS 变量，加新样式别写死色值。
  支持**主题包**（kind="theme" 的 .anzu：色板 + theme.css + 素材，过签名闸门），
  在「连接 → 界面主题」上传切换——官方示例：插件仓库 `themes/sakura` 樱花庭园

- **概览**：运行时环境检测（Node/Python 装没装，能识别 Windows 应用商店占位符）、服务插件、普通插件、最近错误
- **权限**：按插件控制的 QQ/群白名单、前缀和 @ 的下限开关
- **插件**：启停、删除、优先级（数字大的先收到消息）、上传
- **聊天**：看消息流、发消息、图片代理

### 其它

- `/help` 两级菜单（编号或中文名进详情），按调用者权限过滤
- 审计：谁在什么时候对哪个会话做了什么，按天分文件
- 发送队列：同会话串行 + 最小间隔限频
- 消息落盘、备份/恢复、插件崩溃自愈
- mock 协议端（`tools/mock-onebot`）：不开 QQ 也能跑通全链路

支持 Windows / Linux，`tools/build.ps1` 一次构建两个平台。

## 快速开始

### 不用 QQ（本地调试）

```bash
# 终端 1：假协议端，连上 2 秒后推一条消息
go run ./tools/mock-onebot -text "/help"

# 终端 2：框架
cp config.example.toml config.toml
go run ./cmd/bot -config config.toml
```

随时手动推：

```bash
curl "http://127.0.0.1:3001/push?text=/help&at=1"
```

### 接真 QQ

1. 协议端（SnowLuma 等）里开 OneBot WebSocket 服务端，默认 `ws://127.0.0.1:3001`
2. 改 `config.toml` 的 `[accounts.main]`，填 `ws_url` 和 `access_token`
3. 启动，日志出现 `登录账号 self_id=...` 即成功

## 写一个插件

### 生成骨架

```powershell
.\bin\qixinpack.exe new my-plugin -name 我的插件
```

### 或者手写

`manifest.toml`：

```toml
id = "hello"
name = "问候"
version = "1.0.0"
apiVersion = "1.x"
exec = ["node", "app/index.js"]
description = "打个招呼"

[[commands]]
id = "hello.greet"
usage = "hello"          # 不要写 /，框架会加
description = "向机器人打招呼"
```

`app/index.js`：

```js
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

serve({
  async handle_message({ session }) {
    if (session.text.trim() !== 'hello') return { handled: false }
    await host.reply(chatOf(session), '你好呀')
    return { handled: true }
  },
})
```

### 本地调试（一条命令）

```powershell
cd my-plugin
..\bin\qixinpack.exe dev . -watch
```

自动起假协议端 + 框架 + 你的插件，控制台 `http://127.0.0.1:7801`（`admin` / `dev`）。

**`-watch` 让保存即生效**：改完代码不用重启，1 秒内自动重新打包并重载。

进去点「聊天」→「🧪 虚拟群」，发消息就能看到插件回复——**不连真实 QQ**。

### 跑一遍验证

```powershell
.\bin\qixinpack.exe test .        # 命令有没有坏（注入，快）
.\bin\qixinpack.exe verify -ask   # 时序有没有问题（真实 WS，慢但真）
```

`test` 查"命令还能不能触发"，`verify` 查"多个群并发时会不会互相堵"。

### 打包分发

```powershell
.\bin\qixinpack.exe pack my-plugin -out plugins\my-plugin.anzu
```

丢进 `plugins/`，**2 秒内自动装好**（默认未启用，去控制台点「启用」）。

完整规范见 [PLUGIN.md](./PLUGIN.md)。

## 安全边界（重要）

**进程隔离 ≠ 安全沙箱**。请务必理解这一点：

| 隔离了什么 | 没隔离什么 |
|---|---|
| ✅ 崩溃：插件崩溃不拖死宿主 | ❌ 文件系统：插件能读你用户能读的**所有文件** |
| ✅ 卡死：插件死循环不影响消息分发 | ❌ 网络：插件能连任何地址 |
| ✅ 依赖冲突：各插件独立 `deps/` | ❌ 命令：插件能执行任何系统命令 |

**插件和你自己的程序以同一用户权限运行**。装一个来路不明的插件，等于给了对方你的用户权限。

### 部署建议

1. **只装你信任的插件**，或者自己审过代码的
2. **用专用低权限账号**跑 bot（不要用 Administrator / root）
3. **控制台不要暴露到公网**——默认 `127.0.0.1:7801`，远程访问用 SSH 隧道或 HTTPS 反代
4. **高风险操作加权限**：能改外部状态的插件（控家电、发 HTTP 请求），配 `allow_users`
5. **签名校验**：`config.toml` 的 `plugin.trusted_keys` 非空时，包必须签名；为空则跳过校验（开发模式）

### 控制台的访问控制

- 登录用 Cookie session（`HttpOnly` + `SameSite=Lax`）
- **`Secure` 自动跟着请求走**：HTTPS（含反代带 `X-Forwarded-Proto: https`）时自动加上，HTTP 下不加
- **转发头只在可信代理时才采信**：`[web] trusted_proxies` 配了才读 `X-Forwarded-For`，且从右往左解析
- 登录有失败次数限制（防暴力破解）

## 能支撑什么，不能支撑什么

**诚实评估**，不是营销。

### 接口：够写复杂插件

| 能力 | 状态 |
|---|---|
| 消息段（文本/图片/@/表情/文件/卡片/聊天记录） | ✅ |
| 发送（排队、限频、markdown、媒体路径校验） | ✅ |
| 权限（主人/白名单/前缀/@/角色/冷却） | ✅ |
| OneBot 原始调用、能力调用、私有存储 | ✅ |
| 设置（schema + WebUI 渲染 + 敏感字段） | ✅ |
| 结构化命令（`args` 解析）、两步交互 | ✅ |
| 工具（给 AI 调用的 `[[tools]]`） | ✅ |

**做 AI 聊天、订阅推送、小游戏、管理工具，够用。**

### 运行环境：能做到

| 能力 | 状态 |
|---|---|
| 进程隔离（插件崩溃不拖死宿主） | ✅ |
| 崩溃自动重启（1/2/4/8/16 秒退避，6 次后禁用） | ✅ |
| 独立依赖（各插件自己的 `deps/`） | ✅ |
| 运行时检测（Node/Python 版本、外部程序） | ✅ |
| 单条消息超时（30 秒，可配） | ✅ |
| **消息入口并发**（按会话 worker，同群保序） | ✅ |
| 命令冷却（用户/群/插件三个维度） | ✅ |

### 运行环境：做不到

| 能力 | 现状 | 为什么 |
|---|---|---|
| **CPU / 内存配额** | ❌ | 插件和你的程序抢同一台机器 |
| **沙箱** | ❌ | 插件能读你能读的所有文件、能连任何地址 |
| **长任务后台化** | ⚠️ | `handle_message` 里做长活会占住会话；该用 `host.background` |
| **QPS / 队列长度面板** | ⚠️ | 只有日志，没有实时曲线 |

**前两条不做是有意的**：配额和沙箱要 cgroup / 容器，和"单二进制部署"冲突。

### 多群并发实测

| 层 | 控制什么 | 默认 |
|---|---|---|
| **会话池**（宿主） | 同群串行、不同群并行 | 已开启 |
| **`concurrency`**（插件） | 同一个插件的多个群能不能同时跑 | `plugin`（串行） |

**一个睡 2 秒的插件，两个群同时调**：

```
plugin 模式：  5549ms   ← 排队
session 模式： 3118ms   ← 并行
```

**要真正并行，两层都得放开。**

### 长交互已验证

真实 WS 路径实测：

```
ASK_START
   ↓ 2 秒后用户回复
交互回答已投递 user=20000 text=小明
ASK_END name=小明
已处理
```

**入口拦截生效**，不会再和队列互相等死。

---

## 现状

**能用，但生态为零**。

| 项 | 状态 |
|---|---|
| 核心框架 | ✅ 稳定（13 个插件实际在跑） |
| 插件数量 | ⚠️ 只有自带的 13 个 |
| 自动化测试 | ⚠️ 有核心路径测试（权限/清单/前缀剥离） |
| CI | ✅ Gitea Actions（vet / test / 跨平台构建 / JS 语法） |
| 插件仓库/市场 | ❌ 尚无（装插件靠拷 `.anzu`） |
| 多账号 | ⚠️ 数据结构支持，实际只用单账号 |
| 协议 | ⚠️ 只支持 OneBot v11 |
| 存储 | ✅ SQLite（默认）或 JSON，自动迁移 |

**已知限制**：

- 插件设置（`settings.json`）还是每插件一个文件，没走统一存储（数据量小、写频率低）
- 插件崩溃后的 stderr 只能去 `data/bot.log` 翻，控制台里没有专门展示

## 升级兼容性

**框架升级不需要改插件**——这是硬承诺（见 `API.md` §0）。

最近几轮加的这些东西，**全部向后兼容**：

| 新能力 | 旧插件受影响吗 |
|---|---|
| 结构化命令（`args`） | ❌ 不声明就用原来的方式解析 |
| `host.ask` / `host.background` | ❌ 新增方法 |
| 命令冷却 | ❌ 不配就不限制 |
| 失败反馈（"没有这个命令"） | ❌ 框架层，插件不用管 |
| `/取消` | ❌ 框架层 |
| 消息入口并发池 | ❌ 透明替换，行为更好了 |
| `db.sqlite` 内置 | ⚠️ **只有 ai-chat 改过**（去掉了对 sqlite 插件的依赖） |
| 服务器资源监控 | ❌ 纯新增 |

**实测**：现有插件在最新框架上全部 `ready`，命令都能用。

**唯一一次必须改的是 ai-chat**——它原来依赖 `sqlite` 插件提供 `db.sqlite`，
后来框架把这个能力内置了，所以去掉了那条 `[[requires]]`。

**想吃到新能力的插件可以自愿改**：

| 想用 | 怎么改 |
|---|---|
| 结构化参数 | manifest 里加 `args` |
| 长交互 | 把自存的等待状态换成 `host.ask` |
| 长任务 | 把同步等待换成 `host.background` |
| 多群并行 | 加 `concurrency = "session"` |
| 防刷屏 | 加 `[cooldown]` |

**不改也能正常跑**。

## 目录

```
cmd/bot/              宿主入口
internal/
  onebot/             OneBot 11 客户端（连接、重连、事件归一化、Call）
  session/            交给插件的会话上下文
  registry/           统一 Feature 注册表（help/权限/工具的数据源）
  plugin/             清单、子进程、JSON-RPC、分发、能力、热插拔、安装
  perm/               权限判定
  help/               /help 渲染
  send/               发送队列（串行 + 限频）
  webui/              控制台（8 个页面 + API）
  audit/ backup/ chatbuf/ shared/ config/ logbuf/ render/ override/
sdk/node/qixin.mjs    Node.js 插件适配器（框架注入到每个插件的 _sdk/）
sdk/python/qixin.py   Python 插件适配器
tools/
  qixinpack/          插件打包工具（new / pack / check / keygen）
  mock-onebot/        假协议端
  build.ps1           多平台构建
  deploy.ps1          远程部署
plugins/              投放区：丢 .anzu 进来自动装
```

## 文档

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 模块、数据流、启动顺序、设计决策 |
| [API.md](./API.md) | `plugin.*` / `host.*` 接口全集、HTTP API、错误码 |
| [PLUGIN.md](./PLUGIN.md) | 插件设计规范：清单、命令、设置、权限、目录约定 |
| [ANZU.md](./ANZU.md) | `.anzu` 包格式、签名、目录布局 |
| [PROTOCOL.md](./PROTOCOL.md) | 传输层细节、时序、错误码 |
| [SNOWLUMA.md](./SNOWLUMA.md) | 协议端对接 |
| [PC.md](./PC.md) | PC 管家：状态/截图/操作/DSH 唤醒与接管 |
| [DEPLOY.md](./DEPLOY.md) | 部署与运维 |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 需求表与里程碑 |

改代码必须同步改文档，规则见 [AGENTS.md](./AGENTS.md)。
