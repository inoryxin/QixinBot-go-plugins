# 她的生活（ai-life）

模拟一个人一天在干什么，给 AI 聊天提供当前状态（在上班/在吃饭/困了）

## 基本信息

| 项 | 值 |
|---|---|
| 版本 | v1.0.0 |
| 语言 | Node.js |
| 权限 | 无 |
| 观察全量消息 | 否 |
| 提供能力 | life.now@1、life.set@1、life.plan@1 |

## 安装

把 `packages/ai-life.anzu` 丢进框架的 `plugins/` 目录（或从[插件商店](https://github.com/inoryxin/QixinBot-go-plugins#插件商店)下载），
去控制台「插件」页启用。依赖说明见仓库 README。

## 开发调试

在本目录改代码后，用 `qixinpack dev`（假协议端 + 热重载）验证；详见仓库 README「创建一个插件」。
