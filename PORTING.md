# 移植清单：旧版 QixinBot-plugins → 新版框架

旧仓库（Node 版）：<http://10.0.0.140:30008/anzu/QixinBot-plugins>
新仓库（本仓库）：<http://10.0.0.140:30008/anzu/QixinBot-go-plugins>

## 为什么要重写而不是搬家

旧插件的 `plugin.js` **直接 require 旧框架内部模块**（28 个插件里 26 个都引了）：

| 旧模块 | 被引用 | 新框架里的替代 |
|---|---|---|
| `src/tool-registry` | 20 次 | `[[tools]]` + `host.callTool`（框架统一注册） |
| `src/services` | 9 次 | `[[requires]]` / `provides` 能力系统 |
| `src/config-store` | 7 次 | `host.storage.*` / `db.sqlite` |
| `src/deepseek` | 3 次 | `llm.chat` 能力（插件 `llm` 提供） |
| `src/status-page` | 2 次 | WebUI 的页面注册 |
| `src/template` 等 | 各 1 次 | 插件自带 / Node 内置模块 |

**结论**：每个插件都要按新 API 重写业务逻辑，但**算法、文案、素材、接口地址可以直接搬**。
`entry` 从 `plugin.js` 变成 `app/index.js`，manifest 从 JSON 变成 TOML。

## 进度

| 插件 | 状态 | 说明 |
|---|---|---|
| bilibili | ✅ 已移植 | 开播/视频/动态推送 |
| cngal | ✅ 已移植 | 国 G 周报长图 |
| echo | ✅ 已移植 | 最小示例 |
| fortune | ✅ 已移植 | 运势抽签（图片） |
| home-assistant | ✅ 已移植 | 米家开关 |
| trigger | ✅ 已移植 | 关键词 → HTTP |
| ts3-tracker | ✅ 已移植 | TS3 在线 |
| what2eat | ✅ 已移植 | 今天吃什么 |
| **status** | ✅ **本轮移植** | 服务器状态（CPU/内存/磁盘/运行时长） |
| **ncm-saying** | ✅ **本轮移植** | 网易云热评 + 每日定时 |
| customemote | ⬜ 待移植 | 图片存名字，发名字发表情（storage + 图片消息） |
| emojimix | ⬜ 待移植 | Emoji Kitchen 合成（一个 Google 接口） |
| qq-profile | ⬜ 待移植 | 改昵称/签名/头像（`host.call_onebot`） |
| affinity | ⬜ 待移植 | 好感度（`db.sqlite`，给 ai-chat 用） |
| voice | ⬜ 待移植 | 文字转语音（Windows SAPI，跨平台要换 TTS） |
| music | ⬜ 待移植 | 点歌（网易云/QQ 音乐接口） |
| rollpig | ⬜ 待移植 | 抽小猪（pighub.top 接口） |
| whale-memes | ⬜ 待移植 | 梗鲸表情包（gallery-index.json） |
| meme-scout | ⬜ 待移植 | 萌娘百科检索 |
| anime-trace | ⬜ 待移植 | 以图识番（animetrace API） |
| memes | ⬜ 待移植 | 沙雕表情包生成 |
| pc-status | ⬜ 待移植 | 电脑状态 + 截图（截图要框架新能力） |
| blog | ⬜ 待移植 | Typecho 发博客（自家服务） |
| sleep-guard | ⬜ 待移植 | 催睡（自家服务 + 定时） |
| watch | ⬜ 待移植 | 视奸祈歆（自家服务） |
| tieba-persona | ⬜ 待移植 | 贴吧人格（storage + 文本） |
| travel-frog | ⬜ 待移植 | 旅行青蛙（状态机 + 定时） |
| forward-relay | ⬜ 待移植 | 合并转发搬运（forward API） |
| knowledge | ⬜ 待移植 | 知识库（**只做关键词匹配**，不做向量检索） |
| reload | ❌ 不移植 | 框架自带热重载，重复了 |
| jm | ❌ 暂不移植 | 已知 bug 未修 |

## 移植顺序和理由

**第一批：自包含、无外部依赖**（最快见效）

```
status ✅  ncm-saying ✅  customemote  emojimix  qq-profile  affinity  voice
```

这些只需要 Node 内置模块、`storage`、`call_onebot` 或一个公开接口。

**第二批：依赖外部站点/素材**

```
music  rollpig  whale-memes  meme-scout  anime-trace  memes  pc-status
```

风险在**接口稳定性**（aa1.cn、pighub、萌娘百科都可能挂），
所以每个都要有兜底文案，不能接口挂了就沉默。

**第三批：依赖自家服务或复杂状态**

```
blog  sleep-guard  watch  tieba-persona  travel-frog  forward-relay  knowledge
```

`home.inory.xin` 这几个依赖你自己的服务，移植前得先确认那些接口还在。

## 移植一个插件要改什么

| 旧 | 新 |
|---|---|
| `manifest.json` | `manifest.toml`（`id` / `commands` / `settings` / `schedule`） |
| `module.exports = { setup, execute }` | `serve({ initialize, handle_message, run_task })` |
| `session.reply(text)` | `host.reply(chatOf(session), text)` |
| `context.client.call('send_group_msg', …)` | `host.call_onebot('send_group_msg', …)` |
| `readJson/writeJsonAtomic` | `host.storage_get/set` 或 `db.sqlite` |
| `registerTool` | manifest 的 `[[tools]]` |
| 自己起 `setInterval` 做定时 | `[[schedule]]`（框架持久化，重启不丢） |
| `'../src/services'` 调别的插件 | `host.capability('xxx', args)` |

**一句话**：业务逻辑照抄，胶水层换成新 SDK。
