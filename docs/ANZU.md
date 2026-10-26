# .anzu 插件包规范

- 版本：1
- 日期：2026-10-24
- 关联：[PLUGIN.md](./PLUGIN.md)、[PROTOCOL.md](./PROTOCOL.md)

---

## 1. 为什么改

旧方案把插件当目录丢进 `plugins/`，带来三个问题：

1. **依赖没地方放**：`node_modules` 混在源码里，升级会覆盖，删不干净。
2. **设置页没地方放**：插件想带自己的 HTML 只能塞代码目录。
3. **分发不可信**：谁都能改一行代码重新打包，装的人不知道。

`.anzu` 把"插件"变成一个**不可变的投放单位**：包是只读的，解压后进运行区，一切都可追溯。

---

## 2. 包格式

`.anzu` 就是一个 zip（改后缀，防止被解压工具抢走）。结构固定：

```
weather.anzu
├── manifest.toml            必需，清单位于根目录
├── app/                     必需，插件本体
│   └── index.js             入口（由 exec 指定）
├── deps/                    可选，依赖
│   └── node_modules/        原样拷进运行区
├── web/                     可选，设置页
│   ├── index.html           入口
│   └── style.css
└── META-INF/                可选，签名
    ├── manifest.sha256      文件完整性清单
    └── signature.ed25519    对 manifest.sha256 的签名
```

规则：

- 顶层**不允许**再套一层目录（旧的 `weather/plugin.toml` 结构会被自动剥掉一层）。
- `META-INF/` 不参与哈希计算。
- 路径不能是绝对路径、不能含 `..`、不能是符号链接。
- 解压后总大小上限 256MB，文件数上限 5000。

---

## 3. manifest.toml

在原来的基础上新增三项：

```toml
id = "weather"
name = "天气"
version = "1.0.0"
apiVersion = "1.x"

# 相对运行区根目录；app/ 下
exec = ["node", "app/index.js"]

# 可选：设置页入口，相对运行区根目录
web = "web/index.html"

# 可选：作者标记这是构建产物，不含源码
closed_source = false

description = "查询城市天气"
permissions = ["onebot.write"]

[[commands]]
id = "weather.query"
usage = "/weather <城市>"
description = "查询指定城市的天气"

[[settings]]
key = "apiKey"
label = "API Key"
type = "password"
```

`exec` 的**第一个元素相对运行区根解析**（或系统命令名；进程工作目录就是运行区根，
所以 app 下的脚本要写全 `app/index.js`）。运行区布局是：

```
data/plugins/weather/
├── app/      ← exec 里 app/index.js 这种路径从这里算（工作目录是运行区根）
├── deps/     ← 自动加入模块搜索路径
├── data/     ← 插件私有数据，升级不动
├── web/      ← 设置页
└── install.json
```

Node 插件的模块解析顺序：插件自己的 `app/node_modules` → 包内的 `deps/node_modules`。所以 `npm install` 装到 `deps/` 就能被找到。

---

## 4. 签名

### 4.1 算法

- **ed25519**（Go 标准库直接支持，无依赖）
- 私钥只在发布者手里，公钥写进框架配置

### 4.2 计算方式

1. 遍历包内除 `META-INF/` 外的所有文件，按路径字典序排序
2. 生成 `META-INF/manifest.sha256`，每行 `<sha256>  <相对路径>`
3. 对 `manifest.sha256` 的**原始字节**做 ed25519 签名
4. 结果写入 `META-INF/signature.ed25519`（64 字节裸二进制）

签名不覆盖 `manifest.sha256` 自己（避免自引用），但它覆盖的清单里列出了所有文件，所以改任何一个文件都会导致校验失败。

### 4.3 框架侧校验

**可信公钥有三层来源**（合并生效）：

| 来源 | 存在哪 | 说明 |
|---|---|---|
| **官方** | 编译进二进制 | 装官方插件**零配置**；新增官方插件不用用户改东西 |
| 部署者 | `config.toml` 的 `[plugin] trusted_keys` | 额外信任（第三方作者的公钥） |
| 热加 | `data/trusted-keys.json` | 控制台贴一下，**立刻生效** |

| 情况 | 行为 |
|---|---|
| 签名有效且公钥被信任 | 安装 |
| 签名有效但公钥不受信任 | 拒绝，**报出签发者指纹**，方便管理员决定要不要加 |
| 没签名 | 拒绝（除非 `allow_unsigned = true`，开发用） |
| **签名无效** | **始终拒绝**（包被改过，或密钥不对） |

校验顺序：解签名 → 校验签名 → 逐文件比对哈希 → 解压。

### 4.4 签名不提供保密

**这一点必须说清楚**：插件包解压后就是明文源码。

```
data/plugins/weather/
├── app/index.js       ← 带注释的明文 JS
├── manifest.toml
└── web/index.html
```

签名解决的是**"这个包是谁发的、有没有被改过"**，不是"别人看不到代码"。

| 签名能做什么 | 签名做不到什么 |
|---|---|
| 证明来源（谁签的，可查指纹） | 隐藏源码（装完就能看） |
| 完整性（改一个字节就验不过） | 防止别人抄走改个名字再发 |
| 防供应链投毒（下载/传输被替换） | 防恶意插件（它本来就是恶意的） |

**这是刻意的**：插件跑在你的机器上、能读你的数据，
**你有权看它到底在干什么**。加密只会让审计变成不可能，而不是让它变安全。

真要保密，看 §6。

公钥用打包工具生成：

```bash
qixinpack keygen -out mykey
# 生成 mykey.priv（私钥）和 mykey.pub（公钥，一行 base64）
```

---

## 5. 安装与卸载

### 5.1 安装

```
plugins/weather.anzu 出现
  → 读 manifest 拿 id
  → 校验签名（按配置）
  → 解压到 data/plugins/.staging-<id>-<ts>/
  → 校验 app/ 存在、exec 指向的文件存在
  → 原子 rename 到 data/plugins/<id>/
  → 记录 install.json（包 hash、安装时间、来源文件名）
  → 标记为「未启用」
```

**默认未启用**是新包的强制行为。理由：装包和信任包是两件事，管理员看完信息再点启用。

`install.json`：

```json
{
  "id": "weather",
  "version": "1.0.0",
  "package": "weather.anzu",
  "package_sha256": "...",
  "signed": true,
  "installed_at": 1761200000
}
```

### 5.2 卸载

删除 `plugins/weather.anzu` → 框架检测到包消失：

1. 停止插件进程
2. 移除 Feature
3. **保留** `data/plugins/weather/`（数据不丢）

要彻底删除，走 WebUI 的「彻底删除」，才会连数据目录一起删。

### 5.3 升级

同名 id 的新包替换：停旧进程 → 解压新包 → `app/`、`deps/`、`web/` 整体替换 → `data/` 保留 → 启用状态保留。

---

## 6. 闭源怎么办

诚实说：**JS/Python 源码放进包，解压就能看**。加密没有意义——客户端一定有密钥，拿到机器上总能 dump。

三个现实选项，按强度排序：

| 方案 | 做法 | 强度 | 代价 |
|---|---|---|---|
| **编译成二进制** | 插件用 Go / Rust / C# 写，`app/` 里放 `.exe`，`exec` 指向它 | ★★★★★ | 失去热重载的意义（编译要时间），跨平台要分别构建 |
| **Bundle + 压缩** | esbuild 打成一个文件 + terser 压缩，去掉源码结构 | ★★☆ | 挡不住决心，但挡住了"随手翻代码" |
| **只分发构建产物** | 源码不进包，`app/` 只有 bundle 后的 `index.js` | ★★☆ | 同上 |

框架提供的能力：

- `closed_source = true` 只是**标记**，会在 WebUI 上显示"闭源"标签，方便管理员知道自己在信任什么。
- 打包工具支持 `--build` 参数：先跑 `esbuild`（如果装了）再打包。
- 真正的保护只有一个：**用编译型语言重写插件**。`exec` 支持任意可执行文件，所以这条路是通的。

**建议**：自己的插件不必纠结闭源；如果要分发或出售，用 Go 写插件本体，`app/` 放二进制。

### 6.1 上架官方仓库 = 必须开源

官方仓库的 `src/` 存的就是源码，`packages/` 里的包解压也是明文。
**想上架，就接受源码公开**——这不是限制，是官方仓库的性质：

| 你的诉求 | 能不能上架官方仓库 |
|---|---|
| 开源插件，希望用户零配置装 | ✅ 可以（推荐） |
| 闭源，但想让人用 | ❌ 不行（源码会公开）→ 自己发布，用户加你的公钥 |
| 闭源 + 收费 | ❌ 不行 → 编译成二进制，走自己的分发 |

**反过来也成立**：官方仓库里的每个包都能被任何人读代码——
这正是"官方"这个背书可信的原因之一。

---

## 7. 目录布局

```
qqbot/
├── config.toml
├── bin/qixinbot.exe
├── plugins/                       投放区：只放 .anzu，不放大文件
│   ├── weather.anzu
│   └── echo.anzu
└── data/
    ├── plugins/                   运行区：解压后的插件，一个插件一个目录
    │   └── weather/
    │       ├── app/               本体（代码或二进制）
    │       ├── deps/              依赖
    │       ├── data/              运行时数据（升级不动）
    │       ├── web/               设置页
    │       └── install.json       安装元信息
    ├── plugins-state.json         启用/禁用状态
    ├── overrides.json             权限与 /help 显示覆盖
    └── logs/
```

**为什么按插件分目录、而不是按类型分**：卸载/备份/迁移都是"一个目录"的原子操作。按类型分（`apps/`、`deps/`、`data/` 各一层）会导致删一个插件要动四个地方，备份要对齐四棵目录树，迟早出错。

---

## 8. 打包工具

```bash
# 生成密钥对（一次）
qixinpack keygen -out mykey

# 打包（自动生成 manifest.sha256 并签名）
qixinpack pack ./weather -key mykey.priv -out weather.anzu

# 不签名（开发用）
qixinpack pack ./weather -out weather.anzu

# 检查一个包
qixinpack check weather.anzu -pub mykey.pub
```

`pack` 的输入目录结构就是包内结构（`manifest.toml` + `app/` + `deps/` + `web/`）。

---

## 9. 开发工作流

包是只读的，但开发时不能每次改一行都重新签名。所以：

```bash
# 把开发目录挂进运行区（复制，不是软链，Windows 软链要管理员）
qixinpack dev ./my-plugin
# 等价于：清空 data/plugins/<id>/app，复制 ./my-plugin/app 过去
```

框架的热重载监听 `data/plugins/*/app`，复制完 2 秒内自动重载。

发布时再 `pack` 成 `.anzu`。
