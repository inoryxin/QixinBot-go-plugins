# 服务器状态（status）

CPU / 内存 / 磁盘 / 运行时长，支持 /status 和 /状态

## 基本信息

| 项 | 值 |
|---|---|
| 版本 | v1.0.0 |
| 语言 | Node.js |
| 权限 | 无 |
| 观察全量消息 | 否 |
| 提供能力 | 无 |

## 安装

把 `packages/status.anzu` 丢进框架的 `plugins/` 目录（或从[插件商店](https://github.com/inoryxin/QixinBot-go-plugins#插件商店)下载），
去控制台「插件」页启用。依赖说明见仓库 README。

## 开发调试

在本目录改代码后，用 `qixinpack dev`（假协议端 + 热重载）验证；详见仓库 README「创建一个插件」。
