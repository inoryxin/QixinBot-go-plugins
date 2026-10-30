# B站订阅（bilibili）

开播、视频、图文动态推送；支持二维码登录和 UP 主订阅

## 基本信息

| 项 | 值 |
|---|---|
| 版本 | v1.0.0 |
| 语言 | Node.js |
| 权限 | onebot.write |
| 观察全量消息 | 否 |
| 提供能力 | bili.sub.list@1、bili.sub.save@1、bili.qr.start@1、bili.qr.poll@1、bili.nav@1、bili.block.get@1、bili.block.save@1 |

## 安装

把 `packages/bilibili.anzu` 丢进框架的 `plugins/` 目录（或从[插件商店](https://github.com/inoryxin/QixinBot-go-plugins#插件商店)下载），
去控制台「插件」页启用。依赖说明见仓库 README。

## 开发调试

在本目录改代码后，用 `qixinpack dev`（假协议端 + 热重载）验证；详见仓库 README「创建一个插件」。
