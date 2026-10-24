# 插件设计规范

- 版本：2.0（对应 `.anzu` 包格式）
- 日期：2026-10-24
- 关联：[ANZU.md](./ANZU.md)（包格式与签名）、[PROTOCOL.md](./PROTOCOL.md)

---

## 0. 快速开始

```powershell
# 1. 生成骨架
.\bin\qixinpack.exe new my-plugin -name 我的插件 -dir dist

# 2. 改 manifest.toml 和 app/index.js

# 3. 打包
.\bin\qixinpack.exe pack dist\my-plugin -out plugins\my-plugin.anzu

# 4. 热重载会自动装好，去 WebUI「插件」页启用
```

生成的骨架：

```
my-plugin/
├── manifest.toml     # 常用字段都写了注释，用不到的注释掉就行
├── app/index.js      # 最小可运行：initialize / set_settings / handle_message / run_task
├── web/panel.html    # 可选扩展片段，不用可以删
└── README.md         # 插件自己的说明
```

**改完直接打包，热重载会自动重装并重启插件**——不用手动停启。

**写 `data/` 不会触发重载**：框架的目录指纹只算代码和清单文件
（`.js/.mjs/.ts/.py/.json/.toml` 等），并跳过 `data/`。
所以定时任务往 `data/` 存进度、写缓存，不会把插件自己重启掉。

**反过来**：别把需要持久的东西塞进 `app/`——那里一改就会重载。

---

## 0.1 开发流程：一条命令跑起来

### 三步

```powershell
# 1. 建骨架
.\bin\qixinpack.exe new my-plugin -name 我的插件

# 2. 写代码（app/index.js）

# 3. 起本地环境
cd my-plugin
..\bin\qixinpack.exe dev .
```

**`dev` 生成的临时配置里有两个开发专用开关**：

```toml
[plugin]
auto_enable = true    # 新装插件自动启用（生产默认 false）
sdk_dir = "<框架根>/sdk/node"   # 否则临时目录里找不到 _sdk
```

**`dev` 会自动做完这些**：

| 步骤 | 做了什么 |
|---|---|
| 1 | 把你的插件打成 `.anzu` 放进临时工作区 |
| 2 | 起一个假的 OneBot 协议端（`mock-onebot`） |
| 3 | 生成临时 `config.toml`（指向假协议端，管理员 `admin` / `dev`） |
| 4 | 起框架 |
| 5 | 等控制台就绪，打印地址 |

**输出**：

```
==> 打包 echo
输出: .dev-xxx/plugins/echo.anzu (1.2 KB)

==> 启动假协议端 :3001
mock OneBot 监听 127.0.0.1:3001（self=10000 group=123456）

==> 启动框架，控制台 http://127.0.0.1:7801 （admin / dev）

✅ 就绪
   控制台   http://127.0.0.1:7801  (admin / dev)
   虚拟群   控制台 → 聊天 → 🧪 虚拟群 → 发消息测插件
   插件包   .dev-xxx/plugins/echo.anzu

   Ctrl+C 退出
```

### 改完代码怎么办

**开 `-watch`，保存即生效**：

```powershell
qixinpack dev . -watch
```

```
[watch] 监听源码变动：dist\echo（保存即重载）

# 你改了 app/index.js 并保存
[watch] 检测到改动，重新打包…
输出: .dev-xxx/plugins/echo.anzu (1.2 KB, 2 个条目)
  [watch] 已重载，去虚拟群试试
```

**它监听什么**：`.js` `.mjs` `.cjs` `.ts` `.py` `.toml` `.json` `.html` 和 `manifest.toml`。

**跳过什么**：`data/` `deps/` `_sdk/` `node_modules/` `.git/`（这些变了不用重打包）。

**反馈时间**：保存 → 1 秒内重打包 → 自动重载 → 虚拟群直接测。

不开 `-watch` 的话，**Ctrl+C 重跑 `qixinpack dev .`** 也行，就是多等十几秒。

### 选项

```powershell
qixinpack dev . -web 7801 -ws 3001 -keep
```

| 选项 | 说明 |
|---|---|
| `-web <端口>` | 控制台端口，默认 7801（被占用时改这个） |
| `-ws <端口>` | 假协议端端口，默认 3001 |
| `-watch` | 监听源码变动，保存后自动重打包并重载 |
| `-keep` | 退出后保留临时目录（排查用） |

### 完整的工具命令

```powershell
qixinpack new my-plugin -name 我的插件      # 生成骨架（app/ + manifest.toml）
qixinpack dev .                            # 起开发环境
qixinpack dev . -watch                     # 起环境 + 改代码自动重载
qixinpack test .                           # 按 manifest 跑一遍命令
qixinpack verify -ask                      # 端到端验证（真实 WebSocket）
qixinpack pack . -out plugins/my.anzu      # 打包
qixinpack pack . -out plugins/my.anzu -key my.priv   # 打包并签名
qixinpack check plugins/my.anzu -pub my.pub          # 校验签名
qixinpack keygen -out my                   # 生成密钥对（my.priv / my.pub）
```

**`new` 生成的骨架**：

```
my-plugin/
├── manifest.toml      # 带一条示例命令和一个示例设置
└── app/
    └── index.js       # 最小 echo 实现，直接能跑
```

**改完直接 `qixinpack dev .` 就能看到效果**——不用先理解所有字段。

### `qixinpack test`：自动跑一遍

```powershell
qixinpack test .
```

起临时环境，按 manifest 里声明的 `usage` 逐条发消息，检查插件有没有正确认领。

**输出**：

```
==> 测试插件 echo
输出: echo.anzu (1.2 KB, 2 个条目)

===== 测试结果 =====
✅ 命令 echo <文本>
   发送: "/echo 示例"（身份 owner）
   认领: echo
   回复1: 示例 / （你已 echo 1 次）

✅ 命令 ping
   发送: "/ping"
   认领: echo
   回复1: pong

✅ 无意义文本         认领: 无
✅ 空消息             认领: 无

===== 4 通过 / 0 失败 =====
```

**它测什么**：

| 场景 | 期望 |
|---|---|
| 每条 `usage` 生成的消息 | 插件认领 |
| 无意义文本 | 插件不认领（不抢消息） |
| 空消息 | 插件不认领 |

**它不测什么**：业务逻辑对不对、回复内容好不好。
那些得靠虚拟群手动验，或者给插件自己写单元测试。

**放进 CI**：

```yaml
- name: 插件自测
  run: qixinpack test dist/my-plugin
```

失败时退出码非 0，能直接卡住流水线。

**选项**：`-web` / `-ws` 换端口（默认 7811 / 3011），`-keep` 保留临时目录。

---

### `qixinpack verify`：走真实 WebSocket 的端到端验证

`dev` 和 `test` 用控制台注入，**测不出"时序"问题**。
`verify` 起真实协议端，能验证那些只有真链路才暴露的 bug。

```powershell
qixinpack verify -ask          # ask 等待时会不会堵住别的群
qixinpack verify -concurrency  # 两个群同时调同一个插件
qixinpack verify               # 全跑
```

**输出**：

```
==> 端到端验证（走真实 WebSocket）

[ask 等待时不堵其它群]
  ✅ 群 B 在 51ms 内响应，没有被 ask 堵住

===== 1 通过 / 0 失败 =====
```

**`-ask` 验的是什么**：

1. 群 A 发 `/bind`，插件进入 `host.ask` 等待
2. **群 B** 立刻发 `/vping`
3. 断言：群 B 在 3 秒内被处理

**失败说明什么**：插件读取循环被 `handleHostRequest` 卡住了——
`host.ask` 等待期间，同一个插件的其它调用全都超时。

**它的局限**：现在只覆盖两个场景（ask 非阻塞、多群响应）。
真正的压力测试（QPS、队列积压）还得靠线上监控。

### `dev` 环境里的权限

`config.toml` 是自动生成的，主人是 `10001`：

```toml
[owner]
users = [10001]
```

所以**虚拟群里选「主人」身份能触发所有插件**，选「纯路人」会被白名单拦。

### 和真实环境的区别

| | `qixinpack dev` | 生产 |
|---|---|---|
| 协议端 | `mock-onebot`（假的） | SnowLuma 等 |
| QQ | 没有真实连接 | 真实 |
| 数据 | 临时目录，退出即删 | `data/` |
| 控制台密码 | `admin` / `dev` | 自己配 |

**测完的东西不能直接当生产用**——临时目录会删，配置也是假的。

### 只想跑一次命令看效果

不用进 WebUI，直接让假协议端推一条：

```powershell
# 终端 1
.\bin\mock-onebot.exe -addr 127.0.0.1:3001 -text "/echo 你好"

# 终端 2
.\bin\qixinbot.exe -config dev.toml
```

`mock-onebot` 的参数：

```powershell
-addr     监听地址（默认 127.0.0.1:3001）
-self     机器人 QQ（默认 10000）
-group    群号（默认 123456）
-user     发送者 QQ（默认 20000）
-text     推送的消息文本
-interval 重复推送间隔（0 = 只推一次）
```

---

## 1. 一个插件是什么

一个 `.anzu` 包 + 一份 `manifest.toml` + 一组约定。

### 包里的目录（就这五个，别加别的）

```
weather.anzu
├── manifest.toml      声明：id、版本、命令、工具、设置、权限
├── app/               代码（index.js / 二进制）
├── assets/            素材（图片、音频、视频、字体、模板…）
├── deps/              依赖（统一目录，见下）
├── web/               设置页（可选，独立的 panel.html）
└── META-INF/          签名（可选，打包工具生成）
```

**`assets/` 内部再分子目录**：

```
assets/
├── img/               图片（标准，不用声明）
├── audio/             音频（标准）
├── video/             视频（标准）
├── fonts/             字体（标准，canvas 会自动注册）
└── 自定义/            别的子目录要在 manifest 里声明（见 §6.12）
```

### 解压后的运行区

```
data/plugins/weather/
├── app/               代码
├── assets/            素材
├── deps/              依赖
├── web/               设置页
├── data/              运行时数据（升级不动）
├── _sdk/              框架注入的适配器
├── install.json       安装元信息
└── manifest.toml
```

### 各目录的职责（不能混）

| 目录 | 谁写 | 升级时 | 备份 |
|---|---|---|---|
| `app/` | 打包者 | 整体替换 | 不必 |
| `assets/` | 打包者 | 整体替换 | 不必 |
| `deps/` | 打包者 | 整体替换 | 不必 |
| `web/` | 打包者 | 整体替换 | 不必 |
| `data/` | 插件自己 | **保留** | 必须 |

**记住一条**：只要你写的东西是「用户产生的」，就放 `data/`；是「你带进去的」，放前四个。

### `deps/` 怎么组织（Node / Python 通用）

```
deps/
├── node_modules/      Node 包（npm install 到这里）
├── python/            Python 包（pip install -t 到这里）
├── bin/               可执行文件（自动加进 PATH 末尾）
└── vendor/            内联的第三方源码（自己 import）
```

框架启动插件时自动注入：

| 目录 | 环境变量 |
|---|---|
| `deps/node_modules` | `NODE_PATH` |
| `deps/python` | `PYTHONPATH` |
| `deps/bin` | `PATH` 末尾 |

**所以 Node 和 Python 用同一套目录约定**，只是子目录不同。

```bash
# Node
npm install --omit=dev --prefix deps/node_modules <包名>

# Python
pip install -t deps/python <包名>
```

---

## 2. manifest.toml

### 2.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 与包名一致，`^[a-z][a-z0-9_-]{1,40}$` |
| `name` | string | 建议 | 显示名 |
| `version` | string | 建议 | 语义化版本 |
| `apiVersion` | string | 建议 | 固定 `"1.x"` |
| `exec` | string[] | ✅ | 启动命令，路径相对运行区根 |
| `web` | string | 否 | 设置页入口，相对运行区根 |
| `closed_source` | bool | 否 | 标记包里不含源码 |
| `description` | string | 建议 | 一句话说明 |
| `enabled` | bool | 否 | `false` 时永不启动 |
| `permissions` | string[] | 否 | `onebot.write` / `onebot.admin` / `onebot.dangerous` |
| `provides` | string[] | 否 | 提供的能力，格式 `名字@版本` |
| `uses` | string[] | 否 | 依赖的能力，缺了标 degraded |
| `priority` | int | 否 | 分发优先级，大的先收到消息（默认 0） |
| `capability_priority` | int | 否 | 作为能力提供者的优先级，不写时沿用 `priority` |
| `last` | bool | 否 | 兜底插件，永远排在普通插件之后 |

### 2.2 完整示例

```toml
id = "weather"
name = "天气"
version = "1.0.0"
apiVersion = "1.x"
exec = ["node", "app/index.js"]
web = "web/index.html"
description = "查询城市天气"
permissions = ["onebot.write"]

[[commands]]
id = "weather.query"
usage = "天气 <城市>"
description = "查询指定城市的天气"
aliases = ["weather"]

[[tools]]
name = "weather_query"
description = "查询城市当前天气。用户问天气、气温、下不下雨时调用。"
parameters = { type = "object", properties = { city = { type = "string" } }, required = ["city"] }

[[settings]]
key = "unit"
label = "温度单位"
type = "select"
options = ["celsius", "fahrenheit"]
default = "celsius"
```

---

## 3. 设置页

**统一由框架渲染，插件不写 HTML。**

框架根据 `[[settings]]` 生成表单，并自动附上插件所有指令的用法。所有插件的设置页长得一样：

```
插件名 · 说明 · 版本 · id
─────────────────────────
设置
  控件 1
  控件 2
  [保存]
─────────────────────────
指令
  用法                说明            可见性
  /weather <城市>     查询城市天气     所有人
  /admin reload       重载插件         管理员专属
─────────────────────────
扩展（可选，来自 web/panel.html）
─────────────────────────
工具（如果有）
  weather_query       查询城市天气
```

### 3.1 页面固定结构

| 区块 | 内容 | 来源 |
|---|---|---|
| 头部 | 名称、说明、版本、id | manifest |
| 设置 | 6 种控件 | `[[settings]]` |
| 指令 | 用法、说明、可见性 | `[[commands]]` |
| 扩展 | 自定义 HTML 片段 | `web/panel.html`（可选） |
| 工具 | 名称、说明 | `[[tools]]` |

**不要自己写整套页面**。需要额外交互（测试按钮、预览、图表）时，只写 `web/panel.html` 片段，框架会插到「扩展」区块。

### 3.2 指令列表是自动的

框架从 `[[commands]]` 生成指令表，**用法会自动加上命令前缀**（`/`），所以：

- manifest 里写 `usage = "weather <城市>"`，页面上显示 `/weather <城市>`
- 有 `allow_users` / `require_role` 的标「管理员专属」
- `hidden = true` 的标「不在 help 显示」

插件不需要维护另一份文档。

### 3.3 控件类型

| type | 渲染 | 存的值 |
|---|---|---|
| `string` | 文本框 | string |
| `password` | 密码框 | string（日志脱敏） |
| `number` | 数字框（支持 `min`/`max`） | float64 |
| `boolean` | 复选框 | bool |
| `select` | 下拉（必须有 `options`） | string |
| `path` | 文本框 | string |

```toml
[[settings]]
key = "count"
label = "数量"
type = "number"
min = 0
max = 100
default = 5
```

### 3.4 插件怎么拿配置

保存后框架会推给运行中的插件，不用重启：

```js
async initialize({ data_dir, settings }) {
  this.config = settings || {}       // 首次
  return { api_version: '1.0' }
}

async set_settings({ values }) {
  this.config = { ...this.config, ...values }   // 热更新
  return { ok: true }
}
```

### 3.5 扩展片段示例

`web/panel.html`（片段，不是完整 HTML）：

```html
<p class="muted">下面的按钮调框架的工具接口。</p>
<button type="button" onclick="call()">测试工具</button>
<pre id="out"></pre>
<script>
async function call() {
  const r = await fetch('/api/tools/call', {
    method: 'POST',
    body: new URLSearchParams({ name: 'weather_query', args: '{"city":"北京"}' }),
  })
  document.getElementById('out').textContent = JSON.stringify(await r.json(), null, 2)
}
</script>
```

---

## 4. 命令

### 4.00 三种触发方式，先选对

写插件第一件事不是写 `[[commands]]`，是决定**消息怎么进来**：

| 方式 | 适合什么 | 长什么样 | 代价 |
|---|---|---|---|
| **命令** | 用户主动发指令 | `/weather 北京`、`/home 开灯` | 用户要记命令名 |
| **关键词/正则** | 句式固定、触发频繁 | `吃什么`、`喝啥`、`统计` | 作者要维护正则或规则 |
| **AI 工具** | 参数任意、要理解语义 | 「把客厅灯关一下」「这周三有空吗」 | 依赖 LLM，慢 1-2 秒 |

**判断标准**：

```
句式能穷举吗？
├── 能，且第二个词是固定集合（status/check/preview）
│   → 命令（多拆几条 [[commands]]）
├── 能，但第二个词是自由文本（设备名、菜名）
│   → 命令 + 插件自己解析参数　或　AI 工具
└── 不能（自然语言、模糊表达）
    → AI 工具（[[tools]]）
```

**别做的事**：

- ❌ 用 `require_prefix = false` + 自己写一套自然语言解析，去接「把灯关了」
  → 正则永远覆盖不全，交给 AI
- ❌ 给每个可能的说法都写一条命令
  → 命令表爆炸，help 刷屏

### 4.000 门禁真值表（`require_prefix` / `require_mention`）

这两个开关的语义是「**下限**」不是「上限」：

- `require_prefix = true` → **至少**得带前缀
- `require_prefix = false` → 不设下限，**带不带都行**

| `require_prefix` | 输入 | `has_prefix` | 能触发 |
|---|---|---|---|
| `true` | `/home 开灯` | true | ✅ |
| `true` | `home 开灯` | false | ❌ |
| `false` | `/home 开灯` | true | ✅ |
| `false` | `home 开灯` | false | ✅ |

`require_mention` 同理：

| `require_mention` | 群里 @ 了 | 能触发 |
|---|---|---|
| `true` | ✅ | ✅ |
| `true` | ❌ | ❌ |
| `false` | ✅ | ✅ |
| `false` | ❌ | ✅ |

**两个都 `false` 时四种组合全通**：

| 输入 | 带前缀 | @了 | 触发 |
|---|---|---|---|
| `开灯` | ✗ | ✗ | ✅ |
| `/开灯` | ✓ | ✗ | ✅ |
| `@机器人 开灯` | ✗ | ✓ | ✅ |
| `@机器人 /开灯` | ✓ | ✓ | ✅ |

**注意**：`require_prefix = false` 的插件，**每条消息都会经过它**的
`handle_message`。所以必须：

1. 开头快速判断，不匹配就立刻 `return { handled: false }`
2. 别在里面做网络请求、读大文件

否则会拖慢整条分发链。

| 字段 | 说明 |
|---|---|
| `id` | **必填**，Feature ID，形如 `weather.query` |
| `usage` | 必填，**第一个词就是触发词；不要写 `/`**，前缀由框架统一加 |
| `description` | 一句话 |
| `hidden` | 不进 `/help` |
| — | **别和内置命令撞名**：`/help`、`/plugins` 是框架处理的，插件同名命令永远不会触发 |
| `aliases` | 别名 |
| `allow_users` / `allow_groups` / `require_role` | 权限默认值（可被 WebUI 覆盖） |

匹配规则：`usage` 第一个词（去掉 `/`）与 `session.text` 前缀匹配；`session.text` **已经去过前缀**。

---

### 4.0 子命令怎么声明

两种命令，声明方式不同，**别混**：

**① 固定子命令** → 每个子命令一条 `[[commands]]`

```toml
[[commands]]
id = "bili.status"
usage = "bili"
description = "查看订阅概览"

[[commands]]
id = "bili.check"
usage = "bili check"
description = "立即检查一次"
```

WebUI 的指令表会显示成三行，一眼看清有哪些子命令。

**② 自由参数** → 一条 `[[commands]]`，说明里写用法

```toml
[[commands]]
id = "ha.home"
usage = "home"
description = "不带参数看状态；home 开灯 / home 关电脑 / home 温湿度"
```

因为「开灯」「关电脑」里的设备名是任意文本，拆不成固定子命令。

**判断标准**：第二个词是**固定的有限集合**（status/check/preview）→ 拆；是**自由文本**（设备名）→ 不拆。

### 4.0.1 `usage` 绝对不能带前缀

```toml
# 对
usage = "cngal"

# 错：加了斜杠
usage = "/cngal"
```

框架在匹配前会**去掉一个前缀**（`/cngal` → `cngal`），所以 `usage` 里写 `/` 永远匹配不上。

显示时框架会自动加前缀：

```
usage = "cngal"   →  /help 里显示 /cngal
usage = "cngal push" → 显示 /cngal push
```

前缀本身在 `config.toml` 里配，插件不用关心：

```toml
[command]
prefixes = ["/", "!", "#"]   # 三个都认
```

**多前缀也不会变成 `//`**：输入 `/cngal` 只去掉一个 `/`，得到 `cngal`。

### 4.1 分发顺序

同一条消息会按顺序问每个插件，第一个返回 `handled: true` 的赢。顺序规则：

1. `priority` 大的先（默认 0）
2. `last = true` 的排最后
3. 同优先级按插件 id 字母序

**AI 聊天插件必须设 `last = true`**，否则它会抢在表情包、语音等指令插件前面，把"发个表情"当成聊天处理。

```toml
id = "ai-chat"
last = true          # 永远最后，其他插件都不认识才轮到它
description = "AI 聊天"
```

---

## 5. 工具（给 AI 用）

| 字段 | 说明 |
|---|---|
| `name` | `^[a-z][a-z0-9_]{2,40}$`，建议 `<插件>_<动词>` |
| `description` | **决定模型用不用**，写清"什么时候该调" |
| `parameters` | JSON Schema |

执行入口：

```js
async call_tool({ name, args }) {
  if (name !== 'weather_query') return { ok: false, error: '未知工具' }
  return { ok: true, data: { text: '北京 22°C 晴' } }
}
```

统一返回 `{ ok, data, error }`，**不要抛异常**。

> ⏳ 工具已注册、协议已通，宿主还没接 LLM 调用方。

---

## 6. 权限声明

**一个插件一套控制**。WebUI「权限」页按插件配置，不按命令。

```toml
[access]
allow_users = [2849446053]
allow_groups = []
require_role = ""
require_prefix = true
require_mention = false
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `allow_users` | `[]` | 允许的 QQ，空 = 不限 |
| `allow_groups` | `[]` | 允许的群，空 = 不限（私聊不受群限制） |
| `require_role` | `""` | 群角色要求：`owner` / `admin` |
| `require_prefix` | `true` | 必须带 `/` |
| `require_mention` | `false` | 群里必须 @ 机器人 |

### 触发方式

`require_prefix` / `require_mention` 是**必需条件**，不是禁止条件：

- 关掉前缀 → 不加 `/` 能触发，**加了 `/` 也能触发**
- 关掉 @ → 不 @ 能触发，**@ 了也能触发**

典型用法：

- 私聊免前缀：`require_prefix = false`
- 群里防刷屏：`require_mention = true`

### 命令级覆盖（高级）

个别命令需要更严的限制时，写在命令上：

```toml
[[commands]]
id = "admin.reload"
usage = "reload"
allow_users = [2849446053]
```

有命令级声明的命令用自己那套，其余命令沿用插件级。**WebUI 只展示插件级**，命令级覆盖不在这里编辑。

### 多个 QQ / 群

WebUI 输入框里用 `|` 分隔：

```
111111|222222|333333
```

也接受逗号。

### 插件读取权限

AI 插件在调工具前可以先问一句，避免绕过权限页：

```js
// 这个会话能不能用 weather 插件
const can = await host.checkPermission('weather', session)

// 所有插件的权限配置
const all = await host.listAccess()
// => { weather: { require_prefix: true, allow_users: [...], ... }, ... }
```

**宿主也会兜底**：`CallTool` 带 session 时自动按插件权限判定，插件忘了查也绕不过去。

### 协议端能力

```toml
permissions = ["onebot.write"]
```

| 级别 | 代表 | 需要声明 |
|---|---|---|
| read | `get_group_list` | 不需要 |
| write | `send_group_msg` | `onebot.write` |
| admin | `set_group_ban` | `onebot.admin` |
| dangerous | `get_cookies` | `onebot.dangerous`（默认禁） |

**最小权限原则**：只声明真的用到的级别。

---

### 6.4 什么时候必须配 `allow_users`

`require_prefix = false` 的插件等于**对所有人开放**。如果它会：

- 改外部状态（开关灯、切状态、发 HTTP 请求）
- 读写数据库
- 花钱（调付费 API）

**必须**配 `allow_users`：

```toml
[access]
require_prefix = false
require_mention = false
allow_users = [2849446053]     # 只有这些人能用
```

或者在插件设置里加一个 `allowUsers` 项（`|` 分隔），代码里判断：

```js
function allowed(session) {
  const list = parseIds(settings.allowUsers)
  return !list.length || list.includes(Number(session.user_id))
}
```

**空列表的语义要想清楚**：

| 写法 | 含义 | 建议 |
|---|---|---|
| `allow_users = []` | 不限（谁都能用） | 只用于纯查询类 |
| `allow_users = [123]` | 只有 123 | 有副作用的操作 |
| 设置项 `allowUsers = ""` | 需自己定义 | 推荐「空 = 禁止」（更安全） |

**判断口诀**：*这个插件被陌生人拿去用，最坏的结果是什么？*

- 无害 → 不配
- 有副作用 → 配
- 有副作用且不可逆 → 配 + 二次确认

## 6.1 能力（插件之间互相调用）

**工具是给模型用的，能力是给插件用的。** 两者不能混。

```toml
# 语音插件：声明自己提供什么
provides = ["tts.speak@1"]

# AI 插件：声明自己依赖什么
uses = ["tts.speak@^1"]
```

调用：

```js
const r = await host.capability('tts.speak', { text: '你好' })
```

规则：

- `call_capability` **只接受 `provides` 里声明过的名字**，调工具名会被拒。
- 依赖缺失时插件仍启动，但状态标 `degraded`，WebUI 显示"缺少能力: xxx"。
- 版本号 `@1` / `@^1` 目前只用于展示和匹配名字，**不做语义化版本校验**（以后再加）。

### 能力参数声明

只写 `provides` 的话，框架不知道参数长什么样，两边对不上只能在运行时炸。
用 `[[capability]]` 声明 schema，宿主会在调用前校验：

```toml
provides = ["weather_query@1"]

[[capability]]
name = "weather_query"

[capability.parameters]
type = "object"
required = ["city"]

[capability.parameters.properties.city]
type = "string"
```

校验结果：

```
{"city":"北京"}  → 正常
{"city":123}    → 参数 "city" 应为 string，实际传了 float64
{}              → 缺少必填参数 "city"
{"foo":"x"}     → 缺少必填参数 "city"
```

支持的 schema 子集：`type`（object/string/number/boolean/array）、`properties`、`required`。
**没声明 `[[capability]]` 的能力不做校验**，保持兼容。

### 能力契约

同一个能力允许多个实现（`db.sqlite` 可以是本地 SQLite，也可以是远程 PG 网关），
但**语义必须一致**，否则业务插件换个实现就坏。

所以每个能力要有一份「契约」，写清楚三件事：

**1. 参数** —— 用 `[[capability]]` 的 schema 声明，宿主会校验

**2. 返回格式** —— 统一用：

```json
{ "ok": true,  "data": { ... } }
{ "ok": false, "error": "人类能看懂的原因", "retryable": false }
```

`ok` 必填；`retryable` 表示"重试可能成功"（超时、网络），业务插件可以据此决定要不要重试。

**3. 每种操作的语义** —— 以 `db.sqlite` 为例：

| op | data 里有什么 | 说明 |
|---|---|---|
| `exec` | `{changes, last_id}` | 写操作，返回影响行数 |
| `all` | `{rows, count}` | 查多行 |
| `get` | `{row}` 或 `{row: null}` | 查一行，**没有要返回 null 而不是报错** |

新的实现（比如 `postgres.anzu`）必须照着这张表来，否则业务插件不能无缝切换。

**契约写在哪**：插件自己的 `README.md` 或设置页的说明里。框架不管内容，只保证调用链。

### 能力覆盖（重要）

**同一个能力可以有多个提供者，priority 高的接管，卸载后自动回退。**

典型场景：AI 聊天插件自带一个很基础的表情功能，后来装了个功能丰富的表情包插件。

```toml
# AI 聊天插件：提供基础实现
provides = ["emoticon.send@1"]
priority = 0
```

```toml
# 表情包插件：提供高级实现，接管
provides = ["emoticon.send@1"]
priority = 100
```

AI 插件里的调用**不用改**：

```js
const r = await host.capability('emoticon.send', { mood: '开心' })
```

- 两个插件都在 → 走表情包插件（priority 100）
- 表情包插件被禁用/卸载 → 自动回退到 AI 的基础实现

宿主会记录：

```
能力已注册 capability=emoticon.send plugin=sticker priority=100
```

WebUI 的 `GET /api/capabilities` 能看到每个能力的提供者列表和顺序。

### 能力 vs 工具怎么选

| | 工具 | 能力 |
|---|---|---|
| 谁调用 | 模型 / WebUI | 其他插件 |
| 声明 | `[[tools]]` | `provides` |
| 参数 | JSON Schema | 插件间约定 |
| 示例 | `weather_query` | `tts.speak`、`ai.persona` |

**模型能看到所有 `[[tools]]`，但看不到 `provides`。** 所以"改人设"这种不该让模型自己调的东西，应该做成能力。

---

## 6.2 共享数据

插件可以把自己的一部分数据托管给框架，其他插件读。

```toml
[[shared]]
key = "persona"
description = "当前人设"
default = "小鲸鱼"
```

- key 自动加 `<插件id>.` 前缀 → `ai-chat.persona`，不会撞
- **只有声明者能写**，其他插件只读
- 存在 `data/shared.json`，跟插件一起备份

```js
// AI 插件：读自己的
const persona = await host.sharedGet('ai-chat.persona')

// 人设插件：读别人的（只读）
const cur = await host.sharedGet('ai-chat.persona')
```

写要回自己的插件里做。如果人设插件要改人设，正确做法是：

1. AI 插件提供能力 `ai.persona`，暴露 `set` 方法
2. 人设插件 `host.capability('ai.persona', {action:'set', name:'傲娇'})`

**能力负责"改"，共享数据负责"读"。** 前者有逻辑和权限，后者只是值。

### 能力 vs 共享数据

| | 共享数据 | 能力 |
|---|---|---|
| 语义 | 读一个值 | 调一个方法 |
| 写入 | 只有 owner | 由提供者逻辑决定 |
| 适合 | 人设名、开关状态 | 改人设、生成语音 |

---

## 6.3 周期任务

订阅类插件（B 站 UP 主、RSS、微博）**不要自己 `setInterval`**，用框架的 `[[schedule]]`：

```toml
[[schedule]]
id = "check-updates"
every = "5m"
description = "检查 UP 主更新"
```

插件实现：

```js
async run_task({ task }) {
  if (task === 'check-updates') {
    await checkAndPush()
  }
  return { ok: true }   // 抛错会被记录到 last_error
}
```

好处：

- **重启后自动恢复**：声明式的，不用插件在 initialize 里重建定时器
- **WebUI 可见**：`GET /api/tasks` 能看到上次执行、次数、下次时间
- **可手动触发**：`POST /api/tasks/run`，调试订阅插件时不用等
- **出错有记录**：`last_error` 会保留，不用翻日志

间隔格式：`30s` / `5m` / `1h`，最小 1 秒。单次执行超时 2 分钟。

**为什么进框架**：轮询是多个插件共用的基础设施，各写各的会有三个问题——重启丢定时器、WebUI 看不见、出错没人知道。

---

## 6.4 运行环境

框架会自动检测插件需要什么运行时，**缺了不会等到 fork 才报错**，WebUI 上直接显示：

```
id    : weather
state : missing_runtime
error : PATH 里找不到 node。请安装 Node.js（建议 18+），
        或在 config.toml 的 [plugin.env] 里设置 PATH；
        也可以把 node 放进插件包的 deps/ 并把 exec 改成 ["./deps/node", ...]
```

### 自动推断

| `exec[0]` | 推断的运行时 |
|---|---|
| `node` / `node.exe` | Node |
| `python` / `python3` | Python |
| `deno` / `bun` | Deno / Bun |
| 其他 | 二进制（只检查文件在不在） |

### 显式声明（推荐）

```toml
[runtime]
kind = "node"
version = ">=18"
platform = "windows"   # 可选：限制只在某个系统加载
```

`version` 支持 `>=` `<=` `>` `<` `=`，不写就是不检查版本。

### 平台限制（`platform`）

带**原生模块**的插件（`.node` / `.so` / 编译好的二进制）必须写 `platform`，
否则换系统会启动失败：

```toml
[runtime]
kind = "node"
version = ">=18"
platform = "windows"        # 只在 Windows 加载
# platform = "linux"        # 只在 Linux
# platform = "windows|linux" # 都行
# platform = "darwin"       # macOS
```

不匹配时插件状态是 `wrong_platform`，WebUI 显示：

```
这个插件只支持 windows，当前是 linux
```

**为什么需要它**：`@napi-rs/canvas` 这类包的 `.node` 是按平台编译的，
包里带 Windows 版就只能 Windows 用。一个包塞两个平台会翻倍（27MB × 2），
所以推荐**按平台分别发包**。

不满足时同样是 `missing_runtime`：

```
检测到 node 16.20.0，但插件要求 >=18
```

**为什么推荐声明**：自动推断靠 `exec[0]` 的字面名字，哪天你把命令改个名就失效了。声明了更稳，也方便管理员一眼看出要装什么。

### 外部依赖声明

`[runtime]` 管解释器，`[[requires]]` 管插件要调用的**系统命令**：

```toml
[[requires]]
name = "ffmpeg"
kind = "binary"          # binary（默认）| env | file
value = "ffmpeg"
hint = "apt install ffmpeg  /  brew install ffmpeg"
```

缺失时状态是 `missing_dependency`，提示里带上 `hint`：

```
缺少依赖 ffmpeg：apt install ffmpeg  /  brew install ffmpeg
```

三种 kind：

| kind | value 是什么 | 检查方式 |
|---|---|---|
| `binary` | 命令名 | `PATH` 里找 |
| `env` | 环境变量名 | 值非空 |
| `file` | 路径 | 文件存在 |
| `plugin` | 插件 id | 装没装（看清单里有没有） |

**`kind = "plugin"`** 用来依赖另一个插件，比如 SQLite 服务：

```toml
[[requires]]
name = "SQLite 存储"
kind = "plugin"
value = "sqlite"
```

装了 `sqlite.anzu` 就能用，没装时状态是 `missing_dependency`：

```
缺少依赖 SQLite 存储：需要先安装插件 sqlite（对应的 .anzu 包），装好后启用本插件即可
```

> 这是「系统组件」的实现方式：**组件是插件，但被别的插件当成基础设施**。
> 装了就生效，卸了就报缺依赖，不需要改框架。

### 三种状态

| state | 含义 |
|---|---|
| `ready` | 正常 |
| `missing_runtime` | 运行环境不满足，**不是插件的问题** |
| `failed` | 插件自身启动失败 |

`missing_runtime` 和 `failed` 分开，是为了让人一眼看出"该装环境"还是"插件有 bug"。

---

## 6.5 外部依赖（ffmpeg 之类）

插件要用外部命令时，**按这个顺序找**：

1. 设置项（管理员在设置页填的路径，最高优先）
2. 环境变量（`FFMPEG_PATH`）
3. `PATH`

框架会把 `[plugin] env` 注入到每个插件进程，系统环境变量也默认继承：

```toml
# config.toml
[plugin]
env = { FFMPEG_PATH = "C:\\tools\\ffmpeg.exe" }
```

插件里：

```js
const ffmpeg = settings.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg'
```

**绝对不要写死路径**。Windows 是 `ffmpeg.exe`，Linux 是 `ffmpeg`，写死就跨不了平台。

### ffmpeg 本身怎么分发

| 方式 | 适合 | 代价 |
|---|---|---|
| 塞进 `.anzu` 的 `deps/` | 想做到开箱即用 | 包体 +30~80MB |
| 要求系统安装 + 设置页提示 | 自用、服务器 | 用户要手动装 |
| 首次运行下载 | 现代插件的常见做法 | 要处理下载失败 |

三种都行，**framework 不介入**——插件在自己进程里 spawn 什么，宿主本来就管不着。进程边界就是权限边界。

---

## 6.6 工具面板（AI 类插件）

框架导航里**没有**「工具」页。工具只对 AI 类插件有意义，所以它出现在自己的设置页里。

插件声明：

```toml
use_tools = true
```

效果：插件详情页（`/plugin/<id>/`）多出「可用工具」区块，列出所有插件声明的工具和参数，方便排查。

**什么时候加**：这个插件会调 `host.list_tools`、把工具列表塞给模型（AI 聊天类）。

**什么时候不加**：普通指令插件。不加就看不到工具面板，页面更干净。

---

### 加载顺序

框架**分两轮**加载插件：

1. **第一轮**：`kind = "service"` 的插件 + 被其他插件 `[[requires]] kind="plugin"` 点名的插件
2. **第二轮**：其余普通插件

所以声明了插件依赖是安全的，不会因为字母序（`ai-chat` < `sqlite`）而误报缺依赖。

日志里能看到：

```
第一轮加载系统组件 plugins=[sqlite llm]
```

---

## 6.7 服务插件（基础设施）

如果某个功能**多个插件都要用**（LLM 调用、TTS、绘图），不要每个插件各写一遍，做一个服务插件：

```toml
id = "llm"
name = "LLM 服务"
kind = "service"          # 不接消息，只提供能力
provides = ["llm.chat@1"]

[[capability]]
name = "llm.chat"

[capability.parameters]
type = "object"
required = ["messages"]
```

其他插件：

```js
const r = await host.capability('llm.chat', { messages, model: 'fast' })
```

**`kind = "service"` 的作用**：

- 分发消息时直接跳过（不用每次调 `handle_message` 返回 false）
- WebUI 里单独归类，和业务插件区分开
- 语义明确：这是基础设施，不是业务

### 完整示例

`dist/llm/` 是一个能直接用的 LLM 服务插件，演示了这条链的完整写法：

- `kind = "service"` —— 不接消息
- `provides` + `[[capability]]` —— 能力声明和参数 schema
- `[[settings]]` —— 四类控件（string / password / number）
- 调外部 API + 错误分类（`retryable`）

验证过的三种结果：

```
未配 key      → {"ok":false,"error":"LLM 未配置 API Key，请在插件设置里填写"}
配了假 key    → {"ok":false,"error":"请求失败: fetch failed","retryable":true}
配真 key      → {"ok":true,"data":{"text":"...","usage":{...}}}
```

其他插件这样用：

```js
const r = await host.capability('llm.chat', {
  messages: [{ role: 'user', content: '你好' }],
})
if (r?.ok) reply(r.data.text)
```

**这就是「万物皆插件」的样板**：LLM 这种东西不塞进框架，做成一个服务插件，出问题改它就行。

### 什么该做成服务插件

| 该做成服务插件 | 该各自实现 |
|---|---|
| 需要集中配置（API key） | 纯工具库（字符串处理） |
| 需要限流/重试/统计 | 无状态计算 |
| 多个插件都要调 | 只有自己用 |

**一个经验法则**：如果两个插件都要「配置同一个 key」，就该抽成服务插件。

---

## 6.8 画图：用 canvas 服务，别自己带原生模块

`@napi-rs/canvas` 的 `.node` 是按平台编译的（每个 27MB），每个要画图的插件各带一份，
包体积翻倍还容易跨平台出问题。框架把它做成了**服务插件**：

```toml
# manifest.toml
[[requires]]
kind = "plugin"
value = "canvas"
```

```js
// 画一张 480×480 的卡片
const r = await host.capability('canvas.render', {
  width: 480,
  height: 480,
  background: '#f6f5f2',
  ops: [
    { type: 'rect', x: 20, y: 20, w: 440, h: 440, fill: '#fff', radius: 16 },
    { type: 'text', text: '半吉', x: 240, y: 120, size: 56, font: 'Mamelon', align: 'center', color: '#b4453a' },
    { type: 'text', text: '在时尚上花钱', x: 240, y: 200, size: 28, font: 'sakura', align: 'center' },
  ],
})
// r.data.image → base64 PNG
```

### 支持的 op

| type | 参数 | 说明 |
|---|---|---|
| `image` | `src x y w h round?` | `src` 支持 http / `base64://` / `data:` / 本地绝对路径 |
| `rect` | `x y w h fill? stroke? radius? lineWidth?` | |
| `text` | `x y text size font color bold? align? baseline?` | 基础文字 |
| `text` + `wrap` | 上面的 + `wrap maxLines? lineHeight?` | **自动折行**，不用自己 measureText |
| `text` + `vertical` | 上面的 + `gap` | **竖排**，逐字往下 |
| `ellipsis` | `x y text wrap size font color` | 超宽自动截断加 `…` |

### 量图片尺寸

瀑布流布局要知道宽高比：

```js
const r = await host.capability('canvas.probe', { urls: ['https://...', 'https://...'] })
// r.data.sizes → [{url, width, height}]
```

### 字体：框架带了一个，不用自己配

canvas 服务**内置霞鹜文楷**（OFL-1.1 开源协议，13MB），不指定 `font` 就用它：

```js
{ type: 'text', text: '中文', x: 100, y: 100, size: 24 }
// → 自动用霞鹜文楷，不会变方块
```

要自己的字体就放 `<插件>/assets/fonts/`，canvas 会扫描所有插件注册成全局字体
（别名 = 文件名去扩展名）：

```
<插件>/assets/fonts/MyFont.ttf   →   font: 'MyFont'
```

**扫描顺序**：`assets/fonts` → `assets/font` → `app/fonts`（旧）→ `fonts`（旧）。
同名后面的覆盖前面的。

**不想用霞鹜文楷**？可以在 canvas 服务里换掉 `assets/fonts/` 下的文件，
或者插件自己指定 `font`。

### 换平台

只有 canvas 插件需要换包（`[runtime] platform = "windows"`），
所有调用方一行不用改。

## 6.9 并发（速查）

```toml
concurrency = "session"   # 不同群并行；不写 = 整个插件串行
```

| 插件做什么 | 选什么 |
|---|---|
| 查询类（天气、运势） | `session` |
| 有共享状态 | 不写（默认串行） |
| 长交互（`host.ask`） | `session` |

**详细说明、实测数据、和冷却的关系见 §6.16b。**


## 6.10 素材目录：统一放 `assets/`

### 就一个约定，别搞花样

```
<插件>/
├── manifest.toml
├── app/
│   └── index.js          ← 代码
└── assets/               ← 所有素材，全放这里
    ├── img/              ← 图片
    ├── audio/            ← 音频
    ├── video/            ← 视频
    └── fonts/            ← 字体
```

**没有 `app/assets`，没有 `app/fonts`**——以前的写法框架还认（向后兼容），
但新插件一律用包根的 `assets/`。

### 标准子目录 vs 自定义子目录

**这四个是标准目录，不用声明**：

```
assets/img/     图片
assets/audio/   音频
assets/video/   视频
assets/fonts/   字体（canvas 自动注册成全局字体）
```

**自己另开的子目录，要在 manifest 里声明**：

```toml
[assets]
dirs = ["templates", "data"]
```

框架加载时校验 `assets/templates` 和 `assets/data` 存在，不存在打警告（不阻止加载）。

**为什么声明**：让框架和其他人一眼知道这个插件会读写哪些素材目录，
也让打包工具能检查有没有漏打文件。

**标准目录不用写**，写了反而会警告「标准素材目录不用声明」。

### 插件怎么拿到路径

框架注入环境变量，不用自己算相对路径：

```js
process.env.QIXIN_ASSETS_DIR    // assets/ 的绝对路径
process.env.QIXIN_PLUGIN_DIR    // 运行区根目录
process.env.QIXIN_DATA_DIR      // 持久数据目录
process.env.QIXIN_PLUGIN_ID     // 插件 id
```

```js
import path from 'node:path'
const file = path.join(process.env.QIXIN_ASSETS_DIR, 'img', 'cat.png')
await host.reply(chat, [{ type: 'image', data: { file } }])
```

### 发本地素材

**绝对路径**，必须在 `data/` 下（安全限制），**单文件 20MB 上限**。

```js
// 方式一：给路径，框架读盘转 base64
{ type: 'image', data: { file: '/abs/data/plugins/x/assets/img/a.png' } }

// 方式二：自己转 base64
{ type: 'image', data: { file: `base64://${b64}` } }
```

| 方式 | 适合 | 代价 |
|---|---|---|
| 绝对路径 | 小图、频繁发 | 每次读盘 |
| base64 | 大图、要缓存 | 内存多一份 |

### 字体：框架有兜底

**画图不用带字体也行**——canvas 服务内置了**霞鹜文楷**（OFL-1.1 开源协议）。

```js
// 不指定 font，就用框架的霞鹜文楷
{ type: 'text', text: '中文', x: 100, y: 100, size: 24 }
```

要自己的字体：

```
<插件>/assets/fonts/MyFont.ttf
```

canvas 服务启动时扫描**所有插件**的 `assets/fonts/`，别名 = 文件名。然后：

```js
{ type: 'text', text: '中文', font: 'MyFont', ... }
```

**扫描顺序**（同名时后面的覆盖前面的）：

```
<插件>/assets/fonts/
<插件>/assets/font/
<插件>/app/fonts/     ← 旧的，兼容
<插件>/fonts/         ← 旧的，兼容
```

真实例子：

| 插件 | 用什么字体 |
|---|---|
| `cngal` | 不指定 → 框架的霞鹜文楷 |
| `fortune` | 自带 `Mamelon.otf`（标题）+ `sakura.ttf`（签文），不用框架的 |

### 能和别的插件共享素材吗

**技术上能**（路径可算），**但不推荐**——耦合太紧。

三个更稳的办法：

1. **复制一份**到自己的 `assets/`（素材不大时最简单）
2. **用能力**：让对方提供 `xxx.asset` 能力
3. **用共享数据**：`host.shared.set('图标', base64)`（只适合几十 KB）

### 大小限制

| 项 | 限制 |
|---|---|
| 单文件发出去 | 20 MB |
| 包内单文件 | 32 MB |
| 包内总计 | 无硬限制，但几十 MB 部署很慢 |

**大素材**：图片压 JPEG 质量 80；音频 mp3 128kbps；视频别打包，用 URL。

## 6.11 用 Python 写插件

**Python SDK 和 Node SDK 接口对齐**（`sdk/python/qixin.py`，16 个方法）：

| 能力 | Python | Node |
|---|---|---|
| 发送 | `host.reply(chat, segs)` | 同名 |
| 交互等待 | `host.ask(chat, text, timeout_sec=60)` | `host.ask(chat, text, opts)` |
| 后台任务 | `host.background(session, name, fn)` | 同名 |
| 能力调用 | `host.capability(name, args)` | 同名 |
| 私有存储 | `host.storage_get/storage_set` | `host.storage.get/set` |
| 共享数据 | `host.shared_get/set/list` | `host.sharedGet/Set/List` |
| 工具 | `host.list_tools(session)` | `host.listTools(session)` |
| 权限 | `host.check_permission(plugin, session)` | `host.checkPermission(...)` |
| OneBot 原始调用 | `host.call_onebot(action, params)` | `host.callOnebot(...)` |
| 日志 | `host.log(msg, level)` | `host.log(level, msg)` |

**最后一行参数顺序不同**：Python 必填参数在前，Node 是 `(level, message)`。

### 最小例子

```python
from qixin import serve, host, chat_of

def initialize(params):
    return {"api_version": "1.0"}

def handle_message(params):
    s = params["session"]
    text = (s.get("text") or "").strip()
    if not text.startswith("hi"):
        return {"handled": False}
    host.reply(chat_of(s), "你好")
    return {"handled": True}

serve(initialize=initialize, handle_message=handle_message)
```

### 三步交互（和 Node 一样的写法）

```python
def handle_message(params):
    s = params["session"]
    if s.get("text", "").strip() != "bind":
        return {"handled": False}

    chat = chat_of(s)
    chat["user_id"] = s["user_id"]
    name = host.ask(chat, "请输入名字（30 秒内）：", timeout_sec=30)
    if not name:
        host.reply(chat, "超时")
        return {"handled": True}
    host.reply(chat, "绑定成功：" + name)
    return {"handled": True}
```

### 并发注意

**读循环在独立线程**，所以：

- `host.ask` 阻塞**当前处理线程**，不影响其他群（框架那边有会话池）
- `host.background` 起**独立线程**，不阻塞 `handle_message`
- **两个线程同时调宿主是安全的**（SDK 内部有锁）

**但 GIL 意味着真正并行只在 I/O 上**——CPU 密集任务用 `multiprocessing` 或外部进程。

**旧版的坑（已修）**：以前 `call()` 直接读 stdin，
如果宿主同时发来 `plugin.ping`，那行会被吞掉。现在读线程统一收、按 id 投递。

### 一致性检查

```bash
python tools/sdk-conformance.py
```

用同一份用例验证两边 SDK 的 RPC 帧和解析结果一致。CI 会自动跑。


## 6.12 存储：SQLite 是默认，插件不能替换它

### 为什么默认 SQLite

框架的持久化接口是**同步**的（`Get` / `Set` / `List` 立即返回）。

JSON 后端的写路径是「序列化全部 + 全量写盘」：

```
每次改一个 key → 重写整个文件
10 个群    ~10 KB
100 个群   ~100 KB
1000 个群  ~1 MB   ← 每秒 10 条消息就是 10MB 磁盘写入
```

SQLite 是「索引定位 + 只改这一行」：

```sql
UPDATE kv SET value=? WHERE bucket=? AND key=?
```

所以**默认 `driver = "sqlite"`**。JSON 留在那里只是给本地调试用（方便直接看文件）。

### 为什么不让插件替换核心存储

**硬约束：框架的存储调用是同步的，插件调用是 RPC（异步）**。

如果框架每次 `shared.get('x')` 都要走一次跨进程 RPC：

| 操作 | 本地 SQLite | 走插件 RPC |
|---|---|---|
| 读一个 key | ~10µs | ~1-3ms（100-300 倍） |
| 一次消息分发里的多次读写 | 微秒级累计 | 毫秒级累计，消息一多就堵 |

**消息分发链路上不允许这种延迟**。

所以：

- ❌ `driver = "plugin"` 这种设计**不做**
- ✅ 框架自己的存储只在内置的 JSON / SQLite 之间选
- ✅ 插件之间共享**业务数据**用能力（`db.sqlite` 就是干这个的）

### 那插件想用自己的数据库怎么办

**两种场景，分开处理**：

**① 插件要存自己的业务数据**（订单、订阅列表、抽签记录）

用 `host.storage`：

```js
await host.storage.set('orders', [...])
```

**它的存储位置**：`data/plugins/<id>/data/storage.json`（每插件一个 JSON 文件）。

**为什么不是 SQLite**：这是**插件私有的小数据**——几 KB、只在用户改设置或更新业务数据时写。
放 JSON 反而方便你直接打开看、方便备份。框架内部的高频数据和共享数据才走 SQLite
（`data/qixin.db`）。

**② 插件要给别人提供数据库能力**（多个插件共享一张表）

**`db.sqlite` 现在是框架内置能力**，不用装插件。

**它是独立的数据库**（`data/plugins.db`），和框架内部的 KV（`data/qixin.db`）**物理分开**——
插件执行任意 SQL 也读不到 `kv` 表。这是刻意的：

```js
// 插件能看到的空间（自己建表）
await host.capability('db.sqlite', { op: 'exec', sql: 'CREATE TABLE orders (...)' })

// 框架的 KV 表不在这里，SELECT * FROM kv 会报 "no such table"
```


```js
// 直接调，框架自己就带 SQLite
const r = await host.capability('db.sqlite', {
  op: 'all',                                    // exec | all | get
  sql: 'SELECT * FROM users WHERE id = ?',
  params: [123],
})
// r.data.rows / r.data.count（all）
// r.data.affected / r.data.last_id（exec）
// r.data.row（get，查不到是 null）
```

**三种 op**：

| op | 用途 | 返回 |
|---|---|---|
| `exec` | INSERT / UPDATE / DELETE / DDL | `{affected, last_id}` |
| `all` | 查多行（默认） | `{rows: [...], count}` |
| `get` | **查一行**（按主键/唯一键） | `{row: {...}}` 或 `{row: null}` |

**`get` 查不到不报错**——返回 `{row: null}`。这样"读配置、没有就用默认值"
不用套 try/catch：

```js
const r = await host.capability('db.sqlite', {
  op: 'get',
  sql: 'SELECT content FROM persona WHERE name = ?',
  params: ['私聊'],
})
const content = r.data.row?.content || '默认人设'
```

**返回格式**：

```json
{"rows": [{"id": 1, "name": "测试"}], "count": 1}
```

**这条路没有 RPC 往返**——框架自己执行 SQL，和插件在同一台机器上。

**想换成 MySQL/PostgreSQL**？那才需要自己写服务插件提供能力。

### 迁移

从 `json` 切到 `sqlite` 时，首次启动自动迁：

```
1. 读 data/store.json（或 data/shared.json）
2. 目标 bucket 为空才写
3. 写完标记，下次不重复迁
```

**不会覆盖新数据**——如果你已经用 SQLite 跑了一段时间再切回 JSON 又切回来，旧数据不会把新的冲掉。

### 备份

```powershell
# SQLite：直接拷三个文件（WAL 模式）
Copy-Item data\qixin.db* backup\
```

**注意 `-wal` 和 `-shm` 一起拷**，否则可能丢最近的事务。

## 6.13 在虚拟群里调插件

控制台 `/chat` 页面左边有个 **🧪 虚拟群**。点进去，你就是个普通群员：

```
你（虚拟群员）
  /echo 你好

机器人
  你好
  （你已 echo 1 次）

  分发耗时 22ms · 回声
```

**它走的是完整分发链路**：前缀剥离 → 权限判定 → 插件分发 → 能力调用 → 回复。

**和真实消息的区别只有两个**：

| | 真实消息 | 虚拟群 |
|---|---|---|
| 来源 | OneBot 推送 | 控制台注入 |
| 回复去向 | 真实 QQ 群 | 只显示在网页上 |

**三层保护确保不发错地方**：

1. 全局静音（`Queue.Mute`）——测试期间所有发送丢弃
2. 捕获（`Queue.BeginCapture`）——把想发的消息收下来渲染
3. 假账号（`__inject_test__`）——找不到真实连接

**副作用是真实的**：插件写的文件、调的外部 API 都会真的执行。
只有"发消息到 QQ"这一步被拦住。

**身份可以切换**：输入框上方有下拉选择——

| 身份 | `user_id` | `role` | 用来测 |
|---|---|---|---|
| 主人 | config 的 `[owner].users[0]` | `owner` | 命令能用 |
| 群管理 | 20001 | `admin` | `require_role = "admin"` |
| 纯路人 | 30001 | `member` | 白名单拒绝、静默拒绝 |

**主人 QQ 在哪配**：控制台「权限」页顶部的「主人 QQ」表单，
改完立即生效（重建权限判定器，不用重启）。

**怎么用**：

1. 改插件代码（`dist/<id>/app/index.js`）
2. `qixinpack pack` + 丢进 `plugins/`（或者用插件页的"重载"）
3. `/chat` 里点虚拟群，选个身份，发一句话
4. 看回复和耗时，不满意就回去改

**不用连 QQ、不用刷群、不用翻日志**。

## 6.14 非文本消息的显示

控制台聊天面板对**没有文字的消息**会用方括号标类型：

| 消息段 | 显示 |
|---|---|
| `forward` | `[聊天记录]` |
| `image` | `[图片]` |
| `record` | `[语音]` |
| `video` | `[视频]` |
| `file` | `[文件]` |
| `json` / `xml` | `[卡片消息]` |
| `reply` | `[回复]` |
| `poke` | `[戳一戳]` |
| `face` | `[表情]` |
| `at` | `@QQ号` |
| 其它 | `[段类型]` |

**为什么要这样**：`session.raw_text` 只含 `text` 段，纯图片/聊天记录的消息是空的。
框架会先用 `segmentsText` 兜底，前端再兜一层 `[消息]`，所以面板上不会出现空白行。

**插件侧**：如果你要处理这些消息，读 `session.segments`（原始段数组），别指望 `session.text`。

## 6.15 单次消息追踪

虚拟群里每条回复下面有个可以展开的「追踪」：

```
分发耗时 22ms · 回声
▸ 追踪 t3-1a2b · 处理完成 · 22ms
    · 收到 — 从控制台注入
    · 分发 — 开始
    · 插件「B站订阅」— 未认领
    · 插件「国 G 周报」— 未认领
    · 插件「回声」— 认领
    · 完成
    · 发送 — 捕获 1 条
```

**被权限拦住的时候**：

```
▸ 追踪 t4-3c4d · 权限（智能家居）：权限不足 · 21ms
    · 收到 — 从控制台注入
    · 分发 — 开始
    · 插件「回声」— 未认领
    ✗ 权限「智能家居」— 权限不足     ← 红色
    · 插件「关键词回复」— 未认领
    · 发送 — 没有回复
```

**一眼看出是"没匹配上"还是"被权限拦了"**——不用翻日志。

**返回结构**（`/api/chat/inject`）：

```json
"trace": {
  "id": "t4-3c4d",
  "verdict": "权限（智能家居）：权限不足",
  "total_ms": 21,
  "stages": [
    {"name": "权限", "plugin": "home-assistant", "ok": false, "reason": "权限不足"}
  ]
}
```

**`verdict` 优先报原因**：权限 → 插件报错 → 发送失败，从前往后找第一个能解释"为什么没成"的。

**代码里怎么用**：

```go
sess.Trace = trace.New(sess.Text)
sess.Trace.Add("收到", "", true, "从控制台注入")
mgr.Dispatch(ctx, sess)      // 内部自动加"分发""权限""插件"阶段
fmt.Println(sess.Trace.Verdict())
```

**注意**：trace 只在**控制台注入**时生成。
真实消息也走 `Dispatch`，但 trace 不落库（避免每条消息都存一份）。

## 6.16 两步交互：等用户下一条消息

绑定账号、分步设置、小游戏这类流程，不用自己存"我在等谁"：

```js
async handle_message({ session }) {
  const text = (session.text ?? '').trim()
  if (text !== 'bind') return { handled: false }

  const chat = chatOf(session)
  chat.user_id = session.user_id

  const name = await host.ask(chat, '请输入要绑定的名字（30 秒内）：', { timeout_sec: 30 })
  if (!name) {
    await host.reply(chat, '超时，已取消')
    return { handled: true }
  }
  await host.reply(chat, `绑定成功：${name}`)
  return { handled: true }
}
```

**流程**：

```
用户: /bind
机器人: 请输入要绑定的名字（30 秒内）：
用户: 小明
机器人: 绑定成功：小明
```

**中间那条"小明"不会触发任何插件**——宿主直接把它交给等待中的 `ask`。

**几个细节**：

| 问题 | 答案 |
|---|---|
| 超时怎么办？ | 返回空字符串，`if (!name)` 就能处理 |
| 别人插话会怎样？ | 只认 `user_id` 匹配的那个人，其它消息正常分发 |
| 多账号会串吗？ | **不支持多账号**（框架单账号设计），键里没有 account |
| 等的时候能收到别的命令吗？ | 那个人发别的也算"回答"（简单粗暴，但可预期） |
| 能等几轮？ | 想等几轮就调几次 `host.ask` |
| 超时上限？ | 别超过 5 分钟——它会阻塞这个插件的 `handle_message` |
| 会拖累别的群吗？ | **看 `concurrency`**，见下 |

### `host.ask` 期间会占住什么

| `concurrency` | 等回答时，别的群能用这个插件吗 |
|---|---|
| 默认（`plugin`） | ❌ 不能，所有群排队 |
| `"session"` | ✅ 能，只占住**那个群** |

**做长交互的插件（绑定、向导、小游戏）请配 `session`**：

```toml
concurrency = "session"

[[commands]]
id = "myplugin.bind"
usage = "bind"
```

实测（插件等 30 秒回答，两个群同时进来）：

```
plugin 模式：  群A 进入等待，群B 干等 30 秒
session 模式： 群A、群B 同时进入等待，各答各的
```

**同一个群里**还是要排队——防止同一群连发两条打乱交互流程。

**超时设太长会一直占着**：`session` 只占一个群，`plugin` 占整个插件。
所以超过 5 分钟的交互建议拆成多轮短等待。

**虚拟群里测试**：第一步和第二步要**用同一个身份**（`user_id` 要一致）。
默认的「主人」身份是 config 里的 owner，两步都是同一个 QQ，能对上。

**控制台显示**：第二步的 trace 会显示

```
· 交互 — 被 host.ask 消费
```

**注意**：虚拟群里第二步的"绑定成功"可能显示不出来——
因为 `ask` 跨了两次请求，第二次的回复在第一次的捕获窗口之外。

**真实消息路径现在是正常的**：框架在消息入口就查 ask，
回答不会排在等待中的那条消息后面（见 `ARCHITECTURE.md` §3.5）。

## 6.17 长任务：别堵住消息处理

`handle_message` 有 30 秒超时。**做长活的正确姿势**：

```js
async handle_message({ session }) {
  if (session.text.trim() !== 'report') return { handled: false }

  host.background(session, '生成日报', async () => {
    const data = await slowFetch()             // 60 秒也无所谓
    await host.reply(chatOf(session), data)
  })

  await host.reply(chatOf(session), '在生成了，稍等')
  return { handled: true }                      // 立刻返回，不占会话
}
```

**用户看到**：

```
用户: /report
机器人: 在生成了，稍等      ← 立刻回
（60 秒后）
机器人: [日报内容]          ← 后台任务发的
```

**对比**：

| 写法 | 0-30 秒 | 30 秒后 |
|---|---|---|
| 直接在 `handle_message` 里 await | 会话被占住 | **超时失败** |
| `host.background` | 立刻返回 | 任务继续跑 |

**三个注意点**：

1. **它不活过重启**——插件进程死了任务就没了。要跨重启用 `[[schedule]]`。
2. **控制台可见**——「工具」页有后台任务表，能看到哪些还在跑。
3. **失败只记日志**——后台任务的异常不会发到群里（避免刷屏），
   插件自己决定要不要通知用户。

**什么时候该用定时任务而不是后台任务**：

| 需求 | 用什么 |
|---|---|
| 用户触发、跑一次 | `host.background` |
| 每天 9 点跑 | `[[schedule]]` + cron |
| 每 20 秒轮询 | `[[schedule]]` + every |
| 用户触发但可能要跑 5 分钟 | `host.background` |
| 需要重启后继续 | `[[schedule]]`（后台任务做不到） |

## 6.18 定时任务：固定间隔和 cron

插件在 manifest 里声明，宿主负责调度。**插件只实现 `plugin.run_task`**。

```toml
# 固定间隔
[[schedule]]
id = "poll"
every = "20s"
description = "每 20 秒轮询一次订阅更新"

# cron（标准 5 段：分 时 日 月 周）
[[schedule]]
id = "daily-report"
cron = "0 9 * * *"
description = "每天 9 点推日报"

# 带秒的 6 段
[[schedule]]
id = "heartbeat"
cron = "*/30 * * * * *"
description = "每 30 秒一次"
```

**两个都写时 `cron` 优先**。

### cron 表达式速查

| 写法 | 含义 |
|---|---|
| `0 9 * * *` | 每天 9:00 |
| `*/10 * * * *` | 每 10 分钟 |
| `0 */2 * * *` | 每 2 小时整点 |
| `30 8 * * 1-5` | 工作日 8:30 |
| `0 0 1 * *` | 每月 1 号 0 点 |
| `0 9 * * mon` | 每周一 9 点（星期可写英文缩写） |
| `*/30 * * * * *` | 每 30 秒（6 段，第一位是秒） |

### 插件里怎么写

```js
serve({
  async run_task({ task }) {
    if (task === 'poll') {
      await checkSubscriptions()
      return { ok: true, summary: '检查了 5 个订阅' }
    }
    if (task === 'daily-report') {
      await sendDailyReport()
      return { ok: true }
    }
  },
})
```

**返回的 `summary` 会显示在控制台的"定时任务"表格里**（排查时有用）。

### 控制台能做什么

控制台「工具」页的下半部分是定时任务表：

```
插件        任务           触发          上次执行      下次          次数  状态
ts3-tracker poll           15s          10-24 20:15  10-24 20:15   128   运行中   [运行] [暂停]
cngal       tick           60s          10-24 20:15  10-24 20:16   32    运行中   [运行] [暂停]
bilibili    daily-report   0 9 * * *    —            10-25 09:00   0     运行中   [运行] [暂停]
```

| 按钮 | 作用 |
|---|---|
| **运行** | 立刻触发一次（调试订阅插件很有用） |
| **暂停** | 停止调度，但**不卸载插件**；再点恢复 |
| **恢复** | 重新开始按计划跑 |

**暂停状态会落盘**（`data/tasks.json`）——重启后还是暂停的。

### 宿主保证的事

1. **重启后自动恢复**：`last_run` / `runs` / `paused` 都存在 `data/tasks.json`
2. **单次执行超时 2 分钟**：卡死的任务不会永远占着
3. **失败有记录**：错误显示在表格的"状态"列
4. **插件卸载时自动停**：任务 goroutine 跟着 `h.Done()` 退出

### 别在插件里自己 setInterval

```js
// ❌ 不要这样
setInterval(() => check(), 20000)

// ✅ 声明出来
// manifest.toml: [[schedule]] id="poll" every="20s"
async run_task({ task }) { if (task === 'poll') await check() }
```

**为什么**：自己起的定时器，宿主看不见、停不掉、重启就丢、出错没记录。
声明出来之后，暂停/恢复/手动触发/失败统计全都是现成的。

## 6.19 结构化命令：让宿主帮你解析参数

以前插件得自己干这些：

```js
async handle_message({ session }) {
  const text = session.text
  if (!text.startsWith('weather ')) return { handled: false }
  const city = text.slice(8).trim()
  if (!city) {
    await host.reply(chatOf(session), '用法：/weather <城市>')
    return { handled: true }
  }
  // 终于拿到 city 了
}
```

**现在可以在 manifest 里声明，宿主解析好塞给你**：

```toml
[[commands]]
id = "weather.current"
usage = "weather <city>"
description = "查天气"
args = { city = { type = "string", required = true, help = "城市名" } }
```

插件收到的 `session`：

```json
{
  "text": "weather 上海",
  "command": {
    "id": "weather.current",
    "name": "weather",
    "args": { "city": "上海" },
    "missing": []
  }
}
```

```js
async handle_message({ session }) {
  if (!session.command) return { handled: false }   // 不是我的命令
  const { city } = session.command.args
  if (!session.command.missing.length === 0) { ... }
}
```

### 参数类型

| `type` | 行为 |
|---|---|
| `string` | 取一个词（默认） |
| `int` | 取一个词，插件自己 `parseInt`（宿主不校验，避免方言差异） |
| `rest` | **吃掉剩余全部**（可以带空格），适合"内容""理由"这类 |

**`rest` 的例子**：

```toml
[[commands]]
id = "echo.say"
usage = "echo <content>"
args = { content = { type = "rest", required = true } }
```

发 `/echo 你好 世界` → `args.content = "你好 世界"`。

### 必填和缺失

```toml
args = { city = { type = "string", required = true } }
```

发 `/weather`（没给城市）→

```json
"command": { "id": "weather.current", "args": {}, "missing": ["city"] }
```

**插件自己决定怎么回**（回用法、或者用默认城市都行）：

```js
if (session.command.missing.length) {
  await host.reply(chatOf(session), '用法：/weather <城市>')
  return { handled: true }
}
```

### 三条约束

**① 参数名必须是英文**

TOML 的内联表键不支持中文：

```toml
args = { 城市 = {...} }   # ❌ 解析失败
args = { city = {...} }   # ✅
```

中文放 `help` 里：

```toml
args = { city = { type = "string", help = "城市名，如 上海" } }
```

**② 占位符要和 args 的键对上**

```toml
usage = "weather <city>"          # 占位符 city
args = { city = {...} }            # 键也是 city ✓
```

对不上时按 `type = "string"` 处理（不会崩，但类型声明失效）。

**别名也能触发结构化解析**：

```toml
[[commands]]
id = "weather.current"
usage = "weather <city>"
aliases = ["w", "天气"]
args = { city = { type = "string", required = true } }
```

`/w 上海` 和 `/天气 上海` 都会得到 `command.id = "weather.current"`，
`command.name` 是**实际匹配到的词**（`w` 或 `天气`）。

**③ 可以不声明**

**完全向后兼容**：manifest 里没有 `args`，`session.command` 就只有 `id`/`name`，
`args` 是空的——插件照旧自己解析 `session.text`。

**迁移是渐进的**：老插件一行不用改。

### 宿主怎么匹配

1. 取 `usage` 的第一个词当命令名（`weather <city>` → `weather`）
2. 和消息文本的第一个词比（**大小写不敏感**）
3. 匹配上就按 `<占位符>` 的顺序从后面取词

**只支持位置参数**，不支持 `--flag`。需要复杂参数就自己解析。

---

## 6.19b 超时可配置：重依赖的服务插件

默认超时：

| 阶段 | 默认 | 可配 |
|---|---|---|
| 启动握手（`initialize`） | 10 秒 | `[timeouts] init` |
| 能力调用（`call_tool`） | 15 秒 | `[timeouts] capability` |
| 单条消息（`handle_message`） | 30 秒 | `[timeouts] message` |
| **单次宿主调用兜底** | **30 分钟** | `[timeouts] call` |

**`init` 只管启动握手**，不会截断 `host.ask`（它有自己的 `timeout_sec`）或慢能力调用。
`call` 只是防止某个方法挂死的兜底，不是业务超时。

**重依赖的服务插件**（加载模型、连慢速后端）可以放宽：

```toml
[timeouts]
init = "60s"          # 加载模型要 40 秒
capability = "60s"    # 推理可能要 50 秒
message = "120s"
```

**别调太大**：

- `init` 太长 → 启动时看着像卡死
- `capability` 太长 → 调用方（另一个插件）一直等，可能连带超时
- `message` 太长 → 这个会话被占住的时间变长

**更好的做法是别让初始化变重**：

```js
// ❌ 启动时加载全部模型
async initialize() {
  await loadAllModels()     // 40 秒，容易超时
}

// ✅ 按需加载
async initialize() {
  return { api_version: '1.0' }    // 秒回
}
async call_tool({ name, args }) {
  if (!cache.model) cache.model = await loadModel()   // 第一次调用才加载
}
```

**第一次调用会慢**，但可以用 `host.background` 预热：

```js
async initialize() {
  host.background(null, '预热模型', async () => {
    cache.model = await loadModel()
    host.log('info', '模型预热完成')
  })
  return { api_version: '1.0' }
}
```

## 6.19a 加载顺序：`load_order`

**问题**：服务 B 的 `initialize` 要调服务 A，但按 id 字母序 B 可能先起来。

**解法**：给 A 设一个更小的 `load_order`。

```toml
# canvas/manifest.toml
id = "canvas"
kind = "service"
load_order = 10      # 数字小的先加载
provides = ["canvas.render@1"]
```

```toml
# llm/manifest.toml
id = "llm"
kind = "service"
load_order = 20      # 比 canvas 晚
provides = ["llm.chat@1"]
```

**规则**：

| 情况 | 顺序 |
|---|---|
| 都有 `load_order` | 小的先 |
| 都没写 | 默认 `0`，按 id 字母序 |
| 想比默认更早 | **用负数** |
| 值相同 | 按 id 字母序 |

**⚠️ 坑**：默认是 `0`。想让某个服务**比普通插件更早**起来，得设**负数**：

```toml
load_order = -20     # ✅ 比默认的 0 早
load_order = 10      # ❌ 比默认的 0 晚，反而更后
```

**框架里的约定**（看现有插件就知道）：

| 值 | 含义 |
|---|---|
| `-20` | 最基础（canvas：字体 + 渲染） |
| `-10` | 依赖前者的（llm） |
| `0` | 默认（普通插件） |
| `>0` | 明确想晚起的 |

**两轮加载仍然优先**：service 和"被 requires 点名的插件"还是第一批，
普通插件第二批。`load_order` **只在同一批内起作用**。

**什么时候真的需要**：

```js
// B 的 initialize 里就要调 A
async initialize() {
  const r = await host.capability('a.thing', {})   // 这时 A 必须已经起来了
}
```

如果 B 是**运行时才调**（大多数情况）：

```js
async handle_message() {
  const r = await host.capability('a.thing', {})   // 这时早就都起来了
}
```

**就不需要设**。

**和 `[[commands]].priority` 的区别**：

| 配置 | 作用 |
|---|---|
| `load_order` | **启动顺序**（谁先 initialize） |
| `priority` | **分发顺序**（消息先给谁） |

## 6.19c 服务并发限流

**问题**：多个插件同时调同一个服务时，请求全打过去。
Python SDK 是**同步逐条处理**的，慢请求会把后面的全排住，调用方 15 秒后超时——
报的是"超时"，实际是"提供者忙不过来"。

**解法**：提供者在 manifest 里声明并发上限。

```toml
id = "my-service"
kind = "service"
provides = ["my.thing@1"]

[[capability]]
name = "my.thing"
max_concurrent = 2      # 最多同时 2 个调用，多的排队
```

**行为**：

| 情况 | 结果 |
|---|---|
| 有空位 | 立刻进入 |
| 满了 | **排队等待**（受调用方超时控制） |
| 等到超时 | 返回 `CodeRateLimited`（不是 `CodeTimeout`） |

**错误码分开的意义**：调用方看到 `RateLimited` 知道是"忙"，可以稍后重试；
看到 `Timeout` 会以为是"服务坏了"。

**怎么定上限**：

| 服务类型 | 建议 |
|---|---|
| **Python 服务** | `1`（它是同步逐条处理的） |
| Node 服务，无共享状态 | `4` ~ `8` |
| Node 服务，有共享状态 | `1` 或加锁后再放开 |
| 调外部 API 有限速 | 按对方的限制设 |
| 加载模型推理 | `1`（显存有限） |

**不写 `max_concurrent`** = 不限制（默认行为，向后兼容）。

**同一个服务的不同能力各有各的名额**：`max_concurrent` 按 `能力名` 区分，
不是整个服务共用一把锁。

**和插件级 `concurrency` 的区别**：

| 配置 | 限制谁 |
|---|---|
| `concurrency = "session"` | **入站**：几个群的**消息**能同时进这个插件 |
| `max_concurrent` | **出站**：几个**调用**能同时打向这个服务 |

## 6.20 并发：谁和谁会排队

### 一句话结论

**不同插件之间永远不排队**；同一插件内部要不要排队，看 `concurrency`。

### 默认：整个插件串行

```toml
# 不写 concurrency 就是这个
```

**行为**：这个插件的 `handle_message` 一次只跑一个。

**为什么默认串行**：插件作者通常不处理并发，两个消息同时进来改同一个变量，
状态就乱了。串行是最安全的默认。

**代价**：两个群同时调它，**第二个要等第一个跑完**。

**实测**（一个 `sleep 2000` 的插件，两个群同时调）：

```
plugin 模式：  群A 2070ms + 群B 2730ms，总 5549ms   ← 排队
```

### 按会话并行：`session`

```toml
concurrency = "session"
```

**行为**：同一个群（或私聊）内部串行，**不同群之间并行**。

**什么时候用**：插件是"每个群独立做事"的——比如每群一个抽签、每群一个提醒列表。

**实测**（同样两个群同时调）：

```
session 模式： 群A 2038ms + 群B 2039ms，总 3118ms   ← 并行
```

**注意**：不同群并行意味着**同一个插件进程会同时处理多条消息**。
如果插件里有共享状态（模块级变量、写同一个文件），要么加锁，要么别开这个模式。

### 哪种模式并发表现更好

**`session` 更好**，实测（两个群同时调一个睡 2 秒的插件）：

```
plugin 模式：  5549ms   ← 一个等一个
session 模式： 3118ms   ← 同时跑
```

**但 `session` 有前提**：插件必须**不依赖跨会话的共享状态**。
如果你有模块级变量、写同一个文件、或者调外部 API 有速率限制，就用默认的 `plugin`。

**一句话**：

| 你的插件 | 选什么 | 并发表现 |
|---|---|---|
| 纯查询、无共享状态 | `session` | **最好**（不同群并行） |
| 有共享状态 / 有外部限速 | `plugin`（默认） | 串行，但不会错乱 |
| 长交互（`host.ask`） | `session` | 等待时不拖累别的群 |

**别为了追求并发乱开 `session`**——插件里两个群同时改同一个变量而没加锁，
会出现"改着改着数据变了一半"的怪问题，很难查。

### 怎么选

| 插件做什么 | 建议 |
|---|---|
| 查询类（天气、运势、翻译） | `session`（不同群互不影响） |
| 有共享状态（计数器、全局配置） | **默认** `plugin`（最安全） |
| 每群独立状态（每群一个抽奖） | `session` |
| 调外部 API 且对方有速率限制 | `plugin`（天然限流） |

### 和冷却的关系

**冷却**（`[cooldown]`）是"同一个用户/群在 N 秒内只处理一次"。
**并发**是"不同群能不能同时跑"。

两者独立：

```toml
concurrency = "session"    # 不同群可并行

[cooldown]
per_user = "3s"            # 但同一个用户 3 秒一次
per_group = "1s"           # 同一个群 1 秒一次
```

### 定时任务和消息共享同一把锁

`run_task` 也走同一把锁——任务的 `plugin.run_task` 正在跑时，
这个插件的消息会等它（反之亦然）。

**所以定时任务别做太慢的事**：超过 2 分钟会被超时打断，但期间消息一直在等。

## 6.21 冷却、取消和失败反馈

这三件事都是**宿主统一做的**，插件不用自己写。

### 冷却：别让用户刷屏

在 manifest 里声明：

```toml
[cooldown]
per_user   = "3s"    # 同一用户对同一插件，3 秒一次
per_group  = "1s"    # 同一群对同一插件，1 秒一次
per_plugin = "0s"    # 整个插件全局（0 或不写 = 不限制）
```

**三个维度可以叠加**，任何一条没到时间就跳过。

**冷却期是静默的**——不发"慢点"，因为刷屏时每条都回一句更吵。

**为什么放宿主**：
- 每个插件自己写，写法不统一
- 用户可以靠换插件绕过单插件的限制
- 宿主统一后，一个配置管所有

**控制台能看到**：虚拟群的追踪里会显示

```
✗ 冷却「回声」— 还需 2 秒
```

### 交互能取消

`host.ask` 等待时，用户发这些词会**取消等待**：

```
取消 / cancel / 退出 / 算了 / 不弄了
```

取消后 `ask` 返回空字符串，插件按"没回答"处理：

```js
const name = await host.ask(chat, '请输入名字：', { timeout_sec: 30 })
if (!name) {
  await host.reply(chat, '已取消')
  return { handled: true }
}
```

**取消优先于一切**——即使有插件能处理"取消"两个字，交互等待中的用户优先。

**注意**：取消词是**精确匹配**（`取消订单` 不算取消）。

### 失败时给用户一句人话

以前插件不认领就**完全静默**，用户不知道是"没这个命令"还是"没权限"还是"机器人挂了"。

现在带前缀的命令失败时，宿主会回一句：

| 情况 | 用户看到 |
|---|---|
| 权限不够 | `你没有权限使用这个命令` |
| 插件超时 | `处理超时了，稍后再试` |
| 没有这个命令 | `没有这个命令，发 /help 查看全部指令` |

**没带前缀的普通聊天不会被打扰**——不然群里每句闲聊都回一句"没有这个命令"就太烦了。

**插件报错不刷到群里**：插件抛异常时，宿主只记日志和控制台，**不会把异常堆栈发到群里**。

### 三种反馈对应的用户动作

| 反馈 | 用户该做什么 |
|---|---|
| 你没有权限 | 找管理员加白名单 |
| 处理超时 | 等一会儿再试 |
| 没有这个命令 | 发 `/help` 看有哪些 |

**这就是为什么要分开说**——三种情况用户的下一步完全不同。

---

## 6.21a 发送超时：别盲目重试

**框架能保证的**：

| 阶段 | 行为 |
|---|---|
| 排队中（还没发） | 调用方超时 → **任务取消，不会发出** |
| 正在发送（已开始） | **无法取消**——发出去没有是不确定的 |

**所以插件要记住**：

```js
// ❌ 危险：超时后重试可能发两条
const r = await host.reply(chat, "长消息")
if (r.error) {
  await host.reply(chat, "长消息")   // 可能重复
}

// ✅ 安全：超时当作"可能发出去了"，不要盲目重试
try {
  await host.reply(chat, "长消息")
} catch (e) {
  // 超时错误：可能已经发出，也可能没有
  // 要么不重试，要么用幂等的方式（消息里带唯一 ID 让用户判断）
  host.log('warn', '发送超时，可能重复：' + e.message)
}
```

**为什么框架不能保证**：发送是对外部系统的调用，
"发出后没收到回执"和"根本没发出"在协议层面无法区分。
这是分布式系统的固有问题，不是框架缺陷。

**需要"只发一次"的场景**：
- 消息里带唯一标识（如订单号），让用户能识别重复
- 或者先写本地记录再发，收到回执后标记

## 6.22 插件进程的资源清理

**框架负责的**：

| 资源 | 回收方式 |
|---|---|
| 插件主进程 | 停用时杀掉 |
| 插件起的子进程 | **整棵进程树一起杀**（`taskkill /T` / 进程组） |
| 等待中的宿主请求 | 停用时取消 ctx，不等它自己超时 |
| `host.ask` 登记 | 停用时清掉 |

**框架不负责的**：

- **插件写到磁盘的文件**（你自己清理）
- **插件连的外部连接**（数据库、WebSocket，关进程时会断，但优雅关闭要自己实现）

**插件该做的**：

```js
serve({
  async initialize() {
    // 起 sidecar / 连数据库
    sidecar = spawn('worker')
  },
  async shutdown() {
    // 优雅关闭：框架会等这个返回再杀进程
    sidecar.kill()
    await db.close()
  },
})
```

**`shutdown` 有 5 秒预算**——超时会被强杀。

**外部进程如果不用 `shutdown` 清，框架也能收**（进程树回收），
但那是"强杀"，不是优雅退出。需要保存状态的场景自己写 `shutdown`。

## 7. 代码规范

### 7.0 能用哪些接口

插件通过 `sdk/node/qixin.mjs` 的 `host` 对象调用宿主，**完整签名见 [API.md](./API.md)**：

```js
import { serve, host, chatOf } from '../_sdk/qixin.mjs'

host.reply(chat, segments, replyTo)      // 回复当前会话
host.sendMessage(chat, segments)         // 发到任意会话
host.callOnebot(action, params)          // 直通协议端（受 permissions 限制）
host.capability(name, args)              // 调别的插件的工具
host.checkPermission(pluginId, session)  // 问：这个用户能用那个插件吗
host.listAccess()                        // 拿所有插件的权限配置
host.storage.get / set / delete / list   // 私有 KV
host.log(level, message, fields)         // 日志（走 stderr）
```

**不要直接 require 宿主内部模块，也不要 require 别的插件**。跨边界操作只能走上面的接口，否则权限、超时、审计全部失效。

### 7.1 最小插件

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

其余方法（`initialize` / `ping` / `shutdown` / `handle_event` / `list_tools` / `get_settings` / `set_settings` / `call_tool`）**都有默认实现**，按需覆盖。

### 7.2 回复

**Markdown 不用自己转**。框架在发送前统一处理 text 段：

| 输入 | 发出 |
|---|---|
| `**粗体**` | `粗体` |
| `*斜体*` | `斜体` |
| `# 标题` | `标题` |
| `- 列表` | `• 列表` |
| `` `code` `` | `code` |
| `[文字](url)` | `文字` |

保守规则：`2*3*4`、`snake_case_name` 不会被误伤。

关掉：`[command] markdown = "off"`。



```js
await host.reply(chatOf(session), '收到')                     // 普通消息
await host.reply(chatOf(session), '收到', session.message_id) // 引用回复
```

**是否引用由插件决定**。指令类回复一般不用引用。

返回值只有 `{ handled: bool }`。

### 7.3 错误

- `handle_message` 抛错 → 宿主记日志，继续下一个插件。
- `host.reply` 可能失败（限频、禁言），要 catch。
- 工具返回 `{ ok: false, error }`，不抛。

### 7.3a 自带页面：`web/panel.html`

插件的业务页面**放在插件里**，不要指望框架给你单独做一个页面。

```
dist/my-plugin/web/panel.html    ← 直接内联到插件详情页（/plugin/<id>/）
```

**它在页面里的位置**：紧跟在「设置」下面（标题「扩展」）——
最近的交互放前面，指令和工具表在它下面（工具默认折叠）。

**能干什么**：

- 用同源 `fetch` 调**任何**已声明能力：`POST /api/capabilities/call`
  （表单字段 `name` + `args`）
- 用页面里已有的 CSS 类：`form-box` / `table` / `tag` / `muted` / `primary` / `danger`

**不要干什么**：

- 别把业务数据做进框架的 Go 页面里——框架只提供通用容器；
  插件换存储、换结构时，框架页面就成了要跟着改的死代码。
- 别引用外部 CDN（离线部署会白屏）。

**反例**：曾经把「人设管理」做成了框架页面 `/personas`，
结果它直接调 `ai.persona` 能力、还得跟着插件改。现在挪回
`ai-chat/web/panel.html`，框架侧一行代码都不留。

### 7.4 日志

```js
host.log('info', '查询成功', { city, ms: 120 })
```

**禁止 `console.log`**——stdout 是协议通道。适配器会重定向，但别依赖这个。

**级别会被尊重**：`debug` / `info` / `warn` / `error` 分别落到对应级别，
`info` 及以上写进 `data/bot.log`，`debug` 只在控制台的日志页可见。

**`fields` 为空就不输出**——别为了"占位"传个空对象。

**别用日志刷屏**：

```js
// ❌ 每轮心跳都打一条 info：30 秒一条，一天 2880 条，
//    真正的消息日志全被挤没了
async run_task({ task }) {
  host.log('info', `定时任务执行: ${task}`)
}

// ✅ 成功不吭声，异常才说话（框架已经会记「定时任务失败」）
async run_task({ task }) {
  try {
    await doWork()
  } catch (e) {
    host.log('error', `定时任务 ${task} 失败: ${e.message}`)
  }
}
```

**排查时最该看的两条日志**（框架打的，INFO 级）：

```
收到消息        scope="group 123" user=10001 text="/天气 北京"
消息已交给插件   plugin=weather scope="group 123" user=10001 ms=42
```

第一条说明消息进来了，第二条说明谁接手、花了多久。
**只有第一条没有第二条** = 没有插件认领（命令写错了、或被权限/冷却拦了）。

### 7.5 超时

| 调用 | 超时 |
|---|---|
| `handle_message` | 30s |
| `call_tool` | 8s |
| `ping` | 3s |

长任务先回执，后台跑完再 `host.send_message`。

### 7.6 禁止

- ❌ `require` 其他插件的文件
- ❌ 自己写 `config.json` 当配置源
- ❌ 往 `app/` 写文件（升级会覆盖）
- ❌ 往 stdout 打非协议内容
- ❌ 在 `handle_message` 里跑几十秒的同步任务

---

## 7.9 依赖怎么打包

**自动的**：`qixinpack pack` 会把插件目录下的所有文件打进去，包括 `node_modules/`。

```powershell
cd my-plugin
npm install --omit=dev            # 只装生产依赖
.\bin\qixinpack.exe pack . -out ..\my-plugin.anzu
```

目录结构：

```
my-plugin/
├── manifest.toml
├── app/index.js
├── assets/              ← 素材
└── deps/
    └── node_modules/    ← 依赖
```

### 为什么放在插件根目录

Node 从 `app/index.js` 向上找 `node_modules`：

```
app/index.js → app/node_modules（没有）→ my-plugin/node_modules（有）✓
```

所以放在 `deps/node_modules/`，框架会自动设 `NODE_PATH`。

> **别放 `app/node_modules/`**——虽然 Node 也能找到，但和目录约定不一致，
> 换插件作者时容易搞混。

### 三个注意点

1. **`npm install --omit=dev`** —— 别把测试依赖打进去，包会大一倍
2. **单文件 32MB 上限** —— 超过会报错，大二进制建议用 `[runtime]` 声明外部依赖
3. **原生模块要装对平台** —— `better-sqlite3` 这类在 Windows 编的，拿到 Linux 跑不了

### 非 Node 插件的依赖

- **Python**：`pip install -t deps/python`，框架自动设 `PYTHONPATH`
- **二进制**：放 `deps/bin/`，框架自动加进 `PATH`；或 `exec = ["./deps/bin/xxx"]`
- **大依赖**（ffmpeg）：不放包里，用 `[[requires]]` 声明系统安装

---

## 8. 数据与依赖

- 数据写 `data_dir`（= 运行区的 `data/`）。
- 小 KV 用 `host.storage`（存在 `<data_dir>/storage.json`）。
- 依赖装进 `deps/`，Node 通过 `NODE_PATH` 找到；也可以 `npm install` 到 `app/node_modules`。

---

## 9. 命名规范

| 对象 | 规则 | 例子 |
|---|---|---|
| 包/插件 id | 小写单数 | `weather` |
| 命令 id | `<plugin>.<verb>` | `weather.query` |
| 工具 name | `<plugin>_<verb>` | `weather_query` |
| 设置 key | camelCase | `apiKey` |
| 存储 key | 带命名空间 | `count:20000` |

命令 id 一旦发布不要改——权限配置和日志都引用它。

---

## 10. 安装、启用、卸载

- 把 `.anzu` 丢进 `plugins/` → 自动解压到运行区 → **默认未启用**。
- 管理员在 WebUI 点「启用」才真正启动进程。
- 删除 `plugins/xxx.anzu` → 自动停止，运行区目录被改名到 `.removed-*`（数据保留）。
- WebUI 的「删除」会同时删包和运行区目录。

---

## 11. 签名与打包

```bash
qixinpack keygen -out mykey
qixinpack pack ./weather -out weather.anzu -key mykey.priv
qixinpack check weather.anzu -pub mykey.pub
```

框架配置 `[plugin] trusted_keys` 后，只接受签名有效的包。详见 [ANZU.md](./ANZU.md)。

---

## 11.5 第三方怎么签名

**先看这张表，它决定了你该走哪条路**：

| 你的目的 | 用谁的密钥签 | 用户要做什么 |
|---|---|---|
| 自己用（不发布） | **你自己的** | 把你的公钥加进他自己的框架（一次） |
| 发到官方仓库 | **官方密钥**（不是你的） | **什么都不用做** |
| 自己发布、别人自己装 | **你自己的** | 每个用户各自加一次你的公钥 |

**三条关键结论**：

1. **官方插件用官方密钥签，用户的框架内置了这个公钥**——
   所以新增官方插件时**用户不需要改任何配置，也不需要升级框架**。
   换官方密钥才需要发新版本（这是刻意的：换密钥要留痕）。

2. **自用密钥不会离开你自己的机器**。你把它贴进自己控制台的
   「可信签名者」，只影响这一台部署——不会上传、不会同步给别人。

3. **想进官方仓库，就不能用你自己的密钥**。PR 合并由维护者
   **用自己的官方私钥重签**，并跑 `package.ps1 -Key` 做硬校验：
   官方仓库里只要有一个包不是官方签的，打包直接失败。

### 发布到官方仓库的流程

```text
1. 你把插件源码提 PR（src/<id>/，不签名也行）
2. 维护者审核代码（权限配置、超时、日志、资源占用）
3. 合并时用官方私钥重新打包：
      .\tools\package.ps1 -Key plugin-signing.priv
   它会逐个校验：15 个包必须全部是官方指纹签的
4. 发布 → 用户的框架开箱就能装，零配置
```

**为什么不让你自己签了直接进仓库**：官方仓库代表"官方背书"。
如果混进一把非官方密钥，用户装的时候会被自己的框架拒掉，
还得手动加公钥——那"官方"就没意义了。

**签名不是"用官方私钥"**——每个开发者用自己的密钥，管理员决定信任谁。

### 开发者这边：三步

```powershell
# 1. 生成你自己的密钥对（只做一次）
qixinpack keygen -out mykey
# 产出 mykey.priv（保密）和 mykey.pub（公开）

# 2. 打包时签名
qixinpack pack my-plugin -out my-plugin.anzu -key mykey.priv

# 3. 把公钥发给管理员
#    mykey.pub 的内容就一行 base64
```

**私钥绝不能给别人**——给出去等于让别人能冒充你发插件。

### 管理员这边：加进信任列表

**两种方式，效果一样**：

**① 控制台（推荐，立刻生效）**

插件页 →「可信签名者」→ 把公钥贴进去 → 添加。**不用重启**。

**② 配置文件（要重启）**



```toml
[plugin]
trusted_keys = [
  "UkVeBEDsEKbcwm+2bsVgk1zhwj78z74x5ygnG2E7+9I=",   # 官方
  "h7V5TLuIbMJowmWZtptlgmjwC6QICt9Cqkfdx0fl4uQ=",   # 某个第三方
]
```

**数组可以放多个**——信任谁就加谁的。

**加完重启框架生效**。

### 包自己带签名者公钥

`qixinpack pack -key` 会把**签名者公钥**写进 `META-INF/signer.pub`。

好处：管理员不用先拿到 `.pub` 文件才知道是谁签的。

```powershell
qixinpack check third-demo.anzu
# 签发者: 指纹 8c28e335b50afd34（公钥已随包携带）
```

上传被拒时也会带上：

```
签名校验失败: 签名不匹配任何可信公钥
（签发者指纹 8c28e335b50afd34，公钥 l6P62dbu...；信任它就把这串加进 trusted_keys）
```

**公钥随包 ≠ 自动信任**。包里带的是"我声称我是谁"，
框架只认 `trusted_keys` 里有的那些——否则谁都能塞个木马包。

### 信任列表存在哪

| 来源 | 位置 | 怎么改 |
|---|---|---|
| 配置文件 | `config.toml` 的 `[plugin] trusted_keys` | 改文件 + 重启 |
| **控制台热加** | `data/trusted-keys.json` | 插件页点一下，**立刻生效** |

**两者合并生效**。config 里的不能在控制台删（会提示你去改文件），
热加的可以随时移除。

### 怎么核对"这个包是谁签的"

```powershell
qixinpack check my-plugin.anzu -pub mykey.pub
```

```
签名: 有效（签发者指纹 421fdda94e09c5e2）
```

**指纹是公钥的 SHA256 前 8 字节**。管理员拿到包和公钥后，
用这条命令核对——指纹对得上，才往 `trusted_keys` 里加。

### 签名不加密，源码本来就公开

**插件装到你机器上就是明文**：

```
data/plugins/<id>/app/index.js    ← 带注释的 JS，能直接读
```

所以签名只回答两个问题：**谁发的**、**有没有被改过**。
它**不负责保密**。

想要保密只有三条路（详见 `ANZU.md` §6）：

| 做法 | 强度 | 代价 |
|---|---|---|
| 用 Go/Rust/C# 写，`app/` 放二进制 | 高 | 跨平台分别构建、失去热重载便利 |
| esbuild 打包 + 压缩 | 低 | 挡不住决心看代码的人 |
| 核心逻辑放服务端，插件只是个壳 | 高 | 要维护服务、离线不可用 |

**上架官方仓库等于源码公开**（`src/` 就是源码）。
如果你的插件要闭源收费，走自己的分发 + 用户自己加公钥。

### 为什么不能"自助信任"

**签名的作用是"证明包来自谁"**，不是"证明包安全"。

如果框架看到包里带的公钥就自动信任，**攻击者随便生成一个密钥签个木马，
框架也会接受**——签名就完全没意义了。

**所以必须管理员手动加**：

```
包 + 公钥 → 管理员核对指纹 → 加进 trusted_keys → 框架才接受
```

### 不签名行不行

**行**——管理员不配 `trusted_keys` 时，框架不校验签名（开发模式）。

**但生产环境建议配上**：至少能防止"插件包在传输中被替换"。

### 开发模式：允许未签名

配了 `trusted_keys` 之后，**自己写的插件没签名**会装不上。开发时打开这个开关：

```toml
[plugin]
trusted_keys = ["..."]
allow_unsigned = true   # 允许没签名的包（开发用）
```

**它只放行"没签"，不放行"签错"**：

| 情况 | `allow_unsigned=false` | `allow_unsigned=true` |
|---|---|---|
| 签名有效 | ✅ 装 | ✅ 装 |
| **没签名** | ❌ 拒绝 | ✅ 装（日志警告） |
| **签名无效** | ❌ 拒绝 | ❌ **仍然拒绝** |

**为什么签名无效始终拒绝**：那说明包被改过，或者用错了密钥——
放行它等于签名白配了。

**生产环境记得关掉**（`false` 或不写），否则谁都能塞个未签名插件进来。

### 常见问题

**Q：我用官方私钥签行不行？**
不行，你没有（也不该有）。**用自己的**。

**Q：签名了但框架说"签名校验失败"？**
说明管理员没把你的公钥加进去。把 `mykey.pub` 发给他。

**Q：同一个插件换了密钥重新签名，会怎样？**
管理员要把新公钥加进去（旧的可以留着），否则新包会被拒。

**Q：签名能防止插件被篡改吗？**
能——**改了包内容签名就对不上**。但**不能防止恶意插件**（它本来就是恶意的，
签名只证明"是谁提交的"）。

## 12. 闭源

JS/Python 源码放进包就能看。真正的保护只有编译成二进制：

```toml
closed_source = true
exec = ["app/weather.exe"]
```

`closed_source` 只是标记，WebUI 会显示「闭源」标签。详见 [ANZU.md](./ANZU.md) 第 6 节。

---

## 13. 反模式

| 反模式 | 后果 | 正确做法 |
|---|---|---|
| 在 handler 里下载大文件 | 超时 | 先回执，后台任务 |
| 用 `console.log` | 协议崩 | `host.log` |
| 状态写进 `app/` | 升级丢失 | `data/` 或 `host.storage` |
| 一个插件注册 20 条命令 | help 刷屏 | 用子命令 |
| 所有插件都要 `onebot.admin` | 一破全破 | 最小权限 |
| 捕获异常后静默 | 用户等不到回复 | 打日志 + 提示 |
| `usage` 里写 `/` | 配了前缀就永远不触发 | 交给框架加，加载时会自动剥 |
| `require_prefix = false` 却不配 `allow_users` | 陌生人能控家电 | 有副作用就配白名单 |
| 自己 `setInterval` 做定时 | 重启丢失、WebUI 看不见 | `[[schedule]]` + `run_task` |
| 自己建文件存状态 | 路径乱、备份漏 | `host.storage` |
| 推送时传 `account: 'main'` | 多账号或改名就坏 | 不传，框架用默认账号 |
| 带原生模块却不写 `platform` | 换系统启动崩 | `[runtime] platform = "..."` |
| 界面文案写英文 | 群友看不懂 | 给人看的用中文，标识符用英文 |
| 列表输入用逗号分隔 | 和别的插件不一致 | 统一用 `|` |
| 用 `require_prefix = false` 自己解析自然语言 | 正则覆盖不全 | 交给 AI 工具 |
| 插件里读别人的配置文件 | 耦合、容易坏 | `host.shared.get` 或能力调用 |

---

## 14. 自测清单

### 14.1 打包前

- [ ] `manifest.toml` 和 `app/` 齐全
- [ ] 装进 `plugins/` 后 WebUI 状态是「未启用」
- [ ] 启用后日志出现「插件已就绪」
- [ ] `/help` 能看到它（或明确 hidden）
- [ ] 命令能触发、能正常回复
- [ ] 设置页能打开、能保存、改动立即生效
- [ ] 删除插件后正确停止
- [ ] 重启后状态和数据都在
- [ ] stdout 没有乱输出

### 14.2 命令与触发

- [ ] `usage` **不带前缀**（写了也会被自动剥，但别依赖）
- [ ] 固定子命令拆成多条 `[[commands]]`，自由参数用一条
- [ ] `require_prefix` / `require_mention` 想清了下限语义
- [ ] `require_prefix = false` 的插件，`handle_message` 第一行就做快速判断
- [ ] 带前缀和不带前缀都测过
- [ ] 群里 @ 和不 @ 都测过

### 14.3 权限

- [ ] 有副作用的操作配了 `allow_users`
- [ ] 陌生人触发时是**静默拒绝**（不回话、不暴露规则）
- [ ] 拒绝有日志（`host.log('info', ...)`），但不给用户看
- [ ] 服务插件（llm/sqlite）不需要命令权限，确认没被误配

### 14.4 数据与依赖

- [ ] 状态存 `host.storage` 或 `data/`，不写 `app/`
- [ ] 定时任务用 `[[schedule]]`，不自己 `setInterval`
- [ ] 推送不传 `account`（交给框架）
- [ ] 带原生模块的包写了 `platform`
- [ ] 包里没有 `node_modules/.cache`、测试文件、`.git`

### 14.5 界面

- [ ] 插件名称、描述、设置项标签是**中文**
- [ ] 指令说明读得懂（群友视角）
- [ ] 列表类输入支持 `|` 分隔
- [ ] 错误提示说「怎么办」，不是只说「错了」
- [ ] 面板里的按钮点了有反馈（成功/失败都提示）

### 14.6 AI 相关（如果插件提供工具）

- [ ] `[[tools]]` 的 description 说清「用户问什么时调用」
- [ ] 工具参数有类型和说明
- [ ] 工具失败时返回 `{ ok: false, error }`，不抛异常
- [ ] 工具不依赖会话外的东西（AI 可能在任意会话调用）
- [ ] 有副作用？（关灯、发消息）→ 确认 `CallTool` 的权限已生效

## 15. 完整示例

仓库里 `dist/echo` 和 `dist/weather` 是可直接打包的源目录：

- `dist/echo/` —— 最小插件（命令 + 存储）
- `dist/weather/` —— 命令 + 工具 + 设置页
