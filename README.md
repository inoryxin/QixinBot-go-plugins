<p align="center"><img src="/inoryxin/QixinBot-go/raw/branch/main/branding/logo-128.png" width="84" alt="QixinBot"></p>

# QixinBot 插件仓库

**所有官方插件**的源码和签名产物，加上**插件开发手册**。

配套框架：[QixinBot-go](/inoryxin/QixinBot-go)（框架源码 · 发行包 · 文档中心）。

---

## 目录

```
src/       每个插件一个目录（源码）
packages/  签名好的 .anzu（直接丢进框架的 plugins/）
keys/      签名公钥（验证用；私钥不在仓库里）
docs/      PC 管家与协议端文档
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

**详细手册见 Wiki「[插件开发手册](/inoryxin/QixinBot-go/wiki/插件开发手册)」**
（开头就是开发环境准备；同步从框架源文件更新）。

---

## 官方插件清单

（与 `src/`、`packages/` 一一对应； capability 依赖见各插件手册章节）

| 插件 | 说明 |
|---|---|
| **好感度**（ai-affinity） | 记住每个人和她的关系，供 AI 调整语气；带榜单和手动调整 |
| **AI 聊天**（ai-chat） | 会记住每个人的对话；人设由 ai-persona 插件提供，没装时用内置的 |
| **她的生活**（ai-life） | 模拟一个人一天在干什么，给 AI 聊天提供当前状态（在上班/在吃饭/困了） |
| **LLM 服务**（ai-llm） | 统一的 LLM 调用入口。其他插件通过能力调用，不各自配 key |
| **人设**（ai-persona） | 管 AI 的系统提示词和人设：说谁、怎么说话、群聊/私聊各用哪套；含贴吧鱼模式（按群开关，切换后改用吧友口吻 + 语料库抽样） |
| **主动发言**（ai-proactive） | 群里冷场太久时，她会主动开个话头（可设时段/概率/冷却） |
| **表情包**（ai-sticker） | 给 AI 聊天配表情包：情绪/场景标签、后台上传、远程表情库接管、自动偷表情包 |
| **发语音**（ai-voice） | 把文字转成语音发出去（微软 Edge 神经网络语音，本地 Python 合成） |
| **B站订阅**（bilibili） | 开播、视频、图文动态推送；支持二维码登录和 UP 主订阅 |
| **博客**（blog） | Typecho 一键发博客：连续输入、图片上传、AI 生成、发布并同步 QQ 空间 |
| **国 G 周报**（cngal） | 每周把 CnGal 的国 G 动态、即将发售、折扣画成一张长图发到群里 |
| **回声**（echo） | 把收到的内容原样返回 |
| **emoji 合成**（emojimix） | 把两个 emoji 合成一张图（Google Emoji Kitchen） |
| **运势抽签**（fortune） | 每日运势抽签（图片），支持 23 个主题，每人每天一次 |
| **群管理**（group-manager） | 欢迎新成员、退群通知、违禁词撤回、禁言/踢人。管理员可用。 |
| **智能家居**（home-assistant） | 控制 Home Assistant 里的灯、电脑、电热毯，查温湿度 |
| **禁漫下载**（jm-download） | 群友发漫画 ID 就后台下载整本、还原竖切、合成 PDF、打包上传；附今日JM/更新JM 信息图、按群开关 |
| **关键词回复**（keyword-reply） | 按关键词自动回复：精准/包含/开头/正则/模糊，可回文本、图片、语音 |
| **网抑云**（ncm-saying） | 随机来一条网易云音乐热评 |
| **电脑**（pc） | 一台 PC 一个管家：状态、截图、重启/睡眠/锁屏、唤醒 DSH 并把 QQ 聊天交给 DSH |
| **QQ 资料**（qq-profile） | 改昵称/签名/头像，发 QQ 空间说说，偶尔自己发伤感说说 |
| **抽小猪**（rollpig） | 抽取属于你的小猪：今日小猪、随机小猪、找猪（PigHub 图库） |
| **催睡**（sleep-guard） | 凌晨 5 点看主人设备还亮着就用 AI 私聊催睡，半小时后还不睡再催一次 |
| **服务器状态**（status） | CPU / 内存 / 磁盘 / 运行时长，支持 /status 和 /状态 |
| **关键词触发**（trigger） | 关键词 → HTTP 请求（GET/POST），支持模板回复和三层鉴权 |
| **TS3 在线**（ts3-tracker） | 查询 TeamSpeak 3 在线频道，支持进/退通知 |
| **祈歆状态**（watch） | 视奸祈歆 / 祈歆在干嘛 — 读取 home.inory.xin 状态页 |
| **今天吃什么**（what2eat） | 随机推荐吃的喝的，中午/晚上提醒吃饭，支持自定义菜谱 |
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
