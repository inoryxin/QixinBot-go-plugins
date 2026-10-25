# QQ 资料（qq-profile）

移植自旧 bot 的 qq-profile。

- 改机器人 QQ 昵称、签名、头像
- 发 QQ 空间说说，支持文字 + 图片
- 可选自动发伤感说说：每隔 2~4 天，在活跃时段用 AI 生成一条
- 所有操作默认主人 QQ 才能触发

## 命令

```
改昵称 <名字>
改名 <名字>
改签名 <文本>
签名 <文本>
改头像            # 附带一张图片
换头像
发说说 <文本>     # 可附图
说说
```

## 工具

`set_qq_nickname`、`set_qq_signature`、`set_qq_avatar`、`post_qzone`、`qzone_auto_status`

## 权限

需要 `onebot.admin`（改资料/头像）和 `onebot.dangerous`（发 QQ 空间）。
