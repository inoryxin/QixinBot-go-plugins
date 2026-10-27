# 框架说明

- 版本：1.0
- 日期：2026-10-28
- 关联：[API.md](./API.md)（接口）、[PLUGIN.md](./PLUGIN.md)（插件规范）、[PLUGIN-DEV.md](./PLUGIN-DEV.md)（开发线实验功能）、[ANZU.md](./ANZU.md)（包格式）

> **两条构建线**：发行版（默认）不含休眠/定时唤醒，所有定时由插件自己管理；
> 开发线（`-tags dev`）额外启用框架调度、闲置回收、到点唤醒。
> 本文标注「开发线」的段落只在开发线生效。

---

## 1. 定位

一个 OneBot 11 机器人框架：**宿主用 Go 写，插件用任意语言写，默认跑在独立进程里**
（纯 JS 插件可声明 `cohost = true` 共享一个 Node 进程省内存，实验功能，见 COHOST-DESIGN.md）。

宿主只做四件事：连协议端、管插件、判权限、发消息。业务逻辑全在插件。

```
┌──────────────────────────────────────────────┐
│  控制台（WebUI）  HTTP + 账号密码 + 浅/深主题     │
├──────────────────────────────────────────────┤
│  调度与注册表     Feature / 权限 / 帮助 / 工具    │
├──────────────────────────────────────────────┤
│  插件宿主         子进程/共享宿主 + JSON-RPC over stdio │
├──────────────────────────────────────────────┤
│  协议层           OneBot 11 WebSocket 客户端     │
└──────────────────────────────────────────────┘
```

---

## 2. 模块

| 包 | 职责 | 关键类型 |
|---|---|---|
| `internal/config` | 配置加载、校验、回写 | `Config` |
| `internal/onebot` | WS 连接、重连、事件解析、action 调用 | `Client`、`Event`、`Segment` |
| `internal/session` | 交给插件的上下文 | `Session`、`EventPayload` |
| `internal/registry` | 统一功能注册表 | `Feature`、`Registry` |
| `internal/plugin` | 清单、安装、子进程、分发、设置 | `Manifest`、`Installer`、`Host`、`Manager` |
| `internal/perm` | 权限判定 | `Policy`、`Checker` |
| `internal/override` | WebUI 改的权限与显示覆盖 | `Store`、`Policy` |
| `internal/help` | `/help` 渲染 | `Render`、`FormatUsage` |
| `internal/send` | 发送队列（同会话串行 + 限频） | `Queue` |
| `internal/logbuf` | 内存日志环形缓冲 | `Buffer` |
| `internal/audit` | 审计日志（按天 JSONL） | `Logger`、`Entry` |
| `internal/backup` | 运行目录打包与恢复 | `Create`、`Restore` |
| `internal/webui` | 控制台 | `Server`、`Deps` |
| `cmd/bot` | 组装、事件循环、`host.*` 实现 | — |
| `tools/qixinpack` | `.anzu` 打包与签名 | — |
| `tools/mock-onebot` | 假协议端 | — |

**依赖方向是单向的**：`webui → plugin → registry/perm → session → onebot`。没有反向依赖，所以每个包都能单独测。

---

## 3. 数据流

### 3.1 收到一条消息

```
协议端 WS
  │  {post_type:"message", message:[...]}
  ▼
onebot.Client.readLoop
  │  丢弃 message_sent；解析成 Event
  ▼
events chan
  │
  ▼
consume()                        ← cmd/bot/main.go
  │  去重（account + message_id）
  │  构造 Session（去前缀、算 mentioned）
  ▼
handleBuiltin()                  ← /help、/status
  │  命中就回复并结束
  ▼
Manager.Dispatch()
  │  没人接且带前缀 → 拼写建议（/hlep → /help），不落到 AI 插件
  │  按插件加载顺序遍历
  │  每个插件：allow() 判权限 → host.Call("plugin.handle_message")
  ▼
插件进程
  │  host.reply → 反向 RPC
  ▼
Queue.Send()                     ← 同会话串行 + 300ms 间隔
  │
  ▼
onebot.Client.Call("send_group_msg")
  │
  ▼
协议端 WS
```

### 3.2 收一条通知（进群、撤回等）

```
readLoop → Event(post_type=notice)
  ▼
Manager.DispatchEvent()
  │  广播给所有插件（不复用消息路由）
  ▼
plugin.handle_event
```

### 3.3 插件调工具

```
插件 A: host.call_capability {name:"weather_query", args}
  ▼
hostCallHandler → Manager.CallTool
  │  找到声明了这个工具的插件 B
  │  带 session 时按 B 的权限判定
  ▼
插件 B: plugin.call_tool
  ▼
返回 {ok, data, error}
```

---

## 3.5 消息入口与并发模型

### 之前的问题

最早的 `consume` 是"收一条、处理一条"：

```
OneBot ──► consume ──► Dispatch（阻塞等插件）──► 下一条
```

**一个群的插件慢，所有群排队**。更糟的是 `host.ask`：
插件等用户回复，而回复要靠 `consume` 读——**`consume` 正卡在那条消息上，互相等死**。

### 现在的结构

```
OneBot ──► consume（只收和投递，微秒级）
              │
              ├─ ① 先查 ask：等回答中的消息**不进队列**，直接投给等待者
              │
              └─ ② 按会话投递
                     ├─ 群A worker ──► handleOne ──► Dispatch
                     ├─ 群B worker ──► handleOne ──► Dispatch
                     └─ 群C worker ──► handleOne ──► Dispatch
```

**三条规则**：

1. **入口不处理业务**——`consume` 只做过滤和投递，永远不阻塞
2. **同一会话单 worker**——保证同一群的消息顺序
3. **不同会话并行**——一个群慢不拖累别的群

### 插件进程的资源生命周期

**三层回收**，缺一层就会留孤儿或卡死：

| 层 | 做什么 | 不做的后果 |
|---|---|---|
| **进程树** | 停插件时 `killTree`（Windows `taskkill /T`、Unix 进程组） | 插件起的 sidecar / worker 变孤儿 |
| **宿主请求** | 停用时 `closing` 置位拒绝新请求、`hostReqWG.Wait()` 等旧的结束 | 请求 goroutine 泄漏 |
| **请求上下文** | `h.Done()` 关闭时 `cancel()` 正在跑的请求 | `host.ask` 干等到 30 分钟兜底 |

**并发上限**：每个插件同时最多 **32** 个宿主请求。
超了**立刻拒绝**（返回 `CodeRateLimited`），不排队——
排队的请求会让插件以为"发出去了"，实际卡在队列里更糟。

**名额在起 goroutine 之前拿**：先 `go` 再在 goroutine 里抢名额的话，
突发请求仍会创建大量 goroutine（虽然它们立刻退出），调度开销已经发生。

**退出状态只有一处等**：`killProcessTree` 只发信号，
`cmd.Wait()` 由 spawn 时的 goroutine 统一收——两处同时等同一个子进程会拿到错误状态。

**发送队列的键含账号**：`account|chatType:chatID`。
只用 `chatType:chatID` 的话，同一个群号在不同账号下会共用 worker，
后发的消息会走先创建 worker 那个账号的 client。

**超时后不再发送**：`job` 带调用方的 `ctx`，worker 在**发送前**检查。

```
调用方超时 → 任务还在队列 → worker 取到它 → 检查 ctx → 已取消 → 跳过
```

**已经开始发送的不中断**：发送是原子的，半路放弃会留下不确定状态。
所以只在"发送前"检查，不提供"发送中途取消"。

**投递和回收必须互斥**：

```
worker:  锁内检查"队列空" → 锁内从 map 摘除 → 退出
投递:    锁内取 worker（没有就新建）→ 锁内投递
```

不互斥的话：worker 判定空、准备退出，投递方拿到旧 worker 把消息塞进去——
**没人读了，入站消息悄悄卡住，出站发送等到超时**。

**锁内不阻塞**：投递用 `select default`，满了立刻返回错误（发送）或丢弃（入站），
不会持锁等待。

**会话资源会空闲回收**：

| 资源 | 空闲多久回收 |
|---|---|
| 消息 worker（`sessionPool`） | 10 分钟 |
| 发送 worker（`send.Queue`） | 10 分钟 |

群少时看不出差别；私聊用户多、跑几周时，不回收会让 goroutine 数一直涨到几千。

**为什么是 32**：`host.ask` 会长时间占一个名额，
多群同时交互时一两个群就能占掉几个；32 能撑住常见规模，
又不会让 goroutine 无限涨。

### 插件侧的读取循环也要并发

上面说的是"宿主收消息"这一侧。**插件发请求**那一侧也有同样的坑：

```
插件 stdout ──► readLoop ──► handleLine
                              ├─ 是响应 → 投递（快）
                              └─ 是请求 → handleHostRequest（可能很慢）
```

`host.ask` 会在 `handleHostRequest` 里等用户回复（可能几十秒）。
**如果同步执行，readLoop 就卡住了**：

- 同一个插件的**其他响应**读不到 → 所有 `h.Call` 超时
- `concurrency = "session"` 时，**一个群在等，其他群的调用全挂**

**修法**：宿主请求**并发处理**：

```go
go func() {
    defer h.hostReqWG.Done()
    h.handleHostRequest(&req)
}()
```

**回包顺序怎么保证**：`h.write` 有 `writeMu`，JSON-RPC 靠 `id` 配对，
所以乱序回包不影响正确性。

**关闭时**：`hostReqWG.Wait()` 等所有请求处理完再关管道。

### 为什么 ask 要在入口拦截

如果只在 `Dispatch` 里查 ask：

```
群A 队列: [ /bind（正在等回答）, 小明（回答） ]
                          ↑ 等它           ↑ 排在它后面
```

`/bind` 占着 worker 等回答，回答排在队列里出不来 → **超时**。

**入口先查**：

```
consume 收到"小明"
  → TryAnswer 命中等待者 → 直接投递 → /bind 拿到答案继续
  → 不进队列
```

### 队列上限和丢弃

**每个会话一个 64 条的缓冲队列**。满了就丢，记一条 warn 日志。

**为什么不无限排队**：一个群刷屏时，无限排队会把内存吃光，最后整个进程 OOM。
**丢消息比崩掉好**——至少别的群还能用。

丢的消息会打日志：`会话队列已满，丢弃消息 key=main|group:123 user=456`。

### 和插件并发配置的关系

| 层 | 控制什么 |
|---|---|
| **会话池**（宿主） | 同一群串行、不同群并行 |
| **`concurrency`**（插件） | 同一插件的多个群能不能同时跑 |

**两层是独立的**：

- 会话池保证"群A 和群B 的消息可以同时被处理"
- 插件的 `concurrency = "session"` 保证"群A 和群B 可以同时进这个插件"

**默认 `concurrency = "plugin"` 时**：会话池让它们并行到达，但插件锁让它们排队。
所以**要真正并行，两层都得放开**。

### 监控

现在能看到的：

| 指标 | 在哪 |
|---|---|
| 队列积压 | 日志里的"会话队列已满" |
| 单条耗时 | 插件统计的平均耗时 |
| 超时 | 插件统计的 Timeouts |
| 活跃会话数 | `sessionPool.Stats()` |

**还没有的**：实时的队列长度面板、QPS 曲线。要上高负载需要补。

---

## 3.6 日志级别：文件按配置、缓冲记全部

**内存统计要含子进程**：插件默认一个插件一个进程，`SelfRSS` 只是框架本体；
概览卡片必须把子进程 RSS 加起来，否则会显示"只占 0.1 GB"这种假象。
插件页另有每插件单独的内存列（共享宿主插件按组计，不单列）。

**登录态落盘**：会话存在内存 + `data/sessions.json`，重启机器人不用重新登录
（cookie 有效期 7 天）。写盘时先解锁再做，避免重复加锁死锁。

**定时任务（开发线）**：调度表属于 Manager，cron 支持 `{{设置key}}` 模板，
设置保存后自动重排；停机错过的 cron（24h 内）启动时补跑。
**发行版不注册 `[[schedule]]`**，定时由插件进程内的 `setInterval` / `setTimeout` 自己管。

**休眠（开发线）**：`idle_stop` 声明的插件空闲后**只停进程**，
保留 metas/order/**capability 提供者注册**——否则能力调用找不到提供者，
也就没法靠能力唤醒。只有 disable/remove 才移除注册。

回收前会再确认一次：仍然空闲、**没有在途调用**（beginCall 计数）、不在回收中；
回收和唤醒共用同一个 stopping 标记，唤醒会等回收完成。
开发线里定时任务在回收期间照常到点，`run_task` 与消息共用 per-plugin 锁。

**统一调用入口**：所有入口（消息、能力、事件、工具、定时、手动任务）都走
`acquireHost`：`确保运行 → 取得在途计数 → 再取一次当前 Host`。
等回收期间旧 Host 可能已被替换，各入口自己取句柄会踩空。

**回收与重载串行**：回收在 `reloadMu` 内重新确认"还是同一个 Host 实例 + 仍然空闲 + 无在途"，
才真正停；人工 Reload/Enable 刚拉起的新进程不会被旧回收流程停掉。

**事件按订阅分发**：`handle_event` 只发给 `events` 里声明了匹配类型的插件，
不再唤醒全部插件——一条通知事件不该把睡眠中的插件集体叫醒。

**唤醒入口**（开发线；睡着后能被这些叫醒）：

| 入口 | 是否唤醒 |
|---|---|
| 命令（匹配 manifest） | ✅（但纯命令插件默认不允许休眠） |
| 能力调用 | ✅（保留提供者注册） |
| 工具列表 / 调工具 | ✅（toolOwner 会先唤醒） |
| 事件广播 | ✅（事件很少，逐个唤醒） |
| 手动 RunTask | ✅ |
| 定时任务 | ✅（开发线框架调度） |
| 消息观察 `observe` | ❌ **不允许休眠**（它会漏消息） |

**in-flight 计数**：只包在真正的 `host.Call` 外面；
schema 校验失败、限流排队失败这些提前返回不算在途，不会把计数泄漏成永不回收。
回收中的插件，消息路径用 `beginCallCtx` 等回收完成再重试同一条消息。

disable/remove 会取消调度循环，enable 时重新注册。

**定时任务归框架（开发线）**：调度表在 Manager 上，不依赖插件进程；插件睡着时任务照常到点，
先 `ensureRunning`（重试 3 次）再执行。唤醒失败会记 ERROR 和任务 last_err。

**Feature 注册要幂等**：插件启动前先 `RemoveByPlugin`，清掉崩溃重启
留下的旧注册——否则第二次注册会报「feature 冲突」，插件永远起不来。

**分发结束后广播给观察者**：声明 `observe = true` 的插件（记忆/统计）
会收到 `plugin.observe_message`，**不管消息被谁认领、有没有认领**。

为什么需要：AI 聊天是 `last = true` 的兜底插件，被 `keyword-reply` 抢走的
消息它收不到——记忆会漏。观察者是旁路：异步、失败无视、不影响回复。

**带前缀的消息只走命令路由**：

```
有前缀？
  ├─ 是 → 只问"声明了这条命令"的插件
  │        ├─ 匹配 → 权限/冷却不过 → 回提示 → 结束
  │        ├─ 匹配 → 正常处理
  │        └─ 谁都没匹配 → **静默**（不回"没有这个命令"，也不给 AI）
  └─ 否 → 正常分发（命令、关键词、AI 都能接）
```

为什么这样：`/今天天气` 被 AI 接掉的话，用户会以为真有这个命令。
带前缀 = 明确在调功能，框架就该按命令路由；找不到就闭嘴，让他自己发 `/help`。

判据是 `matchesDeclaredCommand`（只看 manifest 声明，不看插件内部逻辑）。
不这样的话，`/bili` 被权限拒之后还会漏给 AI 聊天，用户收到两条打架的回复。

**内置命令（`/help`、`/plugins`）在插件之前执行**：

```
收到消息 → 内置命令？→ 是则处理完返回
                    → 否 → Dispatch（按权限/冷却/优先级依次问插件）
```

所以插件**不能**用 `help` / `plugins` 当命令名——那条命令永远轮不到它。
启动时会检查撞名并打警告（`warnBuiltinCollisions`），但不阻止加载。

控制台注入（`/api/chat/inject`）**也走内置命令**，
否则测试和真实链路不一致：真实消息被内置吃掉，注入却直达插件。

**排查消息走向的两条日志**（都在 INFO 级，文件里能看到）：

```
收到消息        scope="group 123" user=10001 text="/天气 北京"
消息已交给插件   plugin=weather scope="group 123" user=10001 ms=42
```

只有前者、没有后者 = 没有插件认领（命令不匹配、权限、或被冷却拦下）。
原来"谁处理的"是 DEBUG 级，info 级别的日志里根本看不到。

**两个输出目标，两种需求**：

| 目标 | 级别 |
|---|---|
| **文件**（`data/bot.log`） | 按 `config.toml` 的 `[log] level` |
| **内存缓冲**（控制台日志页） | **所有级别**（包括 debug） |

**为什么缓冲要记全部**：排查问题时控制台要能看到 debug，
但生产环境不想让文件被 debug 撑爆。

**实现**：`logbuf.Wrap` 的 `Enabled` 永远返回 true（缓冲照单全收），
但 `Handle` 转发给内层前**检查 `next.Enabled`**：

```go
if !h.next.Enabled(ctx, r.Level) {
    return nil        // 文件不要这条
}
return h.next.Handle(ctx, r)
```

**曾经的 bug**：`Handle` 直接调 `next.Handle`，绕过内层过滤，
导致 `level = "info"` 时 debug 照样写进文件。

## 4. 启动顺序

`cmd/bot/main.go`：

```
1. 读配置、建 logger + 日志缓冲
2. 建协议端客户端（每个 account 一个）
3. 建权限判定器、注册表、发送队列
4. 建 override 存储（data/overrides.json）
5. Installer.Sync()
      plugins/*.anzu → 校验签名 → 解压到 data/plugins/<id>/
      没有对应包的运行目录 → 改名到 .removed-*
6. 建 Manager，注入 SDK 目录、包目录、override
7. 新装的插件全部标记为「未启用」
8. Manager.Load() → 逐个启动已启用的插件
9. 启动热重载（如果配置开了）

**覆盖升级前必须先停进程**（Windows）：插件进程占着运行目录，
直接 rename 会失败（`The process cannot access the file`）。
`Installer.BeforeUpgrade` 钩子在换目录前调 `Manager.StopForUpgrade`，
解压完再重新加载——不停的话新包根本装不上，而且**不会报错给用户**，
只在日志里留一条"安装失败"。

**插件安装的所有入口都走同一个校验**：

```
投放区 *.anzu  → Installer.Sync → 验签 → 解压 → install.json
控制台上传     → 写进投放区   → Installer.Sync（同上）
```

之前上传是**直接解压到运行区**的，两边逻辑分叉：
既不验签（谁都能传包），包也没落进投放区（重启就被当孤儿移走）。

**可信公钥三个来源合并**（顺序即优先级）：

| 来源 | 存在哪 | 谁能改 | 为什么要有这层 |
|---|---|---|---|
| **官方** | 编译进二进制（`official_keys.go`） | 换框架版本 | 装官方插件零配置；新增官方插件不用用户改东西 |
| 部署者 | `config.toml` 的 `[plugin] trusted_keys` | 改文件 + 重启 | 统一固定一份信任（比如公司内部只信任自家密钥） |
| 热加 | `data/trusted-keys.json` | 控制台，**立刻生效** | 临时装个第三方插件，贴公钥就行 |

`Installer.SetTrustedKeys` 加读写锁，改完立刻对新安装生效，不用重启。

**官方公钥不能被移除**（`TrustStore.Remove` 会拒绝）：
它是"官方"这个背书的根，允许删就等于允许伪装成官方。

**发布纪律**：`tools/package.ps1 -Key` 会逐个校验官方仓库里每个 `.anzu`
的签发者指纹；只要有一个不是官方密钥签的，打包直接失败。
这样用户装官方仓库任何插件都不需要额外配置。

**热重载只盯代码和清单**：`dirSignature` 只把 `.js/.mjs/.cjs/.ts/.py/.json/.toml/.yaml/.yml`
的**路径 + mtime**计入指纹，并且**跳过 `data/`、`node_modules/`、`_sdk/`、`web/`、`dist/`、`.git/`**。

为什么不跳 `data/` 会出事：插件每次写运行状态（定时任务存进度、缓存）
都会让指纹变，触发一次无谓的**重载**——15 秒轮询的插件就会每 15 秒
被杀一次、再起一次，日志里刷屏、状态反复丢。
（线上 `ts3-tracker` 就这么每 15 秒重载过。）
10. 启动控制台
11. 每个 account 起两条 goroutine：客户端连接循环 + 事件消费
12. 等信号，收到后停插件、断连接、关控制台
```

第 7 步是关键：**装包和信任包是两件事**。

---

## 5. 运行时目录

```
qqbot/
├── config.toml
├── plugins/                    投放区：只放 .anzu
├── sdk/node/qixin.mjs          插件适配器（框架复制进每个插件）
├── data/
│   ├── plugins/<id>/           运行区
│   │   ├── app/                本体
│   │   ├── deps/               依赖
│   │   ├── data/               运行时数据（升级保留）
│   │   ├── web/                扩展片段
│   │   ├── _sdk/               框架注入的适配器
│   │   ├── manifest.toml
│   │   └── install.json        安装元信息
│   ├── plugins-state.json      启用/禁用
│   ├── overrides.json          权限与 /help 覆盖
│   ├── audit/                  审计日志（按天 JSONL）
│   └── logs
└── bin/
```

---

## 6. 关键设计决策

| 决策 | 理由 |
|---|---|
| **插件跑独立进程** | 依赖各带各的（`node_modules`/`venv`）、崩溃隔离、热重载=重启进程、不挑语言 |
| **stdio + NDJSON** | 语言无关、零网络配置、能直接 `cat` 调试；比 MCP 简单，比 HTTP 轻 |
| **能力按名字找，不按插件找** | 核心声明"我要 `weather_query`"，不 import 具体插件 |
| **一个插件一套权限** | 权限是跨插件的一致性问题；命令级留作高级覆盖 |
| **设置页由框架渲染** | 20 个插件不该有 20 套表单；插件只提供 schema 和可选片段 |
| **`.anzu` 只读投放** | 包不可变，运行区可重建；卸载=删目录，备份=打包目录 |
| **新包默认未启用** | 安装 ≠ 信任，管理员看一遍再开 |

---

### 进程故障与重启语义

- 主动停止（禁用/重载/休眠回收）：`closing=true`，supervise 不重启
- 故障退出（写 stdin 超时、崩溃）：`closing=true` + `faulted=true`，supervise 自动重启
- 连续崩溃 6 次会禁用插件；但如果进程已稳定运行 ≥10 分钟，计数清零（"连续"语义）
- 连续 5 次消息超时也会自动禁用——防"不崩也不回"的挂死插件拖慢整个分发循环
- `Kill()` 等待宿主请求最多 5 秒，避免持有生命周期锁时被宿主请求反等死锁

### 插件调工具的可信会话

分发消息时框架生成一次性 `call_token` 放进 session；插件调 `host.call_tool`
带回来的 token 只能换回**它自己那次分发**的会话。伪造 session、串用别的群都不行；
定时任务等无会话场景按"无会话"处理：受限工具直接拒绝。

### 调度器时间槽认领

定时器触发前先认领该时间槽；唤醒过程中 `startSchedules` 的补跑判断看到同槽已认领就跳过，
所以"到点唤醒"不会因为补跑跑两次。补跑本身还有 catchup 表防重载并发重复排入。

### 运行区监视器

按下发目录签名对比；扫描失败跳过本轮（不是"全删了"）；目录缺失需连续两轮确认；
启动失败时不拿空快照当基线，避免首轮把所有插件当新插件重载。

## 7. 扩展点

插件能插进框架的位置：

| 扩展点 | 触发者 | 声明方式 |
|---|---|---|
| 命令 | 用户发消息 | `[[commands]]` |
| 工具 | AI / 其他插件 / WebUI | `[[tools]]` |
| 事件 | 协议端通知 | `handle_event` |
| 设置 | 管理员 | `[[settings]]` |
| 设置页扩展 | 管理员 | `web/panel.html` 片段 / `web/index.html` 整页 |
| 主动发送 | 插件自己 | `host.sendMessage` |
| 外部命令 | 插件自己 | 继承环境变量 + `[plugin] env` 注入 |
| 周期任务 | 插件自己（发行版）/ 宿主（开发线） | `setInterval`；开发线 `[[schedule]]` + `run_task` |

**加新功能优先用这些扩展点**。如果某个需求无法表达，应该补框架的扩展点（比如新增事件类型、新增 host 方法），而不是在插件里绕过。

---

## 8. 并发模型

| 位置 | 规则 |
|---|---|
| 每个账号 | 1 条连接 goroutine + 1 条消费 goroutine |
| 消息分发 | 单 goroutine 串行，按 priority → last → id 排序 |
| 单个插件 | 业务调用互斥（`callMu`），`ping`/`shutdown` 不排队 |
| 发送 | 每个 (账号, 会话) 一个 worker，全局按间隔限频 |
| 插件内部 | 插件自己负责；宿主不保证并发安全 |

所以插件收到 `handle_message` 时是安全的单线程上下文，不用加锁。

---

## 9. 故障处理

| 故障 | 行为 |
|---|---|
| 协议端断开 | 指数退避重连，最长 60s |
| 插件握手超时 | 标记 failed，UI 显示原因 |
| 插件进程崩溃 | 退避重启（1/2/4/8/16s），连续 6 次失败则禁用 |
| 插件 handler 抛错 | 记日志，继续下一个插件 |
| 插件 handler 超时 | 放弃等待，记日志，不杀进程 |
| 发送失败 | 记日志，返回错误给插件 |
| 配置损坏 | 启动失败并提示，不静默用默认值 |
| 签名校验失败 | 拒绝安装 |

---

## 9.5 WebUI 页面

`internal/webui/` 八个页面，都走同一套模板（`render`），共享导航栏。

| 页面 | 数据来源 | 说明 |
|---|---|---|
| `/overview` | `Manager.List()` + `plugin.DetectAllRuntimes()` | 运行时环境、服务插件、普通插件、最近错误 |
| `/connect` | `cfg.Accounts` | 改连接配置（重启生效） |
| `/permissions` | `Manifests()` + `override.Store` | 只有**有命令**的插件才列出 |
| `/plugins` | `Manager.List()` + `Override.Priority()` | 启停/删除/优先级 |
| `/help-settings` | `override.Store` | 控制 /help 显示 |
| `/logs` | `logbuf` 环形缓冲 | 最近 1000 条 |
| `/audit` | `audit` JSONL | 按天分文件 |
| `/chat` | `chatbuf` | 消息流 + 发消息 + 图片代理 |

### 概览页的三个区块

**① 运行时环境**

调 `plugin.DetectAllRuntimes()`，逐个试跑 `node --version` / `python --version`。

**关键点**：`exec.LookPath` 成功不等于能跑——Windows 应用商店的
`WindowsApps\python.exe` 是个 App 执行别名，文件在、`where` 能查到，
但执行返回 9009。所以检测逻辑里对有 `--version` 的解释器要求**必须跑出版本号**，
跑不出就判为不可用。

**② 服务插件**

`Manifest.Kind == "service"` 的插件单独一块，显示 `CapabilitiesOf(id)`。
它们不接消息，分发时被跳过。

**③ 普通插件**

`Kind != "service"` 的，显示状态、PID、命令数。

## 10. 文档地图

| 文档 | 内容 | 什么时候改 |
|---|---|---|
| `ARCHITECTURE.md` | 本文：模块、数据流、启动 | 加模块、改流程、改目录 |
| `API.md` | 接口全集：`plugin.*`、`host.*`、HTTP | 加/改任何接口 |
| `PLUGIN.md` | 插件规范：清单、设置页、权限 | 改插件能做什么 |
| `ANZU.md` | 包格式、签名、目录 | 改包结构 |
| `PROTOCOL.md` | 协议细节：帧、时序、错误码 | 改传输或时序 |
| `SNOWLUMA.md` | 协议端对接 | 换协议端或加适配 |
| `DEPLOY.md` | 部署与运维 | 改部署方式 |
| `REQUIREMENTS.md` | 需求与里程碑 | 需求变化 |
