# QixinBot 插件仓库

**所有官方插件**的源码和签名产物，加上**插件开发手册**。

配套框架：[QixinBot-go](http://10.0.0.140:30008/anzu/QixinBot-go)（源码）、[QixinBot-release](http://10.0.0.140:30008/anzu/QixinBot-release)（发行版）。

---

## 目录

```
src/       每个插件一个目录（源码）
packages/  签名好的 .anzu（直接丢进框架的 plugins/）
keys/      签名公钥（验证用；私钥不在仓库里）
docs/      插件开发手册
```

## 快速开始：装一个插件

```powershell
# 1. 把 packages/ 里的 .anzu 丢进框架的 plugins/
copy packages\weather.anzu <框架目录>\plugins\

# 2. 2 秒内框架会自动装好（默认禁用，去控制台点「启用」）
```

**或者用控制台的插件页**：有个上传按钮。

## 快速开始：写自己的插件

```powershell
# 1. 在框架目录里生成骨架
<框架目录>\bin\qixinpack.exe new my-plugin -name 我的插件

# 2. 写代码（app/index.js）

# 3. 起本地环境，边改边测
cd my-plugin
..\bin\qixinpack.exe dev . -watch

# 4. 浏览器打开 http://127.0.0.1:7801（admin/dev）
#    → 聊天 → 🧪 虚拟群 → 发消息看插件怎么回
```

**详细手册见 [docs/PLUGIN.md](docs/PLUGIN.md)**（和框架仓库的同一份，随版本同步）。

---

## 官方插件清单

| 插件 | 说明 | 依赖 |
|---|---|---|
| **ai-chat** | AI 聊天（接 llm 服务） | `llm.chat` |
| **bilibili** | B 站订阅（开播/视频/动态） | — |
| **canvas** | 画布服务（图片合成、字体管理） | — |
| **cngal** | 国 G 周报（长图） | `canvas.render` |
| **echo** | 回声（示例插件，最小骨架） | — |
| **fortune** | 运势抽签（23 个主题 + 图片） | `canvas.render` |
| **group-manager** | 群管理（欢迎/违禁词/禁言/踢人） | — |
| **home-assistant** | 智能家居控制 | — |
| **keyword-reply** | 关键词回复 | — |
| **llm** | LLM 服务（多后端） | — |
| **ncm-saying** | 网易云热评（可每日定时） | — |
| **selftest** | 自检（框架功能验证） | — |
| **status** | 服务器状态（CPU/内存/磁盘） | — |
| **trigger** | 关键词触发（正则 + 权重） | — |
| **ts3-tracker** | TS3 在线追踪 | — |
| **weather** | 天气查询 | — |
| **what2eat** | 今天吃什么 | — |

---

## 签名与发布规则

**这个仓库里的每个包，都由官方私钥签名**（同一把）。原因很简单：

- 用户的框架**内置了官方公钥** → 装官方插件**零配置**
- 如果混进一把别人签的包 → 用户的框架会**拒装**，还得手动加公钥
- 所以官方仓库 = 官方签名，不掺第三方密钥

### 维护者上架操作（三步）

```powershell
# 1. 把作者的源码放进仓库
#    src/<id>/（manifest.toml + app/ …），作者不需要签名

# 2. 用官方私钥重新打包（作者的密钥不参与）
.\bin\qixinpack.exe pack src/<id> -out packages/<id>.anzu -key plugin-signing.priv

# 3. 全量校验 + 发版（任何非官方指纹都会让打包失败）
.\tools\package.ps1 -Key plugin-signing.priv
```

**关键点**：作者的包/密钥都不需要。你从他的**源码**重签，
对外就只有一个签名者——官方。这样用户装任何官方插件都不用改配置。

### 你要提交插件怎么办

**你的密钥只在你自己机器上有用，不用给我**：

```text
① 自己用
   你签名 → 你把公钥贴进自己控制台 → 只有你能装

② 想进官方仓库
   提 PR（源码放 src/<id>/，不签名也行）
   → 维护者审核
   → 合并时用官方私钥重签并跑 package.ps1 -Key 硬校验
   → 用户开箱即用，零配置
```

**不要把自己的私钥发给我**（发了也没用：我不会用别人的钥匙签官方包）。
**也不要提一个"已经用你的密钥签好的包"**——它进不了官方 `packages/`，
因为打包校验会拒绝非官方指纹。

**所有 `packages/*.anzu` 都用同一个 ed25519 私钥签名**。

**公钥**（`keys/plugin-signing.pub`）：

```
UkVeBEDsEKbcwm+2bsVgk1zhwj78z74x5ygnG2E7+9I=
```

**框架里这样配**（`config.toml`）：

```toml
[plugin]
trusted_keys = ["UkVeBEDsEKbcwm+2bsVgk1zhwj78z74x5ygnG2E7+9I="]
```

配了之后：
- **签名的包** → 正常安装
- **没签名或签名不对** → 拒绝安装，日志里写原因

**没配 `trusted_keys`** = 不校验（开发模式）。

### 自己签名

```powershell
# 生成密钥对
qixinpack keygen -out mykey

# 签名打包
qixinpack pack my-plugin -out my-plugin.anzu -key mykey.priv

# 验证
qixinpack check my-plugin.anzu -pub mykey.pub
```

**私钥不要进 git**（仓库的 `.gitignore` 已经挡了 `*.priv`）。

---

## 贡献一个插件

1. **Fork 这个仓库**
2. **源码放 `src/<插件id>/`**（结构和 `dist/` 一样：`manifest.toml` + `app/` + 可选 `assets/`）
3. **本地测通**：`qixinpack dev src/<id> -watch`
4. **打包**：`qixinpack pack src/<id> -out packages/<id>.anzu -key <私钥>`
5. **改 README 的插件清单**
6. **提 PR**

**审核会看**：
- `manifest.toml` 的权限配置合不合理（别默认 `allow_all`）
- 有没有在 `handle_message` 里做长任务（该用 `host.background`）
- 有没有正确的错误处理（别让异常把插件搞崩）
- 资源占用（别把 100MB 图片塞进包里）

---

## 注意

**这个仓库的 `packages/` 是签名产物**，不要手工改里面的文件——改了签名就失效。
要改就改 `src/` 重新打包。

**`src/` 里的 `node_modules` 和 `data/` 不进仓库**（依赖用 `deps/` 打包，见手册 §7.9）。
