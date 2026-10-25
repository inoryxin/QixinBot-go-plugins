# 禁漫下载（jm-download）

群友发来禁漫（JMComic）漫画 ID，机器人在后台下载整本、还原竖切打乱、合成 PDF、
打包成 zip（可选密码），上传到提出请求的会话，完成后回一张简介信息卡。

移植自 QQ Agent 技能 **jm-download v2.5.1**，按 QixinBot 的 `.anzu` 规范重写了编排层
（指令、队列、上传、定时）——下载引擎、竖切还原、ZIP、信息图渲染原样复用。

---

## 功能

| 功能 | 说明 |
|---|---|
| 异步排队 | 一次一个 ID 进有序队列；单 worker 一本一本跑，跟消息处理解耦；重启后从 `queue.json` 接着跑 |
| 多章节 / 长篇 | 按章取图、并发可调、每话页数上限；超长本按页分卷成多个**能单独打开**的 PDF |
| 竖切还原 | 按站点返回的 `scramble_id` 还原（需要 Python + Pillow），逐章对齐，不串图 |
| PDF + ZIP | PDF 合成后可选打 zip（ZipCrypto，Windows 双击可解压）；密码可写进文件名 |
| 上传 | 群文件 / 私聊文件，按单文件上限自动分卷；压缩包超限整包试一次，不按字节切 |
| 简介信息卡 | 封面 + 标题 + JM 编号徽章 + 作者/标签/规模 + 简介，Pillow 渲染 |
| 今日JM | 本地书架信息图（封面网格 + 编号徽章），删掉的本子自动消失 |
| 更新JM | 站点当日新上架/新章节信息图；采集器每 30 分钟抓一次，跨天自动清空重来 |
| 按群开关 | 「开启JM / 关闭JM / JM群列表 / JM所有群开放」，白名单模式（私聊不受限） |
| 成品复用 | 同 ID 12 小时内命中 PDF 直接重发；本地已有（PDF 或原图）可直接发 |
| 自动清理 | 本地按天数清理；群文件到期删除（需额外权限，见下） |
| 繁→简 / 日译 | 内置常用繁简表；日文标题走 `llm.chat` 能力翻译并缓存（没配 LLM 自动跳过） |

---

## 安装

```powershell
# 已签名包（官方仓库）
copy packages\jm-download.anzu <框架目录>\plugins\
# 或控制台「插件」页上传；装好默认未启用，去启用
```

## 用法

群里直接说（不需要前缀；带 `/` 也行）：

| 你说的 | 效果 |
|---|---|
| `jm123456` / `JM-123456` / `https://18comic.vip/album/123456/...` | 秒回「已排队」→ 后台下载 → 还原 → PDF → zip → 上传 → 汇报 |
| `@机器人 123456` | 同上（群里必须是 @ 了的纯数字；私聊可直接发数字） |
| `暂停下载 JM123` / `继续下载 JM123` | 暂停 / 恢复；暂停时已下好的图保留 |
| `删除JM123` | 终止任务 + 删本地目录 + 尽量删已上传的群文件 |
| `今日JM` / `JM列表` | 本地书架信息图 |
| `更新JM` / `今日更新` | 站点当日更新信息图 |
| `下好了吗` | 排队/进行中的任务 + 最近 5 条记录 |
| `本地收藏` | 文字版收藏列表 |
| `支持PDF吗` / `存储状态` | Pillow/PDF 能力、磁盘占用、上传设置、（群里）群文件配额 |
| `开启JM` / `关闭JM` | 按群开关（群主/管理员/白名单 QQ） |
| `JM群列表` / `JM所有群开放` | 看名单 / 取消白名单 |

给 AI 用的工具（`[[tools]]`）：`jm_download`、`jm_control`、`jm_task_status`、
`jm_today_list`、`jm_daily_updates`、`jm_group_toggle`、`jm_library`、`jm_storage`。
工具会把结果**自己发到会话**，AI 只需要简短回应，避免复述两遍。

---

## 设置（控制台 → 插件 → 禁漫下载）

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用下载功能 | 开 | 关掉后下载/进度/收藏/自检不可用；群开关仍可用 |
| 输出格式 | `pdf` | `images` = 只存原图、零依赖、不上传 PDF |
| 还原竖切打乱 | 开 | 需要 Python+Pillow；关掉最快但新本子是乱的 |
| 合成 PDF 后删除原图 | 关 | 省磁盘；PDF 失败时自动保留原图 |
| PDF 画质 / 单页最长边 | 85 / 0 | 调低可显著减小体积 |
| 0/1/2/3 压缩包四项 | 开/关/空/开 | 是否打 zip、是否加密、密码、密码是否写进文件名 |
| 文件上传到哪 | `request` | 提出请求的会话 / 只群 / 只私聊 / 不上传 |
| 单文件上限 / 超限拒绝 | 600 MB / 关 | 关 = 自动分卷（PDF 按页分卷；zip 不切） |
| 上传前检查配额 | 开 | 查配额需要 `onebot.admin`（见下） |
| 允许触发的 QQ | 空 | 留空=所有人；填了只有管理员/群主/名单内能触发 |
| 成品缓存 / 本地复用 | 12 小时 / 30 天 | 同一个 ID 直接重发，不重新下载；0 = 关闭 |
| 本地保留天数 / 群文件保留天数 | 7 / 0 | 每 6 小时检查；0 = 不清理 |
| 每话最多页数 / 多章节 / 并发 | 500 / 开 / 4 | 防超长本打爆磁盘 |
| 单次请求超时 / 报进度 | 30 秒 / 开 | 网络慢可调大；报进度 12 秒一条 |
| 日文标题翻译 / 翻译模型 | 开 / 空 | 走 `llm.chat`；模型留空用 llm 默认 |
| Python 解释器路径 | 空 | 留空自动探测（`py` → `python` → 常见安装位置） |
| 下载走代理 | 空 | 如 `http://127.0.0.1:7890`，需要环境里有 undici |
| 备用站点域名 | 空 | 一行/逗号一个，填了优先 |
| 下载目录 | 空 | 留空用插件 `data/`；填绝对路径也行 |

### 关于 `onebot.admin`

插件只申请了 `onebot.write`（发消息、上传文件）。**查群文件配额、到期删除群文件、
删除JM 时清理群文件**这三个动作在框架里属于 `admin` 级，需要管理员在
`manifest.toml` 的 `permissions` 里额外加 `onebot.admin` 才生效。

没加时：上传前预检自动跳过（不影响上传）、群文件到期删除记一条日志、
`删除JM` 只清本地文件并在结果里说明。功能不会报错，只是这几项不生效。

---

## 依赖

| 依赖 | 作用 | 缺了会怎样 |
|---|---|---|
| Node ≥ 18 | 运行时（用内置 `fetch`） | 跑不起来 |
| Python 3 + Pillow | 竖切还原、PDF、信息图 | 降级为「原样保存图片」；不发信息卡/信息图，改发文字 |
| `llm.chat` 能力（ai-llm 插件） | 日文标题翻译 | 只做繁→简，标题保留日文 |
| 中文字体 | 信息图里的中文/数字 | 缺字体时渲染失败 → 自动降级文字版 |

Pillow 可以装系统里，也可以塞进插件的 `deps/python`（框架会把 `deps/python`
加进 `PYTHONPATH`，不用动系统环境）：

```powershell
# 目标机器上执行；Pillow 的 wheel 是平台相关的，Windows 装出来的不能拷到 Linux
pip install --target <插件运行区>\deps\python Pillow
```

Python 解释器优先级：插件设置 `pythonPath` → 框架「运行时环境」的 `QIXIN_PYTHON`
→ `py` 启动器 → PATH 的 `python` → 常见安装位置。**不要写死 `C:\Python3xx`**。

### 运行时环境（框架注入，不用自己猜路径）

| 变量 | 这个插件怎么用 |
|---|---|
| `QIXIN_DATA_DIR` | 插件数据根目录（**绝对路径**）；优先用它，`initialize` 的 `data_dir` 也认 |
| `QIXIN_PYTHON` | 控制台「运行时环境」配的 Python；`findPython` 在插件设置之后优先用它 |
| `QIXIN_PLUGIN_DIR` / `QIXIN_PLUGIN_ID` | 只写进启动日志，方便排查"到底加载的哪个运行区" |
| `QIXIN_EXPERIMENTAL` | 只写日志。本插件不依赖框架定时（发行版/开发线都用自己的 `setInterval`） |

启动日志里会有一行 `运行环境`，直接显示 `dataDir` / `python` 来源，排障先看它。

---

## 数据目录（升级不丢）

```
data/plugins/jm-download/data/
├── jm-<ID>/<ID>-<本子名>/       原图 / PDF / zip / metadata.json
├── queue.json                   没跑完的队列（重启续跑）
├── tasks.json                   最近 50 条任务记录
├── daily_updates.json           更新JM 当日采集（含 3 天归档）
├── daily-covers/<ID>.jpg        更新清单封面缓存
├── enabled-groups.json          群白名单（开启JM 后出现）
├── uploaded-files.json          已上传群文件（到期清理 / 删除JM 用）
├── jp-cache.json                日文标题翻译缓存
├── album-card.jpg / daily-digest.jpg / today-list.jpg   最近渲染的图
└── settings.json                框架保存的设置
```

---

## 开发与自检

```powershell
# 离线自检（不联网）：ID 归一化 / 加解密 / 网页解析 / 竖切用例 /
#                   ZIP 加密可解压 / 两张信息图 / PDF 合成与分卷
node app/selftest.mjs

# 起本地环境（假 OneBot + 控制台 7801）
..\..\..\bin\qixinpack.exe dev . -watch

# 打包（官方密钥）
..\..\..\bin\qixinpack.exe pack . -key ..\..\..\plugin-signing.priv -out ..\..\packages\jm-download.anzu
```

### 本地测试的两个已知限制

1. **mock-onebot 的 WebSocket 读上限是 32 KB**：往会话里发图片（base64 后更大）
   会把连接顶掉，报 `StatusMessageTooBig`。真协议端没有这个限制，所以
   「信息卡/信息图发不出去」在 dev 环境里是正常现象；看渲染效果请直接打开
   `data/album-card.jpg`。
2. **`/api/chat/inject` 会静音 3 秒**：注入之后 3 秒内后台任务发出的消息会被丢掉。
   测后台链路（下载完成后的汇报）请用 mock 的 `/push`，别用 inject。

---

## 与旧 skill 的差异（移植说明）

| 旧实现（QQ Agent） | 现在（QixinBot） |
|---|---|
| `skill.json` + `hooks` 把固定指令改写成「让模型调工具」 | 直接在 `handle_message` 里处理，秒回、不烧 token |
| `api.registerTool`（8 个工具） | manifest `[[tools]]`，`call_tool` 分发 |
| `api.config()` 读 skill 设置 | `[[settings]]` + `initialize/set_settings`，键名保持一致 |
| 自己读全局 `config.json` 调模型翻译 | `host.capability('llm.chat')`（没配就跳过） |
| `onebot` 来自钩子 ctx | `host.callOnebot`（`upload_group_file` / `upload_private_file` 等） |
| cron 跑 `daily_updates.mjs` | 插件内 `setInterval`（发行版没有框架调度），跨天自动清零 |
| `process.cwd()` 推 `resources/app/data` | 运行区固定 `<插件>/data`，可用设置改下载目录 |
| OpenCC npm 包 | 内置常用繁简表（不打包依赖） |
