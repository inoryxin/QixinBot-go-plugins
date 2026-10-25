# 表情包（ai-sticker）

给 AI 聊天配表情包：

- 每张表情带 **情绪** + **使用场景** 标签
- AI 回复按概率挑一张合适的图（`ai-chat` 的 `sticker_pct`，默认 25%）
- 后台 `/plugin/ai-sticker/` 上传、打标签、删除
- 可接远程表情库（远程优先，失败回退本地）
- 自动偷表情包：**复用 ai-chat 主对话那一次 LLM 调用**——图片本来就发给模型了，让它在回复末尾顺手带一行标签，不再单独调视觉模型

## 远程库协议

配置 `remote_url`（默认 `https://home.inory.xin:13000`）、`remote_user`、`remote_pass`，使用 HTTP Basic Auth。

约定接口（可自行适配服务端）：

```
GET  /api/stickers/pick?emotion=开心&context=打招呼
     -> {"ok":true,"sticker":{"data_url":"..."}}  或 {"url":"https://..."}

POST /api/stickers
     {"data_url":"data:image/png;base64,...","emotion":"开心","contexts":["打招呼"],"source":"steal"}
     -> 2xx 表示入库成功
```

远程开启且 `remote_takeover=true` 时：取图先走远程；收藏/上传优先远程，远程失败才存本地。

## 偷图

- 私聊：每条消息 AI 都会看图，主调用顺手返回标签，是表情包就收藏
- 群聊：不单独掷骰子；只有 ai-chat 决定"水群"这条消息时，主调用带的标签才会入库
- 判断提示词要求模型输出 `is_sticker/emotion/contexts`；不是表情包就丢弃
- 同一张图按 SHA1 去重

## 设置

| key | 说明 |
|---|---|
| remote_enabled | 启用远程库 |
| remote_url / remote_user / remote_pass | 远程库连接 |
| remote_takeover | 远程优先、本地兜底 |
